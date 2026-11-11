import { MobileApiError, type WireDecoder } from "@takosjp/mobile-kit";
import type { TalkRecoveryAttachment } from "./talk-recovery.ts";

export interface TalkMessageAttachment {
  readonly type: "Document";
  readonly mediaType: string;
  readonly url: string;
  readonly r2_key: string;
  readonly name: string;
}
export interface TalkUpload {
  readonly attachment: TalkMessageAttachment;
  readonly expiresAt: string;
}
export interface TalkDraftAttachment {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly phase: "queued" | "uploading" | "ready" | "failed" | "unknown" | "expired";
  readonly attachment?: TalkMessageAttachment;
  readonly error?: string;
  readonly canRetry: boolean;
}

const extensions: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm",
};
const maxFiles = 8;
const filename = (file: Pick<File, "name">) => (file.name.trim() || "添付ファイル").slice(0, 512);
function selectionError(file: Pick<File, "name" | "type" | "size">): string | undefined {
  if (!Object.hasOwn(extensions, file.type)) return "JPEG・PNG・GIF・WebPの画像、MP4・WebMの動画を選んでください。";
  if (file.size === 0) return "空のファイルは添付できません。";
  if (file.size > (file.type.startsWith("video/") ? 40 : 20) * 1024 * 1024) return "画像は20MiB、動画は40MiBまで添付できます。";
}

/** Structural reference validation only; this does not assert freshness or authorize a send. */
export function decodeTalkUploadReference(file: Pick<File, "name" | "type">, value: unknown): TalkUpload {
  const name = filename(file), mime = file.type, extension = Object.hasOwn(extensions, mime) ? extensions[mime] : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Upload response is not an object");
  const data = value as Record<string, unknown>;
  if (typeof data.id !== "string" || !/^[a-f0-9]{1,128}$/u.test(data.id) || !extension || data.content_type !== mime ||
    data.url !== `/media/${data.id}.${extension}` || data.r2_key !== `uploads/${data.id}.${extension}` ||
    typeof data.expires_at !== "string" || !Number.isFinite(Date.parse(data.expires_at))) {
    throw new Error("Upload acknowledgment does not match the selected file and canonical media reference");
  }
  return { attachment: { type: "Document", mediaType: mime, url: `/media/${data.id}.${extension}`, r2_key: `uploads/${data.id}.${extension}`, name },
    expiresAt: data.expires_at };
}

export function talkUploadResponse(file: File): WireDecoder<TalkUpload> {
  const selected = { name: filename(file), type: file.type };
  return { document: "Yurumeet selected file upload", decode(value) {
    const upload = decodeTalkUploadReference(selected, value);
    if (Date.parse(upload.expiresAt) <= Date.now()) {
      throw new Error("Upload acknowledgment does not match the selected file and canonical media reference");
    }
    return upload;
  } };
}

interface Item {
  id: number;
  file: Pick<File, "name" | "type" | "size">;
  missingFile?: boolean;
  phase: "queued" | "uploading" | "ready" | "failed" | "unknown";
  upload?: TalkUpload;
  error?: string;
}

