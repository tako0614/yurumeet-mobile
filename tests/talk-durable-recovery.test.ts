import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkController } from "../src/talk-controller.ts";
import { createTalkRecoveryStore } from "../src/talk-recovery.ts";
import { observedInitAck } from "./talk-read-fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const alice = { type: "user" as const, ap_id: "https://peer.example/users/alice", preferred_username: "alice",
  name: "Alice", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };

function fixture(options: {
  read?: () => Promise<void>;
  write?: (attempt: number, value: string) => Promise<void>;
  post?: (content: string) => Response | Promise<Response>;
  upload?: () => Response;
  contact?: () => Response;
} = {}) {
  let posts = 0, writes = 0;
  const values = new Map<string, string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/dm/contact/") && options.contact) return options.contact();
    if (path === "/api/media/upload" && request.method === "POST" && options.upload) return options.upload();
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    if (request.method === "GET" && path.endsWith("/messages")) return Response.json({ messages: [] });
    if (request.method === "POST" && path.endsWith("/messages")) {
      posts++;
      const { content } = await request.json() as { content: string };
      return options.post?.(content) ?? Response.json({ message: { id: "ack-" + posts, content, created_at: null,
        sender: { ap_id: "me", preferred_username: "me", name: null } } });
    }
    throw new Error("Unexpected local fixture request");
  } });
  const session = { product: "yurume" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-session",
    tokenType: "Bearer", createdAt: "2026-11-10T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { await options.read?.(); return values.get(key); },
    async set(key, value) { writes++; await options.write?.(writes, value); values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const recovery = createTalkRecoveryStore({ store, scope: { product: "yurume", hostUrl: session.hostUrl, actorApId: "me" } });
  const createController = () => createTalkController({ session, actorApId: "me", recovery,
    refreshHome: async () => {}, observedMessageIds: () => [] });
  const controller = createController();
  return { controller, createController, recovery, session, counts: () => ({ posts, writes }),
    close() { controller.dispose(); server.stop(true); } };
}

test("the real controller waits for a durable original intent before message POST", async () => {
  const release = deferred(), entered = deferred(), events: string[] = [];
  const values = new Map<string, string>();
  let posts = 0;
  let originalSaved: unknown;
  let postedContent = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    if (request.method === "GET" && path.endsWith("/messages")) return Response.json({ messages: [] });
    if (request.method === "POST" && path.endsWith("/messages")) {
      posts++; events.push("post"); entered.resolve();
      originalSaved = [...values.values()].map(value => JSON.parse(value).drafts[0]);
      const body = await request.json() as { content: string };
      postedContent = body.content;
      return Response.json({ message: { id: "ack-one", content: body.content, created_at: null,
        sender: { ap_id: "me", preferred_username: "me", name: null } } });
    }
    throw new Error("Unexpected local fixture request");
  } });
  const session = { product: "yurume" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-session",
    tokenType: "Bearer", createdAt: "2026-11-10T00:00:00Z" };
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); },
    async set(key, value) { events.push("save"); entered.resolve(); await release.promise; values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
  const recovery = createTalkRecoveryStore({ store, scope: { product: "yurume", hostUrl: session.hostUrl, actorApId: "me" } });
  const options = { session, actorApId: "me", recovery, refreshHome: async () => {}, observedMessageIds: () => [] };
  const controller = createTalkController(options);
  let sending: Promise<void> | undefined;
  try {
    await controller.open(alice);
    controller.setDraft("送信する元の本文");
    sending = controller.send();
    await entered.promise;
    expect(events).toEqual(["save"]);
    expect(posts).toBe(0);
    controller.setDraft("送信待ちの間に追記した次の本文");
    release.resolve();
    await sending;
    expect(posts).toBe(1);
    expect(events.indexOf("save")).toBeLessThan(events.indexOf("post"));
    expect(postedContent).toBe("送信する元の本文");
    expect(originalSaved).toMatchObject([{ content: "送信待ちの間に追記した次の本文", sendState: "pending",
      intent: { content: "送信する元の本文", attachments: [] } }]);
    expect(controller.state().content).toBe("送信待ちの間に追記した次の本文");
    expect(await recovery.load()).toMatchObject([{ content: "送信待ちの間に追記した次の本文", sendState: "draft" }]);
  } finally {
    release.resolve();
    await sending;
    controller.dispose();
    server.stop(true);
  }
});

