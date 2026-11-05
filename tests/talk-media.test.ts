import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { createTalkMediaController, describeTalkMedia, loadTalkMediaBlob } from "../src/talk-media.ts";

const session = { hostUrl: "https://talk-media.example", product: "yurume" as const, accessToken: "synthetic-media-session", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const path = "/media/abc123.png", attachment = { mediaType: "image/png", url: path, name: "Photo" };
const source = () => describeTalkMedia([attachment], session.hostUrl)[0];
const originalFetch = globalThis.fetch, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
const controllers: ReturnType<typeof createTalkMediaController>[] = [];
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.dispose());
  globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
});
function intercept(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) { globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function subject() { const controller = createTalkMediaController({ session, source: source() }); controllers.push(controller); return controller; }
const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

test("actual attachment shapes preserve local/AP media and expose unsupported files", () => {
  expect(describeTalkMedia(undefined, session.hostUrl)).toEqual([]);
  const media = describeTalkMedia([attachment, { content_type: "video/mp4", r2_key: "uploads/def456.mp4" }, { mediaType: "image/webp", url: "https://remote-media.example/photo.webp" }, { mediaType: "application/pdf", url: "/media/abc.pdf", name: "Report" }], session.hostUrl);
  expect(media.map(item => item.kind)).toEqual(["image", "video", "image", "unavailable"]);
  expect(media[0]).toMatchObject({ label: "Photo", url: session.hostUrl + path, authenticated: true });
  expect(media[1]).toMatchObject({ url: session.hostUrl + "/media/def456.mp4", authenticated: true });
  expect(media[2].authenticated).toBe(false); expect(media[3].label).toBe("Report");
});

test("invalid local paths, mixed MIME and unsafe URLs never become media requests", async () => {
  let calls = 0; intercept(async () => { calls++; return png(); });
  for (const url of ["javascript:alert(1)", "data:image/png,x", "blob:https://remote.example/x", "https://user:pass@talk-media.example/media/abc.png", "/api/auth/me", "/media/abc.png?token=x", "/media/abc.png#x", "/media/%2fsecret.png", "/media/../abc.png", "http://remote.example/image.png", " /media/abc.png", "//remote.example/image.png"]) {
    const invalid = describeTalkMedia([{ ...attachment, url }], session.hostUrl)[0];
    expect(invalid.kind).toBe("unavailable"); await expect(loadTalkMediaBlob(session, invalid, new AbortController().signal)).rejects.toThrow();
  }
  expect(describeTalkMedia([{ ...attachment, content_type: "video/mp4" }], session.hostUrl)[0].kind).toBe("unavailable");
  expect(calls).toBe(0);
});

test("local raw media uses the canonical selected host, current session and no cookies/redirect/cache", async () => {
  let calls = 0;
  intercept(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++; expect(String(url)).toBe(session.hostUrl + path);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-media-session");
    expect((init as RequestInit & { maxRedirections?: number })?.maxRedirections).toBe(0);
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store"); expect(init?.referrerPolicy).toBe("no-referrer");
    return png();
  });
  const blob = await loadTalkMediaBlob({ ...session, apiBaseUrl: session.hostUrl + "/different-api" }, source(), new AbortController().signal);
  expect(blob.type).toBe("image/png"); expect(blob.size).toBe(4); expect(calls).toBe(1);
});

test("remote HTTPS media is explicit and never carries native authorization", async () => {
  const remote = describeTalkMedia([{ ...attachment, url: "https://remote-media.example/photo.png?size=small" }], session.hostUrl)[0];
  let nativeCalls = 0; intercept(async () => { nativeCalls++; throw new Error("external media must not enter native transport"); });
  const controller = createTalkMediaController({ session, source: remote }); controllers.push(controller);
  expect(controller.getState().phase).toBe("idle"); await controller.load(); expect(controller.getState()).toEqual({ phase: "ready", url: remote.url }); expect(nativeCalls).toBe(0);
  for (const url of ["https://127.0.0.1:8443/photo.png", "https://192.168.1.20/photo.png", "https://internal-device.example/photo.png"]) {
    const external = describeTalkMedia([{ ...attachment, url }], session.hostUrl)[0]; controller.update(session, external); await controller.load();
    expect(controller.getState()).toEqual({ phase: "ready", url }); await expect(loadTalkMediaBlob(session, external, new AbortController().signal)).rejects.toThrow();
  }
  expect(nativeCalls).toBe(0);
  await expect(loadTalkMediaBlob(session, remote, new AbortController().signal)).rejects.toThrow();
  await expect(loadTalkMediaBlob({ ...session, hostUrl: "https://another-account.example" }, source(), new AbortController().signal)).rejects.toThrow();
});

