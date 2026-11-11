import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkController } from "../src/talk-controller.ts";
import { createTalkRecoveryStore, type TalkRecoveryDraft } from "../src/talk-recovery.ts";
import { createTalkRecoveryAccounts } from "../src/talk-recovery-account.ts";

const scope = { product: "yurume" as const, hostUrl: "https://invalid-recovery.example", actorApId: "me" };
const draft: TalkRecoveryDraft = { contact: { type: "user", apId: "alice" }, content: "保持する本文", attachments: [], sendState: "draft" };
function fixture(now?: () => number) {
  const values = new Map<string, string>();
  let mutations = 0, failRead = false, failDelete = false, loseDeleteAck = false;
  const store: MobileSecureStore = { kind: "secure",
    async get(key) { if (failRead) throw new Error("synthetic storage read failure"); return values.get(key); },
    async set(key, raw) { mutations++; values.set(key, raw); },
    async delete(key) {
      if (failDelete) throw new Error("synthetic storage delete failure");
      mutations++; values.delete(key);
      if (loseDeleteAck) throw new Error("synthetic lost delete acknowledgement");
    },
  };
  const recovery = createTalkRecoveryStore({ store, scope, now });
  async function corrupt() {
    await recovery.save([draft]);
    const [key, raw] = [...values][0];
    values.set(key, JSON.stringify({ ...JSON.parse(raw), drafts: [{ ...draft, content: 123 }] }));
    return key;
  }
  return { values, store, recovery, corrupt, mutations: () => mutations,
    failRead: (value: boolean) => { failRead = value; }, failDelete: (value: boolean) => { failDelete = value; },
    loseDeleteAck: (value: boolean) => { loseDeleteAck = value; } };
}

