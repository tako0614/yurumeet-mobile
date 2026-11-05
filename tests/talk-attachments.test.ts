import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { uploadTalkAttachment } from "../src/api.ts";

const originalFetch = globalThis.fetch, originalNow = Date.now;
const subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; Date.now = originalNow; });
const session = { hostUrl: "https://attachment-send.example", product: "yurume" as const, accessToken: "synthetic-attachment-session", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const me = session.hostUrl + "/users/me";
const peer: TalkContact = { type: "user", ap_id: session.hostUrl + "/users/peer", preferred_username: "peer", name: "Peer", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const group: TalkContact = { ...peer, type: "community", ap_id: session.hostUrl + "/groups/room" };
const png = (name = "Photo.png") => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(0); expect(check()).toBe(true); }
function subject() { const c = createTalkController({ session, actorApId: me, refreshHome: async () => {}, observedMessageIds: () => [], receive: { isForeground: () => true, schedule: () => () => {} } }); subjects.push(c); return c; }
function upload(id = "a1") { return { id, url: `/media/${id}.png`, r2_key: `uploads/${id}.png`, content_type: "image/png", expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }; }
type Call = { path: string; method: string; init?: RequestInit };
function transport(handler?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = []; let next = 0; const messages: TalkMessage[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), call = { path: url.pathname, method: init?.method ?? "GET", init }; calls.push(call);
    expect(url.origin).toBe(session.hostUrl); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-attachment-session");
    const custom = handler?.(call); if (custom) return custom;
    if (call.path.endsWith("/read-observed/init")) return observedInitAck();
    if (call.path === "/api/media/upload") {
      expect(call.method).toBe("POST"); expect(init?.body).toBeInstanceOf(FormData); expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
      expect(new Headers(init?.headers).get("content-type")).toBeNull(); expect((init as RequestInit & { maxRedirections?: number }).maxRedirections).toBe(0);
      return Response.json(upload((++next).toString(16)));
    }
    if (call.path.endsWith("/messages")) {
      if (call.method === "GET") return Response.json({ messages, has_more: false });
      expect(call.method).toBe("POST"); const body = JSON.parse(String(init?.body));
      const message: TalkMessage = { id: "sent-" + calls.length, content: body.content.trim(), attachments: body.attachments, created_at: new Date().toISOString(), sender: { ap_id: me, preferred_username: "me", name: "Me" } };
      messages.push(message); return Response.json({ message });
    }
    throw new Error("unexpected " + call.path);
  }, { preconnect: originalFetch.preconnect });
  return { calls, messages, uploads: () => calls.filter(c => c.path === "/api/media/upload"), sends: () => calls.filter(c => c.method === "POST" && c.path.endsWith("/messages")) };
}

for (const contact of [peer, group]) test(`a file-only ${contact.type} message uploads and binds the actual returned descriptor`, async () => {
  const t = transport(), c = subject(); await c.open(contact); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready");
  expect(c.state().content).toBe(""); expect(c.state().canSend).toBe(true); expect(t.sends()).toHaveLength(0);
  await c.send(); expect(t.sends()).toHaveLength(1); expect(t.sends()[0].path).toBe(contact.type === "community" ? `/api/communities/${encodeURIComponent(contact.ap_id)}/messages` : `/api/dm/user/${encodeURIComponent(contact.ap_id)}/messages`);
  expect(JSON.parse(String(t.sends()[0].init?.body)).attachments).toEqual([{ type: "Document", mediaType: "image/png", url: "/media/1.png", r2_key: "uploads/1.png", name: "Photo.png" }]);
  expect(c.state().messages).toHaveLength(1); expect(c.state().attachments).toHaveLength(0); expect(c.state().canSend).toBe(false);
});