/** File memory and uploads belong to the original conversation/account. */
export function createTalkAttachmentDraft(options: {
  active: () => boolean;
  upload: (file: File, signal: AbortSignal) => Promise<TalkUpload>;
  onChange: () => void;
}) {
  let items: Item[] = [], sequence = 0, error = "", disposed = false;
  let flight: { item: Item; abort: AbortController } | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && options.active();
  const expired = (item: Item) => !!item.upload?.expiresAt && Date.parse(item.upload.expiresAt) <= Date.now();
  function notify() {
    clearTimeout(expiryTimer); expiryTimer = undefined;
    if (!active()) return;
    const future = items.flatMap(item => item.phase === "ready" && item.upload?.expiresAt && !expired(item) ? [Date.parse(item.upload.expiresAt)] : []);
    if (future.length) expiryTimer = setTimeout(notify, Math.min(2_147_483_647, Math.max(1, Math.min(...future) - Date.now())));
    options.onChange();
  }
  function state() {
    return { error, canAdd: items.length < maxFiles, items: items.map((item): TalkDraftAttachment => ({
      id: item.id, name: filename(item.file), size: item.file.size, phase: expired(item) ? "expired" : item.phase,
      ...(item.upload ? { attachment: item.upload.attachment } : {}),
      error: expired(item) ? "添付の期限が切れました。もう一度準備してください。" : item.error,
      canRetry: !item.missingFile && !selectionError(item.file) && (expired(item) || item.phase === "failed" || item.phase === "unknown"),
    })) };
  }
  function snapshot() {
    if (items.some(item => item.phase !== "ready" || !item.upload || expired(item))) return undefined;
    return { ids: items.map(item => item.id), attachments: items.map(item => ({ ...item.upload!.attachment })) };
  }
  function recoverySnapshot(): TalkRecoveryAttachment[] {
    return items.map(item => item.phase === "ready" && item.upload
      ? { phase: "ready", upload: item.upload }
      : { phase: "needs-reselection", name: filename(item.file), mediaType: item.file.type, size: item.file.size,
        reason: item.phase === "unknown" ? "unknown" : "unavailable" });
  }
  function restore(attachments: readonly TalkRecoveryAttachment[]) {
    if (!active() || items.length) return;
    items = attachments.map(item => item.phase === "ready"
      ? { id: ++sequence, file: { name: item.upload.attachment.name, type: item.upload.attachment.mediaType, size: 0 },
        missingFile: true, phase: "ready", upload: item.upload }
      : { id: ++sequence, file: { name: item.name, type: item.mediaType, size: item.size ?? 0 },
        missingFile: true, phase: "failed", error: "元のファイルをもう一度選んでください。" });
    notify();
  }
  function pump() {
    if (!active() || flight) return;
    const item = items.find(candidate => candidate.phase === "queued");
    if (!item) return;
    const current = { item, abort: new AbortController() }; flight = current; item.phase = "uploading"; notify();
    void (async () => {
      try {
        if (!(item.file instanceof File)) throw new Error("元のファイルをもう一度選んでください。");
        const upload = await options.upload(item.file, current.abort.signal);
        if (!active() || flight !== current || !items.includes(item)) return;
        item.upload = upload; item.phase = "ready"; item.error = undefined;
      } catch (cause) {
        if (!active() || flight !== current || !items.includes(item)) return;
        const definite = cause instanceof MobileApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408;
        item.phase = definite ? "failed" : "unknown";
        item.error = definite ? `添付を準備できませんでした（${cause.status}）。ファイルと接続を確認してください。`
          : "添付の準備結果を確認できませんでした。メッセージは自動送信されません。再試行するか下書きから外してください。";
      } finally {
        if (flight === current) { flight = undefined; notify(); pump(); }
      }
    })();
  }
  function add(files: readonly File[]) {
    if (!active() || !files.length) return;
    if (items.length + files.length > maxFiles) { error = "添付は8件までです。今回の選択は追加されませんでした。"; notify(); return; }
    error = "";
    for (const file of files) {
      const error = selectionError(file);
      items.push({ id: ++sequence, file, phase: error ? "failed" : "queued", error });
    }
    notify(); pump();
  }
  function remove(id: number) {
    if (!active()) return;
    const item = items.find(candidate => candidate.id === id); if (!item) return;
    items = items.filter(candidate => candidate !== item); error = "";
    if (flight?.item === item) { const old = flight; flight = undefined; old.abort.abort(); }
    notify(); pump();
  }
  function retry(id: number) {
    if (!active()) return;
    const item = items.find(candidate => candidate.id === id);
    if (!item || item.missingFile || item.phase === "uploading" || item.phase === "queued" || (item.phase === "ready" && !expired(item))) return;
    const error = selectionError(item.file); item.upload = undefined; item.error = error; item.phase = error ? "failed" : "queued";
    notify(); pump();
  }
  function commit(ids: readonly number[]) { if (active()) { items = items.filter(item => !ids.includes(item.id)); notify(); } }
  function dispose() { disposed = true; clearTimeout(expiryTimer); expiryTimer = undefined; flight?.abort.abort(); flight = undefined; items = []; error = ""; }
  return { state, snapshot, recoverySnapshot, restore, add, remove, retry, commit, dispose };
}