test("an unsent draft is saved and restored by a fresh real controller without a message POST", async () => {
  const f = fixture();
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice);
    f.controller.setDraft("再起動後に続ける日本語の下書き");
    await f.controller.flushRecovery();
    f.controller.dispose();
    fresh = f.createController();
    await fresh.open(alice);
    expect(fresh.state()).toMatchObject({ content: "再起動後に続ける日本語の下書き", canSend: true, uncertain: false });
    expect(f.counts().posts).toBe(0);
  } finally { fresh?.dispose(); f.close(); }
});

test("restored unknown sends remain blocked after reads until the user explicitly confirms review", async () => {
  const f = fixture({ post() { return new Response("synthetic unknown", { status: 503 }); } });
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice);
    f.controller.setDraft("元の送信内容");
    await f.controller.send();
    f.controller.setDraft("新しい別の本文");
    await f.controller.flushRecovery();
    f.controller.dispose();
    fresh = f.createController();
    await fresh.open(alice);
    expect(fresh.state()).toMatchObject({ content: "新しい別の本文", uncertain: true, canSend: false,
      recovery: { intent: { content: "元の送信内容" }, canConfirmReview: true } });
    await fresh.send();
    expect(f.counts().posts).toBe(1);
    await fresh.confirmRecoveryReview();
    expect(fresh.state()).toMatchObject({ content: "新しい別の本文", uncertain: false, canSend: true });
    expect(f.counts().posts).toBe(1);
    expect(await f.recovery.load()).toMatchObject([{ content: "新しい別の本文", sendState: "draft" }]);
  } finally { fresh?.dispose(); f.close(); }
});

test("a failed recovery load blocks writes and only explicit retry can restore the original draft", async () => {
  let fail = false;
  const f = fixture({ async read() { if (fail) throw new Error("synthetic unavailable read"); } });
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice); f.controller.setDraft("読取失敗でも保持する原本"); await f.controller.flushRecovery(); f.controller.dispose();
    const writes = f.counts().writes; fail = true; fresh = f.createController(); await fresh.open(alice);
    fresh.setDraft("未確認原本の上書きは禁止"); await fresh.send(); await fresh.flushRecovery();
    expect(fresh.state().canSend).toBe(false); expect(f.counts()).toEqual({ posts: 0, writes });
    fail = false; await fresh.flushRecovery();
    expect(fresh.state().content).toBe("読取失敗でも保持する原本");
    expect(fresh.state().canSend).toBe(true);
  } finally { fresh?.dispose(); f.close(); }
});

test("a dispatch interrupted before its reply restores pending as uncertain without sending again", async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ async post() { entered.resolve(); await release.promise; return new Response("synthetic unknown", { status: 503 }); } });
  let fresh: ReturnType<typeof createTalkController> | undefined, sending: Promise<void> | undefined;
  try {
    await f.controller.open(alice); f.controller.setDraft("返答前に終了した送信"); sending = f.controller.send(); await entered.promise;
    expect(await f.recovery.load()).toMatchObject([{ sendState: "pending", intent: { content: "返答前に終了した送信" } }]);
    f.controller.dispose(); fresh = f.createController(); await fresh.open(alice);
    expect(fresh.state()).toMatchObject({ uncertain: true, canSend: false, recovery: { intent: { content: "返答前に終了した送信" } } });
    await fresh.send(); expect(f.counts().posts).toBe(1);
  } finally { release.resolve(); await sending; fresh?.dispose(); f.close(); }
});