test("unsupported, empty and oversized selections never upload or allow accidental text-only send", async () => {
  const t = transport(), c = subject(); await c.open(peer); c.setDraft("Keep text");
  for (const file of [new File(["x"], "bad.pdf", { type: "application/pdf" }), new File([], "empty.png", { type: "image/png" }), new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })]) {
    c.addAttachments([file]); expect(c.state().attachments[0]?.phase).toBe("failed"); expect(c.state().canSend).toBe(false); await c.send(); c.removeAttachment(c.state().attachments[0].id);
  }
  expect(t.uploads()).toHaveLength(0); expect(t.sends()).toHaveLength(0); expect(c.state().content).toBe("Keep text");
  c.addAttachments(Array.from({ length: 9 }, () => png())); expect(c.state().attachments).toHaveLength(0); expect(c.state().attachmentError).toContain("8");
});

test("new text and files added during a send survive its ACK, submitted files retire independently", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let sentBody: Record<string, unknown> | undefined;
  const t = transport(call => { if (call.path.endsWith("/messages") && call.method === "POST") { sentBody = JSON.parse(String(call.init?.body)); entered.resolve(); return held.promise; } }), c = subject();
  await c.open(peer); c.setDraft("First text"); c.addAttachments([png("First.png")]); await until(() => c.state().attachments[0]?.phase === "ready");
  const sending = c.send(); await entered.promise; await c.send(); c.setDraft("Next text"); c.addAttachments([png("Next.png")]); await until(() => c.state().attachments[1]?.phase === "ready");
  held.resolve(Response.json({ message: { id: "sent-one", content: "First text", attachments: sentBody!.attachments, created_at: new Date().toISOString(), sender: { ap_id: me, preferred_username: "me", name: null } } })); await sending;
  expect(t.sends()).toHaveLength(1); expect(c.state().content).toBe("Next text"); expect(c.state().attachments.map(item => item.name)).toEqual(["Next.png"]); expect(c.state().canSend).toBe(true);
});

test("adding only a new file during send does not retain already acknowledged text", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let body: Record<string, unknown> | undefined;
  transport(call => { if (call.path.endsWith("/messages") && call.method === "POST") { body = JSON.parse(String(call.init?.body)); entered.resolve(); return held.promise; } }); const c = subject();
  await c.open(peer); c.setDraft("Sent text"); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready"); const sending = c.send(); await entered.promise;
  c.addAttachments([png("Next.png")]); held.resolve(Response.json({ message: { id: "sent", content: "Sent text", attachments: body!.attachments, created_at: new Date().toISOString(), sender: { ap_id: me, preferred_username: "me", name: null } } })); await sending;
  expect(c.state().content).toBe(""); expect(c.state().attachments.map(item => item.name)).toEqual(["Next.png"]);
});

test("upload failure is recoverable only through explicit retry and never sends a message", async () => {
  let denied = true; const t = transport(call => call.path === "/api/media/upload" && denied ? Response.json({ error: "unavailable" }, { status: 503 }) : undefined), c = subject();
  await c.open(peer); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "unknown"); await c.send(); expect(t.uploads()).toHaveLength(1); expect(t.sends()).toHaveLength(0);
  denied = false; c.retryAttachment(c.state().attachments[0].id); await until(() => c.state().attachments[0]?.phase === "ready"); expect(t.uploads()).toHaveLength(2); expect(t.sends()).toHaveLength(0);
});

for (const bad of [{ ...upload(), url: "https://foreign.example/media/a1.png" }, { ...upload(), r2_key: "uploads/another.png" }, { ...upload(), content_type: "video/mp4" }, { ...upload(), expires_at: "invalid" }, { ...upload(), expires_at: undefined }]) test(`mismatched upload ACK is not a sendable attachment ${JSON.stringify(bad)}`, async () => {
  const t = transport(call => call.path === "/api/media/upload" ? Response.json(bad) : undefined), c = subject(); await c.open(peer); c.addAttachments([png()]);
  await until(() => c.state().attachments[0]?.phase === "unknown"); expect(c.state().canSend).toBe(false); await c.send(); expect(t.sends()).toHaveLength(0);
});