test("the actual controller can explicitly discard unchanged corrupt local drafts without signing out or replaying", async () => {
  const f = fixture(), key = await f.corrupt();
  const session = { product: "yurume" as const, hostUrl: scope.hostUrl, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const c = createTalkController({ session, actorApId: "me", recovery: f.recovery, refreshHome: async () => {}, observedMessageIds: () => [] });
  try {
    await c.restoreRecovery(); const raw = f.values.get(key), writes = f.mutations();
    await c.flushRecovery(); await c.flushRecovery();
    expect(c.state().recovery?.ready).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(writes);
    expect(c.state().canSend).toBe(false);
    expect(c.state().recovery?.canReviewInvalid).toBe(true);
    await c.reviewInvalidRecovery();
    expect(c.state().recovery?.invalidDraftReview).toBe(true);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(writes);
    c.cancelInvalidRecoveryReview(); expect(c.state().recovery?.invalidDraftReview).toBe(false);
    expect(f.values.get(key)).toBe(raw);
    await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(c.state().recovery?.ready).toBe(true); expect(c.state().recovery?.drafts).toEqual([]);
    expect(f.values.has(key)).toBe(false); expect(f.mutations()).toBe(writes + 1);
    expect(c.state().canSend).toBe(false);
    await f.recovery.save([draft]); expect(await f.recovery.load()).toEqual([draft]);
  } finally { c.dispose(); }
});

test("valid fresh or expired data, foreign headers, unknown versions and unreadable headers are never discard authority", async () => {
  let now = Date.now(); const f = fixture(() => now);
  await f.recovery.save([draft]);
  const [key, raw] = [...f.values][0], header = JSON.parse(raw), before = f.mutations();
  await expect(f.recovery.reviewInvalid()).rejects.toMatchObject({ code: "changed" });
  now += 7 * 86400_000;
  await expect(f.recovery.reviewInvalid()).rejects.toMatchObject({ code: "changed" });
  for (const invalid of ["not-json", JSON.stringify({ ...header, version: 2 }),
    JSON.stringify({ ...header, scope: "yurumeet:talk-recovery:v1:" + "f".repeat(64) })]) {
    f.values.set(key, invalid);
    await expect(f.recovery.reviewInvalid()).rejects.toMatchObject({ code: "invalid-data" });
    expect(f.values.get(key)).toBe(invalid);
  }
  expect(f.mutations()).toBe(before);
});

test("a confirmation cannot discard a newer valid or different corrupt snapshot", async () => {
  const f = fixture(), key = await f.corrupt(), review = await f.recovery.reviewInvalid();
  const fresh = createTalkRecoveryStore({ store: f.store, scope });
  await fresh.save([{ ...draft, content: "確認後の別保存" }]);
  const latest = f.values.get(key), writes = f.mutations();
  await expect(review.discard()).rejects.toMatchObject({ code: "changed" });
  expect(f.values.get(key)).toBe(latest); expect(f.mutations()).toBe(writes);
  expect(await fresh.load()).toEqual([{ ...draft, content: "確認後の別保存" }]);
  await f.corrupt(); const nextReview = await f.recovery.reviewInvalid();
  const different = JSON.stringify({ ...JSON.parse(f.values.get(key)!), drafts: [false] });
  f.values.set(key, different); const before = f.mutations();
  await expect(nextReview.discard()).rejects.toMatchObject({ code: "changed" });
  expect(f.values.get(key)).toBe(different); expect(f.mutations()).toBe(before);
});

test("failed reads or deletes preserve the snapshot and require successful explicit recovery", async () => {
  const f = fixture(), key = await f.corrupt(), raw = f.values.get(key), before = f.mutations();
  f.failRead(true); await expect(f.recovery.reviewInvalid()).rejects.toMatchObject({ code: "storage" });
  f.failRead(false); const review = await f.recovery.reviewInvalid();
  f.failRead(true); await expect(review.discard()).rejects.toMatchObject({ code: "storage" });
  f.failRead(false); f.failDelete(true);
  await expect(review.discard()).rejects.toMatchObject({ code: "storage" });
  expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
  f.failDelete(false); await (await f.recovery.reviewInvalid()).discard();
  expect(await f.recovery.load()).toBeNull(); expect(f.mutations()).toBe(before + 1);
});

test("retirement invalidates old confirmation without deleting a fresh generation", async () => {
  const f = fixture(); await f.corrupt(); const review = await f.recovery.reviewInvalid();
  await f.recovery.retire();
  const fresh = createTalkRecoveryStore({ store: f.store, scope }); await fresh.save([draft]);
  const before = f.mutations();
  await expect(review.discard()).rejects.toMatchObject({ code: "retired" });
  expect(f.mutations()).toBe(before); expect(await fresh.load()).toEqual([draft]);
});

test("the real account envelope deletes only the selected actor/API payload and keeps other account rows", async () => {
  const f = fixture(), accounts = createTalkRecoveryAccounts({ store: f.store });
  const row = { id: "saved_account_A_001", product: "yurume" as const, hostUrl: scope.hostUrl };
  const first = accounts.bind(row, scope), otherApi = accounts.bind(row, { ...scope, apiBaseUrl: scope.hostUrl + "/other-api" });
  const otherActor = accounts.bind(row, { ...scope, actorApId: "other-actor" });
  const second = accounts.bind({ ...row, id: "saved_account_B_002" }, scope);
  await first.save([draft]); await otherApi.save([{ ...draft, content: "他のAPI" }]);
  await otherActor.save([{ ...draft, content: "他のactor" }]); await second.save([{ ...draft, content: "他のrow" }]);
  const [rowKey, rowRaw] = [...f.values].find(([, raw]) => Array.isArray(JSON.parse(raw).entries))!;
  const envelope = JSON.parse(rowRaw), data = JSON.parse(envelope.entries[0][1]);
  envelope.entries[0][1] = JSON.stringify({ ...data, drafts: [{ ...draft, content: 123 }] });
  f.values.set(rowKey, JSON.stringify(envelope));
  await (await first.reviewInvalid()).discard();
  expect(await first.load()).toBeNull();
  expect(await otherApi.load()).toEqual([{ ...draft, content: "他のAPI" }]);
  expect(await otherActor.load()).toEqual([{ ...draft, content: "他のactor" }]);
  expect(await second.load()).toEqual([{ ...draft, content: "他のrow" }]);
  const saved = { accounts: [{ ...row, lastUsedAt: "2026-11-11T00:00:00Z" }] };
  expect(await accounts.pendingCleanup(saved)).toEqual([]);
  await accounts.bind(row, scope).save([draft]); expect(await first.load()).toEqual([draft]);
});

test("a late confirmation read cannot revive an old actor's recovery operation", async () => {
  const f = fixture(), key = await f.corrupt(), raw = f.values.get(key), before = f.mutations();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), released = new Promise<void>(done => { release = done; });
  const session = { product: "yurume" as const, hostUrl: scope.hostUrl, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const c = createTalkController({ session, actorApId: "me", refreshHome: async () => {}, observedMessageIds: () => [], recovery: { ...f.recovery,
    async reviewInvalid() { const review = await f.recovery.reviewInvalid(); enter(); await released; return review; } } });
  let pending: Promise<void> | undefined;
  try {
    await c.restoreRecovery(); pending = c.reviewInvalidRecovery(); await entered;
    c.updateActor("other-actor"); release(); await pending; await c.discardInvalidRecovery();
    expect(c.state().recovery?.invalidDraftReview).toBe(false);
    expect(f.values.get(key)).toBe(raw); expect(f.mutations()).toBe(before);
  } finally { release(); await pending; c.dispose(); }
});

test("expired corrupt contents require an explicit invalid-data review rather than renewal", async () => {
  let now = Date.now(); const f = fixture(() => now), key = await f.corrupt(); now += 7 * 86400_000;
  const session = { product: "yurume" as const, hostUrl: scope.hostUrl, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const c = createTalkController({ session, actorApId: "me", recovery: f.recovery, refreshHome: async () => {}, observedMessageIds: () => [] });
  try {
    await c.restoreRecovery(); expect(c.state().recovery?.canReviewExpired).toBe(true);
    await c.reviewExpiredRecovery(); expect(c.state().recovery?.ready).toBe(false);
    expect(c.state().recovery?.canReviewInvalid).toBe(true); expect(c.state().recovery?.canReviewExpired).toBe(false);
    const before = f.mutations(); await c.reviewInvalidRecovery(); expect(f.mutations()).toBe(before);
    await c.discardInvalidRecovery(); expect(f.values.has(key)).toBe(false); expect(c.state().recovery?.ready).toBe(true);
  } finally { c.dispose(); }
});

test("a lost delete acknowledgement stays blocked until an explicit read confirms the current local snapshot", async () => {
  const f = fixture(), key = await f.corrupt();
  f.loseDeleteAck(true);
  const session = { product: "yurume" as const, hostUrl: scope.hostUrl, accessToken: "synthetic-local-only",
    tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const c = createTalkController({ session, actorApId: "me", recovery: f.recovery, refreshHome: async () => {}, observedMessageIds: () => [] });
  try {
    await c.restoreRecovery(); await c.reviewInvalidRecovery(); await c.discardInvalidRecovery();
    expect(f.values.has(key)).toBe(false); expect(c.state().recovery?.ready).toBe(false);
    expect(c.state().recovery?.invalidDraftReview).toBe(false); expect(c.state().recovery?.error).not.toBe("");
    await c.flushRecovery(); expect(c.state().recovery?.ready).toBe(true);
    expect(c.state().recovery?.drafts).toEqual([]); expect(c.state().canSend).toBe(false);
  } finally { c.dispose(); }
});