test("restored media retains its real receipt but requires file reselection once it expires", async () => {
  let expiry = 0;
  const f = fixture({ upload() { expiry = Date.now() + 2000; return Response.json({ id: "a2", content_type: "image/png",
    url: "/media/a2.png", r2_key: "uploads/a2.png", expires_at: new Date(expiry).toISOString() }); } });
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice); f.controller.addAttachments([new File(["original"], "復元する写真.png", { type: "image/png" })]);
    const deadline = Date.now() + 1000;
    while (f.controller.state().attachments[0]?.phase !== "ready" && Date.now() < deadline) await Bun.sleep(1);
    expect(f.controller.state().attachments[0]?.phase).toBe("ready");
    await f.controller.flushRecovery(); f.controller.dispose(); fresh = f.createController(); await fresh.open(alice);
    expect(fresh.state().attachments[0]).toMatchObject({ phase: "ready", name: "復元する写真.png", attachment: { r2_key: "uploads/a2.png" } });
    expect(fresh.state().canSend).toBe(true);
    await Bun.sleep(Math.max(0, expiry - Date.now() + 5));
    expect(fresh.state().attachments[0]).toMatchObject({ phase: "expired", canRetry: false });
    await fresh.send(); expect(f.counts().posts).toBe(0);
    expect(fresh.state().canSend).toBe(false);
  } finally { fresh?.dispose(); f.close(); }
});

test("changing the session clears even unopened saved hints", async () => {
  const f = fixture();
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice); f.controller.setDraft("元本人だけの保存本文"); await f.controller.flushRecovery(); f.controller.dispose();
    fresh = f.createController(); await fresh.restoreRecovery();
    expect(fresh.state().recovery?.drafts).toHaveLength(1);
    fresh.updateSession({ ...f.session, accessToken: "synthetic-other-epoch" }); fresh.updateActor("other-actor");
    expect(fresh.state().recovery?.drafts).toHaveLength(0);
    expect(fresh.state().recovery?.intent).toBeUndefined();
    await fresh.flushRecovery(); expect(f.counts().posts).toBe(0);
  } finally { fresh?.dispose(); f.close(); }
});

test("a late original-scope recovery load cannot publish into a replacement session", async () => {
  const entered = deferred(), release = deferred(); let hold = false;
  const f = fixture({ async read() { if (hold) { entered.resolve(); await release.promise; } } });
  let fresh: ReturnType<typeof createTalkController> | undefined, loading: Promise<void> | undefined;
  try {
    await f.controller.open(alice); f.controller.setDraft("遅れて届く元本人の本文"); await f.controller.flushRecovery(); f.controller.dispose();
    hold = true; fresh = f.createController(); loading = fresh.restoreRecovery(); await entered.promise;
    fresh.updateSession({ ...f.session, accessToken: "synthetic-other-epoch" }); fresh.updateActor("other-actor");
    release.resolve(); await loading;
    expect(fresh.state().recovery?.drafts).toHaveLength(0); expect(fresh.state().canSend).toBe(false);
  } finally { release.resolve(); await loading; fresh?.dispose(); f.close(); }
});

test("a rejected saved-contact hint creates no conversation and does not block an unrelated verified contact", async () => {
  const bob = { ...alice, ap_id: "https://peer.example/users/bob" };
  const f = fixture({ contact: () => Response.json({ contact: bob }) });
  let fresh: ReturnType<typeof createTalkController> | undefined;
  try {
    await f.controller.open(alice); f.controller.setDraft("正規相手を待つ保存本文"); await f.controller.flushRecovery(); f.controller.dispose();
    fresh = f.createController(); await fresh.restoreRecovery(); await fresh.openRecovered(fresh.state().recovery!.drafts[0]);
    expect(fresh.state().selected).toBeUndefined(); expect(fresh.state().recovery?.drafts).toHaveLength(1);
    await fresh.open(bob); fresh.setDraft("別の正規相手の本文");
    expect(fresh.state().canSend).toBe(true); expect(f.counts().posts).toBe(0);
  } finally { fresh?.dispose(); f.close(); }
});