test("removal aborts its upload, unblocks the next file and ignores a late old ACK", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let signal: AbortSignal | null | undefined, first = true;
  const t = transport(call => { if (first && call.path === "/api/media/upload") { first = false; signal = call.init?.signal; entered.resolve(); return held.promise; } }), c = subject();
  await c.open(peer); c.addAttachments([png("Old.png"), png("Next.png")]); await entered.promise; c.removeAttachment(c.state().attachments[0].id);
  expect(signal?.aborted).toBe(true); await until(() => c.state().attachments[0]?.phase === "ready"); held.resolve(Response.json(upload("ff"))); await Bun.sleep(0);
  expect(c.state().attachments.map(item => item.name)).toEqual(["Next.png"]); expect(t.sends()).toHaveLength(0);
});

test("conversation drafts own uploads and an account change clears the files and aborts prior authority", async () => {
  const held = deferred<Response>(), entered = deferred<void>(), second = deferred<Response>(), secondEntered = deferred<void>(); let signal: AbortSignal | null | undefined, count = 0;
  transport(call => { if (call.path === "/api/media/upload") { count++; if (count === 1) { entered.resolve(); return held.promise; } signal = call.init?.signal; secondEntered.resolve(); return second.promise; } }); const c = subject();
  await c.open(peer); c.addAttachments([png()]); await entered.promise; c.back(); await c.open(group); expect(c.state().attachments).toHaveLength(0);
  held.resolve(Response.json(upload())); await c.open(peer); await until(() => c.state().attachments[0]?.phase === "ready");
  c.addAttachments([png("Second.png")]); await secondEntered.promise; c.updateSession({ ...session, accessToken: "new-synthetic-session" }); expect(signal?.aborted).toBe(true);
  second.resolve(Response.json(upload("b1"))); await Bun.sleep(0); expect(c.state().attachments).toHaveLength(0); expect(c.state().selected).toBeUndefined();
});

test("unknown message ACK retains files and fences resends until explicit existing readback", async () => {
  const t = transport(call => call.path.endsWith("/messages") && call.method === "POST" ? new Response("{") : undefined), c = subject();
  await c.open(peer); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready"); await c.send();
  expect(c.state().uncertain).toBe(true); expect(c.state().attachments).toHaveLength(1); await c.send(); expect(t.sends()).toHaveLength(1); await c.reload();
  expect(c.state().uncertain).toBe(false); expect(c.state().attachments).toHaveLength(1); expect(t.sends()).toHaveLength(1);
});

for (const wrong of ["attachment", "author", "text"]) test(`a successful message ACK with wrong ${wrong} stays uncertain and retains its actual draft`, async () => {
  const t = transport(call => call.path.endsWith("/messages") && call.method === "POST" ? Response.json({ message: { id: "wrong", content: wrong === "text" ? "Another text" : "", attachments: wrong === "attachment" ? [] : JSON.parse(String(call.init?.body)).attachments, created_at: new Date().toISOString(), sender: { ap_id: wrong === "author" ? me + "-other" : me, preferred_username: "me", name: null } } }) : undefined), c = subject();
  await c.open(peer); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready"); await c.send(); expect(c.state().uncertain).toBe(true); expect(c.state().attachments).toHaveLength(1); expect(t.sends()).toHaveLength(1);
});

test("definite send rejection retains ready files without an automatic retry", async () => {
  const t = transport(call => call.path.endsWith("/messages") && call.method === "POST" ? Response.json({ error: "forbidden" }, { status: 403 }) : undefined), c = subject();
  await c.open(group); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready"); await c.send(); expect(c.state().uncertain).toBe(false); expect(c.state().attachments[0]?.phase).toBe("ready"); expect(t.sends()).toHaveLength(1);
});

