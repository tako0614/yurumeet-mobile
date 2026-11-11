import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkRecoveryStore, type TalkRecoveryDraft } from "../src/talk-recovery.ts";
import { createTalkController } from "../src/talk-controller.ts";
import { observedInitAck } from "./talk-read-fixture.ts";

const scope = { product: "yurume" as const, hostUrl: "https://expiry.example", actorApId: "me" };
const draft: TalkRecoveryDraft = { contact: { type: "user", apId: "alice" }, content: "次の下書き", attachments: [],
  sendState: "uncertain", intent: { attemptId: "original-local-attempt", content: "結果不明の元本文", attachments: [] } };
function secureStore() {
  const values = new Map<string, string>();
  let mutations = 0;
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); },
    async set(key, raw) { mutations++; values.set(key, raw); }, async delete(key) { mutations++; values.delete(key); } };
  return { store, mutations: () => mutations };
}

test("valid expired work can be reviewed without renewal, then explicitly restored with uncertain intent intact", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11);
  const recovery = createTalkRecoveryStore({ store: f.store, scope, now: () => now });
  await recovery.save([draft]); now += 7 * 86400_000;
  await expect(recovery.load()).rejects.toMatchObject({ code: "expired" });
  const before = f.mutations();
  const review = await recovery.reviewExpired();
  expect(review.drafts).toEqual([draft]);
  expect(f.mutations()).toBe(before);
  await expect(recovery.load()).rejects.toMatchObject({ code: "expired" });
  await review.restore();
  expect(await recovery.load()).toEqual([draft]);
});


test("the real controller recovers expired work only after review and never replays its unknown send", async () => {
  const f = secureStore(); let now = Date.now(), posts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    if (request.method === "GET" && path.endsWith("/messages")) return Response.json({ messages: [] });
    if (request.method === "POST" && path.endsWith("/messages")) { posts++; return new Response("synthetic unknown", { status: 503 }); }
    throw new Error("Unexpected expiry fixture request");
  } });
  const session = { product: "yurume" as const, hostUrl: server.url.origin, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const recovery = createTalkRecoveryStore({ store: f.store, scope: { ...scope, hostUrl: session.hostUrl }, now: () => now });
  const create = () => createTalkController({ session, actorApId: "me", recovery, refreshHome: async () => {}, observedMessageIds: () => [] });
  const first = create(); let fresh: ReturnType<typeof create> | undefined;
  const alice = { type: "user" as const, ap_id: "alice", preferred_username: "alice", name: "Alice", icon_url: null,
    last_message: null, last_message_at: null, unread_count: 0 };
  try {
    await first.open(alice); first.setDraft("結果不明の元本文"); await first.send();
    first.setDraft("次の下書き"); await first.flushRecovery(); first.dispose();
    now += 7 * 86400_000;
    fresh = create(); await fresh.open(alice); await fresh.flushRecovery();
    expect(fresh.state().recovery).toMatchObject({ ready: false });
    expect(fresh.state().canSend).toBe(false);
    const writes = f.mutations(); await fresh.reviewExpiredRecovery();
    expect(fresh.state().recovery?.expiredDrafts).toMatchObject([{ content: "次の下書き", sendState: "uncertain",
      intent: { content: "結果不明の元本文" } }]);
    expect(f.mutations()).toBe(writes);
    await fresh.restoreExpiredRecovery();
    expect(fresh.state()).toMatchObject({ content: "次の下書き", uncertain: true, canSend: false });
    expect(fresh.state().recovery).toMatchObject({ ready: true, intent: { content: "結果不明の元本文" } });
    expect(posts).toBe(1);
  } finally { first.dispose(); fresh?.dispose(); server.stop(true); }
});


test("an expired preview cannot replace newer stored work or write caller-mutated preview data", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11);
  const recovery = createTalkRecoveryStore({ store: f.store, scope, now: () => now });
  await recovery.save([draft]); now += 7 * 86400_000;
  const stale = await recovery.reviewExpired();
  const newer = { ...draft, content: "別のhandleが保存した新しい本文" };
  await createTalkRecoveryStore({ store: f.store, scope, now: () => now }).save([newer]);
  const before = f.mutations();
  await expect(stale.restore()).rejects.toMatchObject({ code: "changed" });
  expect(f.mutations()).toBe(before);
  expect(await recovery.load()).toEqual([newer]);
  now += 7 * 86400_000;
  const review = await recovery.reviewExpired();
  (review.drafts[0] as { content: string }).content = "previewからの差し替えを拒否";
  await review.restore();
  expect(await recovery.load()).toEqual([newer]);
});