test("checkpoints retain other conversations' original media and unfinished attachment metadata", async () => {
  let uploads = 0, messages = 0;
  const expiresAt = "3000-01-01T00:00:00.000Z";
  const f = fixture({ upload() {
    uploads++;
    return uploads === 1 ? Response.json({ id: "a1", content_type: "image/png", url: "/media/a1.png",
      r2_key: "uploads/a1.png", expires_at: expiresAt }) : new Response("synthetic upload unknown", { status: 503 });
  }, post(content) {
    return ++messages === 1 ? new Response("synthetic send unknown", { status: 503 })
      : Response.json({ message: { id: "ack-other", content, created_at: null,
        sender: { ap_id: "me", preferred_username: "me", name: null } } });
  } });
  async function phase(value: "ready" | "unknown") {
    const deadline = Date.now() + 1000;
    while (f.controller.state().attachments[0]?.phase !== value && Date.now() < deadline) await Bun.sleep(1);
    expect(f.controller.state().attachments[0]?.phase).toBe(value);
  }
  try {
    await f.controller.open(alice);
    f.controller.addAttachments([new File(["original-media"], "元の写真.png", { type: "image/png" })]);
    await phase("ready");
    await f.controller.send();
    expect(f.controller.state().uncertain).toBe(true);
    await f.controller.open({ ...alice, ap_id: "https://peer.example/users/bob" });
    f.controller.addAttachments([new File(["unfinished"], "未完の写真.png", { type: "image/png" })]);
    await phase("unknown");
    await f.controller.open({ ...alice, ap_id: "https://peer.example/users/charlie" });
    f.controller.setDraft("別の会話の本文");
    await f.controller.send();
    expect(f.counts().posts).toBe(2);
    const saved = await f.recovery.load();
    expect(saved).toHaveLength(2);
    expect(saved?.[0]).toMatchObject({ contact: { apId: alice.ap_id }, content: "", sendState: "uncertain",
      intent: { content: "", attachments: [{ expiresAt, attachment: { name: "元の写真.png", r2_key: "uploads/a1.png" } }] } });
    expect(saved?.[1]).toMatchObject({ contact: { apId: "https://peer.example/users/bob" }, sendState: "draft",
      attachments: [{ phase: "needs-reselection", name: "未完の写真.png", mediaType: "image/png", size: 10, reason: "unknown" }] });
  } finally { f.close(); }
});

test("an unconfirmed preflight write retains the draft and performs no message POST or storage retry", async () => {
  const f = fixture({ async write() { throw new Error("synthetic store write failure"); } });
  try {
    await f.controller.open(alice);
    f.controller.setDraft("保存できるまで送らない");
    await f.controller.send();
    expect(f.counts()).toEqual({ posts: 0, writes: 1 });
    expect(f.controller.state()).toMatchObject({ content: "保存できるまで送らない", sending: false, uncertain: false, canSend: false });
    expect(f.controller.state().error).toContain("Recovery storage");
    expect(await f.recovery.load()).toBeNull();
  } finally { f.close(); }
});

test("a server503 checkpoints the original unknown intent without automatically resending", async () => {
  const f = fixture({ post() { return new Response("synthetic unavailable", { status: 503 }); } });
  try {
    await f.controller.open(alice);
    f.controller.setDraft("結果がわからない元の本文");
    await f.controller.send();
    f.controller.setDraft("別の新しい下書き");
    await f.controller.send();
    expect(f.counts()).toEqual({ posts: 1, writes: 2 });
    expect(f.controller.state()).toMatchObject({ content: "別の新しい下書き", uncertain: true, canSend: false });
    expect(await f.recovery.load()).toMatchObject([{ sendState: "uncertain",
      intent: { content: "結果がわからない元の本文", attachments: [] } }]);
  } finally { f.close(); }
});