for (const withAttachment of [false, true]) test(`a native no-follow redirect is an unknown send result (attachment=${withAttachment})`, async () => {
  const t = transport(call => call.path.endsWith("/messages") && call.method === "POST" ? new Response(null, { status: 303, headers: { location: session.hostUrl + "/next" } }) : undefined), c = subject();
  await c.open(peer); c.setDraft("Keep redirected draft");
  if (withAttachment) { c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready"); }
  await c.send(); expect(c.state().uncertain).toBe(true); expect(c.state().content).toBe("Keep redirected draft"); expect(c.state().attachments.length).toBe(withAttachment ? 1 : 0);
  await c.send(); expect(t.sends()).toHaveLength(1);
});

test("expired upload receipts require explicit re-upload before sending", async () => {
  const t = transport(), c = subject(); await c.open(peer); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready");
  Date.now = () => originalNow() + 8 * 86400_000; expect(c.state().attachments[0]?.phase).toBe("expired"); expect(c.state().canSend).toBe(false); await c.send(); expect(t.sends()).toHaveLength(0);
});

test("an OS file selection captures the original conversation and rejects delayed ABA/account results", async () => {
  const t = transport(), c = subject(); await c.open(peer); const accept = c.captureAttachmentSelection();
  await c.open(group); expect(accept([png()])).toBe(false); await c.open(peer); expect(accept([png()])).toBe(false); expect(t.uploads()).toHaveLength(0);
  const current = c.captureAttachmentSelection(); expect(current([png()])).toBe(true); await until(() => c.state().attachments[0]?.phase === "ready");
  const retired = c.captureAttachmentSelection(); c.updateSession({ ...session, accessToken: "another-synthetic-session" }); expect(retired([png()])).toBe(false); expect(t.uploads()).toHaveLength(1);
});

test("a distant advertised expiry cannot overflow the browser timer into a busy loop", async () => {
  const originalTimer = globalThis.setTimeout, delays: number[] = [];
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => { delays.push(delay ?? 0); return originalTimer(callback, delay); }) as typeof setTimeout;
  try {
    transport(call => call.path === "/api/media/upload" ? Response.json({ ...upload(), expires_at: "3000-01-01T00:00:00Z" }) : undefined);
    const c = subject(); await c.open(peer); c.addAttachments([png()]); await until(() => c.state().attachments[0]?.phase === "ready");
    expect(Math.max(...delays)).toBe(2_147_483_647); expect(c.state().canSend).toBe(true);
  } finally { globalThis.setTimeout = originalTimer; }
});

test("the installed native JS upload preserves multipart bytes and refuses redirects", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), calls: string[] = [], ack = upload(); let bodyReads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (command: string, args: { clientConfig?: { headers: [string, string][]; data: number[]; url: string; method: string; maxRedirections: number } }) => {
    calls.push(command);
    if (command === "plugin:http|fetch") {
      const config = args.clientConfig!; expect(config.maxRedirections).toBe(0); expect(config.url).toBe(session.hostUrl + "/api/media/upload"); expect(config.method).toBe("POST");
      const headers = new Headers(config.headers); expect(headers.get("authorization")).toBe("Bearer synthetic-attachment-session"); expect(headers.get("content-type")).toStartWith("multipart/form-data; boundary="); expect(headers.has("cookie") || headers.has("referer")).toBe(false);
      const form = await new Request(config.url, { method: "POST", headers, body: new Uint8Array(config.data) }).formData(); const file = form.get("file") as File;
      expect(file.name).toBe("Native.png"); expect(file.type).toBe("image/png"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await png().arrayBuffer())); return 1;
    }
    if (command === "plugin:http|fetch_send") return { status: 200, statusText: "OK", url: session.hostUrl + "/api/media/upload", headers: [["content-type", "application/json"]], rid: 2 };
    if (command === "plugin:http|fetch_read_body") { bodyReads++; expect(bodyReads).toBeLessThanOrEqual(2); return bodyReads === 1 ? [...new TextEncoder().encode(JSON.stringify(ack)), 0] : [1]; }
    if (command === "plugin:http|fetch_cancel" || command === "plugin:http|fetch_cancel_body") return;
    throw new Error("unexpected native IPC command");
  } } } });
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => nativeFetch(input, init), { preconnect: originalFetch.preconnect });
  try {
    const result = await uploadTalkAttachment(session, png("Native.png"), new AbortController().signal); expect(result.attachment.r2_key).toBe(ack.r2_key);
    expect(calls.filter(c => c === "plugin:http|fetch")).toHaveLength(1); expect(bodyReads).toBe(2);
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});
