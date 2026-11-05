import { resolveMobileApiUrl, type MobileSession } from "@takosjp/mobile-kit";
import type { ClientOptions } from "@tauri-apps/plugin-http";
import { talkSessionIdentity } from "./talk-session.ts";

export interface TalkMediaSource {
  readonly kind: "image" | "video" | "unavailable";
  readonly label: string;
  readonly url?: string;
  readonly contentType?: string;
  readonly authenticated?: boolean;
}
export interface TalkMediaState {
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly url?: string;
  readonly error?: string;
}

const images = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const videos = new Set(["video/mp4", "video/webm"]);
const localPath = /^\/media\/[a-f0-9]+\.(jpg|png|gif|webp|mp4|webm)$/u;
// Client buffering ceilings; the host remains authoritative about access and size.
const imageLimit = 20 * 1024 * 1024, videoLimit = 40 * 1024 * 1024;

/** Local uploads and inbound AP attachments use different public MIME fields. */
export function describeTalkMedia(value: unknown, hostUrl: string): readonly TalkMediaSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ kind: "unavailable", label: "添付ファイル" }];
  return value.map((item): TalkMediaSource => {
    const entry = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const label = typeof entry.name === "string" && entry.name.trim() ? entry.name : "添付ファイル";
    const unavailable: TalkMediaSource = { kind: "unavailable", label };
    const contentType = entry.content_type ?? entry.mediaType;
    if (typeof contentType !== "string" || (entry.content_type !== undefined && entry.mediaType !== undefined && entry.content_type !== entry.mediaType)) return unavailable;
    const kind = images.has(contentType) ? "image" : videos.has(contentType) ? "video" : undefined;
    if (!kind) return unavailable;
    let raw = entry.url;
    if (raw === undefined || raw === null || raw === "") {
      if (typeof entry.r2_key !== "string" || !/^uploads\/[a-f0-9]+\.(jpg|png|gif|webp|mp4|webm)$/u.test(entry.r2_key)) return unavailable;
      raw = `/media/${entry.r2_key.slice("uploads/".length)}`;
    }
    if (typeof raw !== "string" || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(raw) || raw.startsWith("//")) return unavailable;
    try {
      const host = new URL(hostUrl), url = new URL(raw, host.origin);
      if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === host.origin))) return unavailable;
      const authenticated = url.origin === host.origin;
      if (authenticated && (!localPath.test(url.pathname) || url.search)) return unavailable;
      return { kind, label, url: url.href, contentType, authenticated };
    } catch { return unavailable; }
  });
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(signal.reason ?? new Error("添付の読み込みを中止しました。")); };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(value => { signal.removeEventListener("abort", cancel); resolve(value); }, cause => { signal.removeEventListener("abort", cancel); reject(cause); });
    if (signal.aborted) cancel();
  });
}