test("new input during the ACK checkpoint is saved before the controller becomes sendable", async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ async write(attempt) { if (attempt === 2) { entered.resolve(); await release.promise; } } });
  let sending: Promise<void> | undefined;
  try {
    await f.controller.open(alice);
    f.controller.setDraft("ACKを受ける元の本文");
    sending = f.controller.send();
    await entered.promise;
    f.controller.setDraft("ACKの保存中に書いた次の本文");
    await f.controller.send();
    expect(f.counts().posts).toBe(1);
    expect(f.controller.state().sending).toBe(true);
    release.resolve();
    await sending;
    expect(f.controller.state()).toMatchObject({ content: "ACKの保存中に書いた次の本文", sending: false, canSend: true });
    expect(await f.recovery.load()).toMatchObject([{ content: "ACKの保存中に書いた次の本文", sendState: "draft" }]);
  } finally { release.resolve(); await sending; f.close(); }
});

test("an old credential epoch waiting for storage cannot dispatch or reuse its port for another epoch", async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ async write() { entered.resolve(); await release.promise; } });
  let sending: Promise<void> | undefined;
  try {
    await f.controller.open(alice);
    f.controller.setDraft("古い本人の未送信本文");
    sending = f.controller.send();
    await entered.promise;
    f.controller.updateSession({ ...f.session, accessToken: "synthetic-replacement-epoch" });
    f.controller.updateActor("different-actor");
    await f.controller.open(alice);
    f.controller.setDraft("新しい本人の本文");
    release.resolve();
    await sending;
    await f.controller.send();
    expect(f.counts()).toEqual({ posts: 0, writes: 1 });
    expect(f.controller.state()).toMatchObject({ content: "新しい本人の本文", canSend: false });
    expect(await f.recovery.load()).toMatchObject([{ intent: { content: "古い本人の未送信本文" } }]);
  } finally { release.resolve(); await sending; f.close(); }
});

test("a failed ACK checkpoint never changes a confirmed send into a retryable send failure", async () => {
  const f = fixture({ async write(attempt) { if (attempt === 2) throw new Error("synthetic post-ACK storage failure"); } });
  try {
    await f.controller.open(alice);
    f.controller.setDraft("送信確認済みの本文");
    await f.controller.send();
    expect(f.counts()).toEqual({ posts: 1, writes: 2 });
    expect(f.controller.state()).toMatchObject({ content: "", uncertain: false, sending: false, canSend: false });
    expect(f.controller.state().messages).toMatchObject([{ id: "ack-1", content: "送信確認済みの本文" }]);
    expect(f.controller.state().error).toContain("送信は確認済み");
    expect(await f.recovery.load()).toMatchObject([{ sendState: "pending", intent: { content: "送信確認済みの本文" } }]);
    await f.controller.send();
    expect(f.counts().posts).toBe(1);
  } finally { f.close(); }
});

test("media that expires while secure storage is pending is not dispatched", async () => {
  let expiresAt = 0;
  const f = fixture({ upload() {
    expiresAt = Date.now() + 2000;
    return Response.json({ id: "e1", content_type: "image/png", url: "/media/e1.png", r2_key: "uploads/e1.png",
      expires_at: new Date(expiresAt).toISOString() });
  }, async write(attempt) {
    if (attempt === 1) await Bun.sleep(Math.max(0, expiresAt - Date.now() + 5));
  } });
  try {
    await f.controller.open(alice);
    f.controller.addAttachments([new File(["media"], "期限付き.png", { type: "image/png" })]);
    const deadline = Date.now() + 1000;
    while (f.controller.state().attachments[0]?.phase !== "ready" && Date.now() < deadline) await Bun.sleep(1);
    expect(f.controller.state().attachments[0]?.phase).toBe("ready");
    await f.controller.send();
    expect(f.counts().posts).toBe(0);
    expect(f.controller.state()).toMatchObject({ sending: false, uncertain: false, canSend: false });
    expect(f.controller.state().error).toContain("期限が切れた");
    expect(f.controller.state().attachments[0].phase).toBe("expired");
  } finally { f.close(); }
});
