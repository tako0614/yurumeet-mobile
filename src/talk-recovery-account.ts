import { mobileAccountIdentity, normalizeHostUrl, type MobileAccountList, type MobileAccountSummary,
  type MobileSecureStore, type MobileSession } from "@takosjp/mobile-kit";
import { createTalkRecoveryStore, TalkRecoveryError, type TalkRecoveryScope } from "./talk-recovery.ts";

type Account = Pick<MobileAccountSummary, "id" | "hostUrl" | "product">;
type Entry = readonly [string, string];
interface AccountState {
  readonly store: MobileSecureStore;
  active: () => void;
  retire: () => Promise<void>;
}
const accounts = new WeakMap<MobileSecureStore, Map<string, AccountState>>();
const maxEnvelopeBytes = 4 * 1024 * 1024;
const scopeKey = /^yurumeet:talk-recovery:v1:[a-f0-9]{64}$/u;

function bounded(value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length > limit || new TextEncoder().encode(value).byteLength > limit) {
    throw new TalkRecoveryError("invalid-data");
  }
}

function identity(account: Account) {
  try {
    if (account.product !== "yurume" || typeof account.id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(account.id) ||
      typeof account.hostUrl !== "string" || account.hostUrl.length > 2048 || /[\u0000-\u0020\u007f]/u.test(account.hostUrl)) throw new Error();
    const host = normalizeHostUrl(account.hostUrl), parsed = new URL(account.hostUrl);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
    return { host, value: JSON.stringify([account.product, host, account.id]) };
  } catch { throw new TalkRecoveryError("invalid-scope"); }
}

function decode(raw: string | undefined, owner: string): Entry[] {
  if (raw === undefined) return [];
  try {
    bounded(raw, maxEnvelopeBytes);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "owner", "entries"].includes(key))) throw new Error();
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || data.owner !== owner || !Array.isArray(data.entries) || data.entries.length > 32) throw new Error();
    const seen = new Set<string>();
    return data.entries.map(item => {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !scopeKey.test(item[0]) || seen.has(item[0])) throw new Error();
      bounded(item[1], 1024 * 1024);
      seen.add(item[0]);
      return [item[0], item[1]];
    });
  } catch { throw new TalkRecoveryError("invalid-data"); }
}

/** Encrypted row namespace only; account metadata grants no server authority. */
export function createTalkRecoveryAccounts(options: { store?: MobileSecureStore }) {
  const selectedStore = options.store;
  if (!selectedStore || selectedStore.kind !== "secure" || typeof selectedStore.get !== "function" || typeof selectedStore.set !== "function" || typeof selectedStore.delete !== "function") {
    throw new TalkRecoveryError("secure-store-unavailable");
  }
  const store: MobileSecureStore = selectedStore;
  const shared = accounts.get(store) ?? new Map<string, AccountState>();
  accounts.set(store, shared);
  function accountState(value: string): AccountState {
    const previous = shared.get(value);
    if (previous) return previous;
    let tail = Promise.resolve(), key: Promise<string> | undefined;
    let retired = false, retirement: Promise<void> | undefined;
    function active() { if (retired) throw new TalkRecoveryError("retired"); }
    function queued<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work);
      tail = next.then(() => {}, () => {});
      return next;
    }
    function storageKey(): Promise<string> {
      key ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(bytes =>
        "yurumeet:talk-recovery-account:v1:" + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
      cause => { key = undefined; throw cause; });
      return key;
    }
    const adapter: MobileSecureStore = {
      kind: "secure",
      get: name => queued(async () => {
        active();
        const owner = await storageKey();
        active();
        const raw = await store.get(owner);
        active();
        return decode(raw, owner).find(([key]) => key === name)?.[1];
      }),
      set: (name, raw) => queued(async () => {
        active();
        if (!scopeKey.test(name)) throw new TalkRecoveryError("invalid-data");
        bounded(raw, 1024 * 1024);
        const owner = await storageKey();
        active();
        const previous = await store.get(owner);
        active();
        const entries = decode(previous, owner).filter(([key]) => key !== name);
        if (entries.length >= 32) throw new TalkRecoveryError("invalid-data");
        entries.push([name, raw]);
        const encoded = JSON.stringify({ version: 1, owner, entries });
        bounded(encoded, maxEnvelopeBytes);
        await store.set(owner, encoded);
        active();
      }),
      delete: name => queued(async () => {
        active();
        const owner = await storageKey();
        active();
        const previous = await store.get(owner);
        active();
        const entries = decode(previous, owner).filter(([key]) => key !== name);
        if (!entries.length) await store.delete(owner);
        else await store.set(owner, JSON.stringify({ version: 1, owner, entries }));
        active();
      }),
    };
    function retire() {
      retired = true;
      retirement ??= queued(async () => {
        try { await store.delete(await storageKey()); }
        catch (cause) { throw new TalkRecoveryError("storage", { cause }); }
      }).catch(cause => { retirement = undefined; throw cause; });
      return retirement;
    }
    const result = { store: adapter, active, retire };
    shared.set(value, result);
    return result;
  }
  function bind(account: Account, scope: TalkRecoveryScope) {
    const selected = identity(account);
    if (scope.product !== "yurume" || normalizeHostUrl(scope.hostUrl) !== selected.host) throw new TalkRecoveryError("invalid-scope");
    const state = accountState(selected.value);
    state.active();
    return createTalkRecoveryStore({ store: state.store, scope });
  }
  return {
    bind,
    select(input: { accounts: MobileAccountList; session: MobileSession; actorApId: string }) {
      const rows = input.accounts.accounts.filter(row => row.id === input.accounts.activeId);
      if (input.session.product !== "yurume" || rows.length !== 1 || rows[0].product !== "yurume" ||
        mobileAccountIdentity(rows[0]) !== mobileAccountIdentity(input.session)) throw new TalkRecoveryError("invalid-scope");
      return bind(rows[0], { product: "yurume", hostUrl: input.session.hostUrl, actorApId: input.actorApId,
        ...(input.session.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.session.apiBaseUrl }) });
    },
    retire: (account: Account) => accountState(identity(account).value).retire(),
  };
}