test("forged descriptors cannot send a token to another origin or a non-media route", async () => {
  let calls = 0; intercept(async () => { calls++; return png(); });
  for (const url of ["https://other.example/media/abc.png", session.hostUrl + "/api/auth/me", session.hostUrl + path + "?x=1"]) {
    await expect(loadTalkMediaBlob(session, { ...source(), url }, new AbortController().signal)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("HTTP denials and wrong content type stay visible and an explicit retry can recover", async () => {
  let count = 0; intercept(async () => ++count === 1 ? new Response("private", { status: 403 }) : png());
  URL.createObjectURL = () => "blob:retry";
  const controller = subject(); await controller.load(); expect(controller.getState().phase).toBe("error"); expect(controller.getState().error).toContain("403");
  await controller.load(); expect(controller.getState()).toEqual({ phase: "ready", url: "blob:retry" }); expect(count).toBe(2);
  intercept(async () => new Response("<html>wrong</html>", { headers: { "content-type": "text/html" } }));
  await expect(loadTalkMediaBlob(session, source(), new AbortController().signal)).rejects.toThrow("形式");
});

test("a declared oversized or streamed oversized image is cancelled without an object URL", async () => {
  let cancelled = 0;
  intercept(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "image/png", "content-length": String(20 * 1024 * 1024 + 1) } }));
  await expect(loadTalkMediaBlob(session, source(), new AbortController().signal)).rejects.toThrow("サイズ"); expect(cancelled).toBe(1);
  intercept(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(20 * 1024 * 1024 + 1)); }, cancel() { cancelled++; } }), { headers: { "content-type": "image/png" } }));
  await expect(loadTalkMediaBlob(session, source(), new AbortController().signal)).rejects.toThrow("サイズ"); expect(cancelled).toBe(2);
});

test("abort bounds a stalled body even if the native transport ignores the signal", async () => {
  let cancelled = 0; const entered = deferred<void>(), caller = new AbortController();
  intercept(async () => new Response(new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled++; } }), { headers: { "content-type": "image/png" } }));
  const pending = loadTalkMediaBlob(session, source(), caller.signal); await entered.promise; caller.abort(new Error("cancel media"));
  await expect(pending).rejects.toThrow("cancel media"); expect(cancelled).toBe(1);
});

test("a pending fetch is bounded by abort and its late response body is cancelled", async () => {
  const held = deferred<Response>(), caller = new AbortController(); let cancelled = 0;
  intercept(() => held.promise);
  const pending = loadTalkMediaBlob(session, source(), caller.signal); caller.abort(new Error("cancel headers"));
  await expect(pending).rejects.toThrow("cancel headers");
  held.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "image/png" } }));
  await new Promise<void>(resolve => queueMicrotask(resolve)); expect(cancelled).toBe(1);
});

test("the whole-body deadline rejects a stalled read without transport cooperation", async () => {
  const originalTimer = globalThis.setTimeout, entered = deferred<void>(); let expire: (() => void) | undefined, cancelled = 0;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    if (delay === 15_000 && typeof callback === "function") expire = () => callback();
    return originalTimer(callback, delay);
  }) as typeof setTimeout;
  try {
    intercept(async () => new Response(new ReadableStream({ pull() { entered.resolve(); }, cancel() { cancelled++; } }), { headers: { "content-type": "image/png" } }));
    const pending = loadTalkMediaBlob(session, source(), new AbortController().signal); await entered.promise;
    expect(expire).toBeDefined(); expire!(); await expect(pending).rejects.toThrow("タイムアウト"); expect(cancelled).toBe(1);
  } finally { globalThis.setTimeout = originalTimer; }
});