test("fresh, corrupt and wrong-scope snapshots cannot be renewed through expired review", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11), captured = "", override: string | undefined;
  const store: MobileSecureStore = { ...f.store,
    async get(key) { return override ?? f.store.get(key); },
    async set(key, raw) { captured = raw; await f.store.set(key, raw); },
  };
  const recovery = createTalkRecoveryStore({ store, scope, now: () => now }); await recovery.save([draft]);
  const before = f.mutations();
  await expect(recovery.reviewExpired()).rejects.toMatchObject({ code: "changed" });
  now += 7 * 86400_000;
  for (const raw of ["not-json", "null", JSON.stringify({ version: 2 }),
    JSON.stringify({ ...JSON.parse(captured), drafts: [{ ...draft, content: 123 }] })]) {
    override = raw; await expect(recovery.reviewExpired()).rejects.toMatchObject({ code: "invalid-data" });
  }
  override = captured;
  await expect(createTalkRecoveryStore({ store, scope: { ...scope, actorApId: "different" }, now: () => now }).reviewExpired())
    .rejects.toMatchObject({ code: "invalid-data" });
  expect(f.mutations()).toBe(before);
});

test("retiring an account scope invalidates its preview without touching a fresh generation", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11);
  const old = createTalkRecoveryStore({ store: f.store, scope, now: () => now });
  await old.save([draft]); now += 7 * 86400_000;
  const review = await old.reviewExpired(); await old.retire();
  const fresh = createTalkRecoveryStore({ store: f.store, scope, now: () => now });
  const next = { ...draft, content: "新しい世代の下書き" }; await fresh.save([next]);
  const before = f.mutations();
  await expect(review.restore()).rejects.toMatchObject({ code: "retired" });
  expect(f.mutations()).toBe(before);
  expect(await fresh.load()).toEqual([next]);
});

test("renewal revalidates media lifetime while retaining the original unknown-send references", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11);
  const recovery = createTalkRecoveryStore({ store: f.store, scope, now: () => now });
  const upload = { attachment: { type: "Document" as const, mediaType: "image/png", url: "/media/a1.png",
    r2_key: "uploads/a1.png", name: "元の画像.png" }, expiresAt: new Date(now + 60_000).toISOString() };
  const original = { ...draft, attachments: [{ phase: "ready" as const, upload }], intent: { ...draft.intent, attachments: [upload] } };
  await recovery.save([original]); now += 7 * 86400_000;
  const review = await recovery.reviewExpired();
  expect(review.drafts).toMatchObject([{ attachments: [{ phase: "needs-reselection", name: "元の画像.png", reason: "expired" }],
    intent: { content: "結果不明の元本文", attachments: [upload] } }]);
  await review.restore();
  expect(await recovery.load()).toEqual(review.drafts);
});


test("a late expired preview cannot enter a replacement credential epoch", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11), hold = false;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const store: MobileSecureStore = { ...f.store, async get(key) {
    const value = await f.store.get(key); if (hold) { hold = false; entered(); await released; } return value;
  } };
  const recovery = createTalkRecoveryStore({ store, scope, now: () => now }); await recovery.save([draft]);
  now += 7 * 86400_000;
  const session = { product: "yurume" as const, hostUrl: scope.hostUrl, accessToken: "synthetic-old",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const controller = createTalkController({ session, actorApId: "me", recovery, refreshHome: async () => {}, observedMessageIds: () => [] });
  try {
    await controller.restoreRecovery(); hold = true;
    const pending = controller.reviewExpiredRecovery(); await started;
    const before = f.mutations(); controller.updateSession({ ...session, accessToken: "synthetic-new" });
    release(); await pending; await controller.restoreExpiredRecovery();
    expect(controller.state().recovery?.expiredDrafts).toBeUndefined();
    expect(controller.state().recovery?.drafts).toEqual([]);
    expect(f.mutations()).toBe(before);
    await expect(recovery.load()).rejects.toMatchObject({ code: "expired" });
  } finally { release(); controller.dispose(); }
});

test("a lost local renewal acknowledgement preserves uncertain content for a normal readback", async () => {
  const f = secureStore(); let now = Date.UTC(2026, 10, 11), loseAck = false;
  const failure = new Error("synthetic saved-but-ACK-lost");
  const store: MobileSecureStore = { ...f.store, async set(key, raw) { await f.store.set(key, raw); if (loseAck) throw failure; } };
  const recovery = createTalkRecoveryStore({ store, scope, now: () => now }); await recovery.save([draft]);
  now += 7 * 86400_000; const review = await recovery.reviewExpired(); loseAck = true;
  await expect(review.restore()).rejects.toMatchObject({ code: "storage", cause: failure });
  expect(await recovery.load()).toEqual([draft]);
  const before = f.mutations();
  await expect(review.restore()).rejects.toMatchObject({ code: "changed" });
  expect(f.mutations()).toBe(before);
});