/** Use the existing native fetch implementation; never redirect a session bearer. */
export async function loadTalkMediaBlob(session: MobileSession, source: TalkMediaSource, caller: AbortSignal): Promise<Blob> {
  const verified = describeTalkMedia([{ url: source.url, mediaType: source.contentType, name: source.label }], session.hostUrl)[0];
  if (!source.authenticated || !source.url || !verified.contentType || source.kind === "unavailable" || verified.kind !== source.kind || verified.url !== source.url || verified.authenticated !== source.authenticated) throw new Error("添付の接続先を確認できませんでした。");
  const owned = new AbortController(), cancel = () => owned.abort(caller.reason);
  caller.addEventListener("abort", cancel, { once: true });
  if (caller.aborted) cancel();
  const deadline = setTimeout(() => owned.abort(new Error("添付の読み込みがタイムアウトしました。")), 15_000);
  try {
    if (owned.signal.aborted) throw owned.signal.reason;
    const headers = new Headers({ accept: verified.contentType, authorization: `${session.tokenType} ${session.accessToken}` });
    const url = resolveMobileApiUrl(session, new URL(source.url).pathname);
    // plugin-http reads its own option rather than RequestInit.redirect.
    const init: RequestInit & Pick<ClientOptions, "maxRedirections"> = { method: "GET", headers, credentials: "omit", redirect: "error", maxRedirections: 0, cache: "no-store", referrerPolicy: "no-referrer", signal: owned.signal };
    const request = globalThis.fetch(url, init);
    // Some native implementations finish a read after cancellation. Drop those bytes.
    void request.then(response => { if (owned.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await untilAbort(request, owned.signal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`添付を読み込めませんでした（${response.status}）。`); }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const length = response.headers.get("content-length"), maximum = source.kind === "video" ? videoLimit : imageLimit;
    if (type !== source.contentType || !response.body || (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum))) {
      void response.body?.cancel().catch(() => {}); throw new Error("添付の形式またはサイズを確認できませんでした。");
    }
    const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await untilAbort(reader.read(), owned.signal);
        if (done) break;
        total += value.byteLength;
        if (total > maximum) throw new Error("添付がアプリで読み込めるサイズを超えています。");
        chunks.push(new Uint8Array(value));
      }
      if (!total) throw new Error("添付の内容が空でした。");
      return new Blob(chunks, { type });
    } catch (cause) { void reader.cancel().catch(() => {}); throw cause; }
    finally { reader.releaseLock(); }
  } finally { clearTimeout(deadline); caller.removeEventListener("abort", cancel); }
}

function snapshot(session: MobileSession): MobileSession {
  return { ...session, productEndpoints: session.productEndpoints ? { ...session.productEndpoints } : undefined };
}

/** An attachment view owns its pending read and blob URL within one account. */
export function createTalkMediaController(options: { session: MobileSession; source: TalkMediaSource; onChange?: (state: TalkMediaState) => void }) {
  let session = snapshot(options.session), source = { ...options.source }, key = talkSessionIdentity(session), sourceKey = JSON.stringify(source);
  let epoch = 0, disposed = false, enabled = true, pending: AbortController | undefined, objectUrl: string | undefined;
  let state: TalkMediaState = { phase: "idle" };
  const active = (expected: number) => !disposed && enabled && epoch === expected;
  const publish = (next: TalkMediaState) => { state = next; options.onChange?.(next); };
  function release() {
    pending?.abort(); pending = undefined;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  }
  async function load() {
    if (!active(epoch) || source.kind === "unavailable" || state.phase === "loading" || state.phase === "ready") return;
    const expected = ++epoch; release();
    // Remote attachments use ordinary WebView media loading, never native HTTP
    // authority. Media elements omit cross-origin credentials and referrers.
    if (!source.authenticated) { publish({ phase: "ready", url: source.url }); return; }
    pending = new AbortController(); publish({ phase: "loading" });
    try {
      const blob = await loadTalkMediaBlob(snapshot(session), source, pending.signal);
      if (!active(expected)) return;
      objectUrl = URL.createObjectURL(blob); publish({ phase: "ready", url: objectUrl });
    } catch (cause) {
      if (active(expected)) publish({ phase: "error", error: cause instanceof Error ? cause.message : "添付を読み込めませんでした。" });
    } finally { if (epoch === expected) pending = undefined; }
  }
  function update(nextSession: MobileSession, nextSource: TalkMediaSource, nextEnabled = true) {
    if (disposed) return;
    const nextKey = talkSessionIdentity(nextSession), nextSourceKey = JSON.stringify(nextSource);
    session = snapshot(nextSession); source = { ...nextSource };
    if (key === nextKey && sourceKey === nextSourceKey && enabled === nextEnabled) return;
    key = nextKey; sourceKey = nextSourceKey; enabled = nextEnabled; epoch++; release(); publish({ phase: "idle" });
  }
  function failed(url: string) {
    if (!active(epoch) || state.phase !== "ready" || state.url !== url) return;
    epoch++; release(); publish({ phase: "error", error: "添付を表示できませんでした。再試行できます。" });
  }
  function dispose() { if (disposed) return; disposed = true; epoch++; release(); state = { phase: "idle" }; }
  return { getState: () => state, load, update, failed, dispose };
}
