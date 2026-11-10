import { normalizeHostUrl, type MobileSecureStore } from "@takosjp/mobile-kit";
import { isTalkNotificationId } from "./talk-notification.ts";
import { decodeTalkUploadReference, type TalkUpload } from "./talk-attachments.ts";

const maxBytes = 1024 * 1024;
const lifetimeMs = 7 * 86400_000;

function bounded(raw: unknown): asserts raw is string {
  if (typeof raw !== "string" || raw.length > maxBytes || new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new TalkRecoveryError("invalid-data");
  }
}

const messages = {
  "secure-store-unavailable": "Secure recovery storage is unavailable.",
  "invalid-scope": "Invalid recovery scope.",
  "invalid-data": "Recovery data could not be verified.",
  expired: "Recovery data has expired; manual review is required.",
  storage: "Recovery storage did not confirm the operation.",
  retired: "This recovery scope has been retired.",
};

export class TalkRecoveryError extends Error {
  constructor(readonly code: keyof typeof messages, options?: ErrorOptions) {
    super(messages[code], options);
    this.name = "TalkRecoveryError";
  }
}

async function storageOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) { throw new TalkRecoveryError("storage", { cause }); }
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && keys.includes(key) && property.enumerable && Object.hasOwn(property, "value");
  });
}

function scopeIdentity(value: TalkRecoveryScope): string {
  try {
    if (!record(value, ["product", "hostUrl", "actorApId", "apiBaseUrl"]) || value.product !== "yurume" ||
      !isTalkNotificationId(value.actorApId) || typeof value.hostUrl !== "string" || value.hostUrl.length > 2048 ||
      /[\u0000-\u0020\u007f]/u.test(value.hostUrl)) throw new Error();
    const host = normalizeHostUrl(value.hostUrl), url = new URL(value.hostUrl);
    if (url.pathname !== "/" || url.search || url.hash) throw new Error();
    let apiBase: string | undefined;
    if (value.apiBaseUrl !== undefined) {
      if (typeof value.apiBaseUrl !== "string" || value.apiBaseUrl.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value.apiBaseUrl)) throw new Error();
      const api = new URL(value.apiBaseUrl);
      if (api.origin !== host || api.username || api.password || api.search || api.hash) throw new Error();
      apiBase = api.origin + api.pathname.replace(/\/+$/u, "");
    }
    return JSON.stringify([value.product, host, value.actorApId, apiBase]);
  } catch {
    throw new TalkRecoveryError("invalid-scope");
  }
}

/** Product recovery data; it never represents server authority or a send ACK. */
export interface TalkRecoveryScope {
  readonly product: "yurume";
  readonly hostUrl: string;
  readonly actorApId: string;
  readonly apiBaseUrl?: string;
}

export interface TalkRecoveryDraft {
  readonly contact: { readonly type: "user" | "community"; readonly apId: string };
  readonly content: string;
  readonly sendState: "draft" | "pending" | "uncertain";
  readonly attachments: readonly TalkRecoveryAttachment[];
}

export type TalkRecoveryAttachment =
  | { readonly phase: "ready"; readonly upload: TalkUpload }
  | { readonly phase: "needs-reselection"; readonly name: string; readonly mediaType: string;
      readonly size?: number; readonly reason: "unavailable" | "expired" | "unknown" };

function attachmentName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
}

function verifiedAttachments(value: unknown, time: number): TalkRecoveryAttachment[] {
  if (!Array.isArray(value) || value.length > 8) throw new TalkRecoveryError("invalid-data");
  return Array.from(value, item => {
    if (record(item, ["phase", "upload"]) && item.phase === "ready" && record(item.upload, ["attachment", "expiresAt"])) {
      const upload = item.upload, attachment = upload.attachment;
      if (!record(attachment, ["type", "mediaType", "url", "r2_key", "name"]) || attachment.type !== "Document" ||
        typeof attachment.url !== "string" || typeof attachment.mediaType !== "string" || !attachmentName(attachment.name)) throw new TalkRecoveryError("invalid-data");
      try {
        const id = /^\/media\/([a-f0-9]{1,128})\.[a-z0-9]+$/u.exec(attachment.url)?.[1];
        const parsed = decodeTalkUploadReference({ name: attachment.name, type: attachment.mediaType }, {
          id, content_type: attachment.mediaType, url: attachment.url, r2_key: attachment.r2_key, expires_at: upload.expiresAt,
        });
        return Date.parse(parsed.expiresAt) <= time
          ? { phase: "needs-reselection", name: parsed.attachment.name, mediaType: parsed.attachment.mediaType, reason: "expired" }
          : { phase: "ready", upload: parsed };
      } catch { throw new TalkRecoveryError("invalid-data"); }
    }
    if (record(item, ["phase", "name", "mediaType", "size", "reason"]) && item.phase === "needs-reselection" && attachmentName(item.name) &&
      typeof item.mediaType === "string" && item.mediaType.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(item.mediaType) &&
      (item.size === undefined || (Number.isSafeInteger(item.size) && (item.size as number) >= 0)) &&
      (item.reason === "unavailable" || item.reason === "expired" || item.reason === "unknown")) {
      return { phase: "needs-reselection", name: item.name, mediaType: item.mediaType,
        ...(item.size === undefined ? {} : { size: item.size as number }), reason: item.reason };
    }
    throw new TalkRecoveryError("invalid-data");
  });
}