test("the installed native JS transport dispatches zero redirects and refuses a redirect response", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), commands: string[] = [], body = deferred<number[]>();
  const invoke = async (command: string, args: { clientConfig?: { maxRedirections?: number; url?: string; headers?: string[][] } }) => {
    commands.push(command);
    if (command === "plugin:http|fetch") {
      expect(args.clientConfig?.maxRedirections).toBe(0); expect(args.clientConfig?.url).toBe(session.hostUrl + path);
      expect(args.clientConfig?.headers).toContainEqual(["authorization", "Bearer synthetic-media-session"]);
      expect(args.clientConfig?.headers?.some(([name]) => ["cookie", "referer"].includes(name))).toBe(false); return 1;
    }
    if (command === "plugin:http|fetch_send") return { status: 302, statusText: "Found", url: session.hostUrl + path, headers: [["location", "https://never-requested.example/photo.png"]], rid: 2 };
    if (command === "plugin:http|fetch_read_body") return body.promise;
    if (command === "plugin:http|fetch_cancel_body") { body.resolve([1]); return; }
    throw new Error(`unexpected native command: ${command}`);
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke } } });
  try {
    intercept((input, init) => nativeFetch(input, init));
    await expect(loadTalkMediaBlob(session, source(), new AbortController().signal)).rejects.toThrow("302");
    expect(commands.filter(command => command !== "plugin:http|fetch_read_body")).toEqual(["plugin:http|fetch", "plugin:http|fetch_send", "plugin:http|fetch_cancel_body"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("clicks are single-flight, scope changes cancel the captured read and late data is ignored", async () => {
  const held = deferred<Response>(); let count = 0, signal: AbortSignal | null | undefined, creates = 0;
  intercept(async (_url: RequestInfo | URL, init?: RequestInit) => { count++; signal = init?.signal; return held.promise; });
  URL.createObjectURL = () => { creates++; return "blob:old-account"; };
  const controller = subject(), pending = controller.load(); await controller.load(); expect(count).toBe(1);
  controller.update({ ...session, accessToken: "next-synthetic-session" }, source()); expect(signal?.aborted).toBe(true); expect(controller.getState().phase).toBe("idle");
  held.resolve(png()); await pending; expect(controller.getState().phase).toBe("idle"); expect(creates).toBe(0);
});

test("ready media is revoked on background, source change, decode failure and dispose", async () => {
  const revoked: string[] = []; let next = 0; intercept(async () => png());
  URL.createObjectURL = () => `blob:media-${++next}`; URL.revokeObjectURL = url => { revoked.push(url); };
  const controller = subject(); await controller.load(); controller.update(session, source(), false); expect(revoked).toEqual(["blob:media-1"]);
  await controller.load(); expect(next).toBe(1); controller.update(session, source(), true); await controller.load();
  controller.failed("blob:unrelated"); expect(controller.getState().phase).toBe("ready"); controller.failed("blob:media-2"); expect(controller.getState().phase).toBe("error");
  await controller.load(); controller.update(session, { ...source(), label: "New caption" }); expect(controller.getState().phase).toBe("idle");
  await controller.load(); controller.dispose(); expect(revoked).toEqual(["blob:media-1", "blob:media-2", "blob:media-3", "blob:media-4"]);
});

test("the native CSP can render only the bounded media blob source", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  for (const csp of [config.app.security.csp, config.app.security.devCsp]) {
    const directives = Object.fromEntries(csp.split(";").map((part: string) => { const [name, ...values] = part.trim().split(/\s+/); return [name, values]; }));
    expect(directives["img-src"]).toContain("blob:"); expect(directives["media-src"]).toEqual(["blob:", "https:"]);
    expect(directives["script-src"]).not.toContain("blob:"); expect(directives["connect-src"]).not.toContain("blob:");
  }
  expect(readFileSync(new URL("../index.html", import.meta.url), "utf8")).toContain('<meta name="referrer" content="no-referrer" />');
});