function verifiedDrafts(value: unknown, time: number): TalkRecoveryDraft[] {
  if (!Array.isArray(value) || value.length > 100) throw new TalkRecoveryError("invalid-data");
  const result: TalkRecoveryDraft[] = [], contacts = new Set<string>();
  for (const item of value) {
    if (!record(item, ["contact", "content", "sendState", "attachments"]) ||
      !record(item.contact, ["type", "apId"]) || (item.contact.type !== "user" && item.contact.type !== "community") ||
      !isTalkNotificationId(item.contact.apId) || typeof item.content !== "string" || item.content.length > 2000 ||
      (item.sendState !== "draft" && item.sendState !== "pending" && item.sendState !== "uncertain") ||
      !Array.isArray(item.attachments) || (!item.content.trim() && !item.attachments.length)) {
      throw new TalkRecoveryError("invalid-data");
    }
    const contactKey = JSON.stringify([item.contact.type, item.contact.apId]);
    if (contacts.has(contactKey)) throw new TalkRecoveryError("invalid-data");
    contacts.add(contactKey);
    result.push({ contact: { type: item.contact.type, apId: item.contact.apId }, content: item.content,
      sendState: item.sendState, attachments: verifiedAttachments(item.attachments, time) });
  }
  return result;
}

interface RecoveryStoreState {
  tail: Promise<void>;
  scopes: Map<string, RecoveryScopeState>;
}
interface RecoveryScopeState {
  key?: Promise<string>;
  retired: boolean;
  purged: boolean;
  retirement?: Promise<void>;
}
const storeStates = new WeakMap<MobileSecureStore, RecoveryStoreState>();

/**
 * Product secure-store primitive, not yet a controller/OS recovery implementation.
 * Callers must share the bridge's store instance, fence auth epochs, and revalidate
 * contact/media freshness before any send. A stored snapshot is never a send ACK.
 */
export function createTalkRecoveryStore(options: {
  store?: MobileSecureStore;
  scope: TalkRecoveryScope;
  now?: () => number;
}) {
  const store = options.store;
  if (!store || store.kind !== "secure" || typeof store.get !== "function" ||
    typeof store.set !== "function" || typeof store.delete !== "function") {
    throw new TalkRecoveryError("secure-store-unavailable");
  }
  const scope = scopeIdentity(options.scope);
  const shared = storeStates.get(store) ?? { tail: Promise.resolve(), scopes: new Map<string, RecoveryScopeState>() };
  storeStates.set(store, shared);
  function queued<T>(work: () => Promise<T>): Promise<T> {
    const operation = shared.tail.then(work);
    shared.tail = operation.then(() => {}, () => {});
    return operation;
  }
  const now = options.now ?? (() => Date.now());
  function currentTime() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + lifetimeMs)) throw new TalkRecoveryError("invalid-data");
    return time;
  }
  let current = shared.scopes.get(scope);
  if (!current || (current.retired && current.purged)) {
    current = { retired: false, purged: false };
    shared.scopes.set(scope, current);
  }
  const owned = current;
  function storageKey(): Promise<string> {
    // Do not start an unsupported capability's promise before an operation owns it.
    if (!owned.key) {
      const generated = storageOperation(async () => {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
        return "yurumeet:talk-recovery:v1:" + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      });
      owned.key = generated.catch(cause => { owned.key = undefined; throw cause; });
    }
    return owned.key;
  }
  function live() {
    if (owned.retired || shared.scopes.get(scope) !== owned) throw new TalkRecoveryError("retired");
  }
  return {
    async save(drafts: readonly TalkRecoveryDraft[]) {
      live();
      const savedAt = currentTime(), expiresAt = savedAt + lifetimeMs;
      const snapshot = verifiedDrafts(drafts, savedAt);
      return queued(async () => {
        live();
        const key = await storageKey();
        live();
        const raw = JSON.stringify({ version: 1, scope: key, savedAt, expiresAt, drafts: snapshot });
        bounded(raw);
        if (currentTime() >= expiresAt) throw new TalkRecoveryError("expired");
        await storageOperation(() => store.set(key, raw));
        live();
      });
    },
    async load(): Promise<readonly TalkRecoveryDraft[] | null> {
      live();
      return queued(async () => {
        live();
        const key = await storageKey();
        live();
        const raw = await storageOperation(() => store.get(key));
        live();
        if (raw === undefined) return null;
        try {
          bounded(raw);
          const data: unknown = JSON.parse(raw);
          const time = currentTime();
          if (!record(data, ["version", "scope", "savedAt", "expiresAt", "drafts"]) || data.version !== 1 || data.scope !== key ||
            !Number.isSafeInteger(data.savedAt) || (data.savedAt as number) < 0 || !Number.isSafeInteger(data.expiresAt) ||
            data.expiresAt !== (data.savedAt as number) + lifetimeMs || (data.savedAt as number) > time) throw new Error();
          if (time >= (data.expiresAt as number)) throw new TalkRecoveryError("expired");
          return verifiedDrafts(data.drafts, time);
        } catch (cause) {
          if (cause instanceof TalkRecoveryError) throw cause;
          throw new TalkRecoveryError("invalid-data");
        }
      });
    },
    retire(): Promise<void> {
      owned.retired = true;
      if (!owned.retirement) {
        const removal = queued(async () => {
          const key = await storageKey();
          await storageOperation(() => store.delete(key));
          owned.purged = true;
          if (shared.scopes.get(scope) === owned) shared.scopes.delete(scope);
        });
        owned.retirement = removal.catch(cause => {
          owned.retirement = undefined;
          throw cause;
        });
      }
      return owned.retirement;
    },
  };
}
