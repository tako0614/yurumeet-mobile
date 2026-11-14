import { expect, test } from "bun:test";
import type { MobileSecureStore } from "@takosjp/mobile-kit";
import { createTalkController } from "../src/talk-controller.ts";
import { createTalkRecoveryStore } from "../src/talk-recovery.ts";
import { createTalkRecoveryAccounts } from "../src/talk-recovery-account.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() }; }
function fixture(type: "user" | "community" = "user") {
  const values = new Map<string, string>(), bodies: { content: string }[] = [], preconditions: string[] = [];
  let unknown = false, readFailure = false, writeFailure = false, afterAckFailure = false, conflict = false, unavailable = false, unsupported = false;
  let holdWrite: { enter: () => void; release: Promise<void> } | undefined, holdPatch: { enter: () => void; release: Promise<void> } | undefined;
  let content = "Canonical message", revision = (type === "user" ? "dm-v1:" : "group-message-v1:") + "a".repeat(64), clock = Date.now();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname, host = server.url.origin, actor = host + "/users/me", id = host + "/objects/own", peer = host + "/" + type + "/peer";
    if (path.endsWith("/read-observed/init")) return observedInitAck();
    const message: TalkMessage = { id, content, created_at: "2026-11-11T00:00:00Z", sender: { ap_id: actor, preferred_username: "me", name: "Me" } };
    if (path.endsWith("/messages") && request.method === "GET") return Response.json({ messages: unavailable ? [] : [message], has_more: false });
    const selected = type === "user" ? "/api/dm/messages/" + encodeURIComponent(id) : "/api/communities/" + encodeURIComponent(peer) + "/messages/" + encodeURIComponent(id);
    if (path !== selected) return new Response("unexpected fixture request", { status: 404 });
    if (request.method === "PATCH") {
      preconditions.push(request.headers.get("if-match") ?? "");
      if (conflict || request.headers.get("if-match") !== JSON.stringify(revision)) return Response.json({ error: "conflict" }, { status: 409 });
      const body = await request.json() as { content: string }; bodies.push(body); content = body.content; revision = (type === "user" ? "dm-v1:" : "group-message-v1:") + "b".repeat(64);
      if (holdPatch) { const hold = holdPatch; holdPatch = undefined; hold.enter(); await hold.release; }
      return unknown ? new Response("synthetic ACK lost after fixture write", { status: 503 }) : Response.json({ success: true,
        ...(type === "community" ? { community_ap_id: peer } : {}), message: { id, content, updated_at: "2026-11-11T00:00:01Z" }, revision });
    }
    if (readFailure) return new Response("synthetic canonical failure", { status: 503 });
    if (unsupported) return Response.json({ error: "not_found" }, { status: 404 });
    if (unavailable) return Response.json({ error: type === "user" ? "owned_dm_not_found" : "owned_group_message_not_found", code: type === "user" ? "owned_dm_not_found" : "owned_group_message_not_found" }, { status: 404 });
    return Response.json({ ...(type === "community" ? { community_ap_id: peer } : {}), message, revision });
  } });
  const session = { hostUrl: server.url.origin, product: "yurume" as const, accessToken: "synthetic-local-only", tokenType: "Bearer", createdAt: "2026-11-11T00:00:00Z" };
  const actorApId = session.hostUrl + "/users/me", id = session.hostUrl + "/objects/own";
  const contact: TalkContact = { type, ap_id: session.hostUrl + "/" + type + "/peer", preferred_username: "peer", name: "Peer", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
  const store: MobileSecureStore = { kind: "secure", async get(key) { return values.get(key); }, async set(key, raw) {
    if (holdWrite) { const hold = holdWrite; holdWrite = undefined; hold.enter(); await hold.release; }
    if (writeFailure || afterAckFailure && bodies.length > 0) throw new Error("synthetic storage failure"); values.set(key, raw);
  }, async delete(key) { values.delete(key); } };
  const scope = { product: "yurume" as const, hostUrl: session.hostUrl, actorApId };
  const recovery = createTalkRecoveryStore({ store, scope, now: () => clock });
  const controllers: ReturnType<typeof createTalkController>[] = [];
  return { session, actorApId, id, contact, recovery, store, scope, values, bodies, preconditions,
    async open(port = recovery) { const c = createTalkController({ session, actorApId, recovery: port, refreshHome: async () => {}, observedMessageIds: () => [] }); controllers.push(c); await c.open(contact); return c; },
    unknown: (value: boolean) => { unknown = value; }, failRead: (value: boolean) => { readFailure = value; }, failWrite: (value: boolean) => { writeFailure = value; }, failAfterAck: (value: boolean) => { afterAckFailure = value; },
    conflict: (value: boolean) => { conflict = value; }, unavailable: (value: boolean) => { unavailable = value; }, unsupported: (value: boolean) => { unsupported = value; }, time: (value: number) => { clock = value; },
    holdWrite: (enter: () => void, release: Promise<void>) => { holdWrite = { enter, release }; }, holdPatch: (enter: () => void, release: Promise<void>) => { holdPatch = { enter, release }; },
    close() { controllers.forEach(c => c.dispose()); server.stop(true); },
  };
}

for (const type of ["user", "community"] as const) test(`${type}: actual controller restores unsent editing separately from compose without PATCH`, async () => {
  const f = fixture(type);
  try {
    const c = await f.open(); c.setDraft("新規送信用の下書き"); await c.beginMessageEdit(f.id); c.setMessageEditContent("終了後に戻す編集"); await c.flushRecovery();
    expect((await f.recovery.load())?.[0].edit?.content).toBe("終了後に戻す編集"); c.dispose();
    const next = await f.open(); expect(next.state().content).toBe("新規送信用の下書き"); expect(next.state().messageEditRecovery?.content).toBe("終了後に戻す編集");
    await next.resumeMessageEdit(); expect(next.state().messageAction?.content).toBe("終了後に戻す編集"); expect(next.state().messageAction?.canSave).toBe(true); expect(f.bodies).toHaveLength(0);
  } finally { f.close(); }
});

for (const type of ["user", "community"] as const) test(`${type}: uncertain original and newer edit reconcile with the actual fresh revision without replay`, async () => {
  const f = fixture(type);
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("元の試行"); f.unknown(true); await c.saveMessageEdit();
    c.setMessageEditContent("その後の追加入力"); await c.flushRecovery();
    expect((await f.recovery.load())?.[0].edit).toMatchObject({ content: "その後の追加入力", attempted: { content: "元の試行", draft: "元の試行" } }); c.dispose();
    const next = await f.open(); expect(next.state().messageEditRecovery?.attempted?.content).toBe("元の試行"); expect(f.bodies).toHaveLength(1);
    await next.resumeMessageEdit(); expect(next.state().messageAction).toMatchObject({ content: "その後の追加入力", needsReadback: false, canSave: true }); expect(f.bodies).toHaveLength(1);
    f.unknown(false); await next.saveMessageEdit(); expect(f.bodies.map(x => x.content)).toEqual(["元の試行", "その後の追加入力"]);
    const prefix = type === "user" ? "dm-v1:" : "group-message-v1:";
    expect(f.preconditions).toEqual([JSON.stringify(prefix + "a".repeat(64)), JSON.stringify(prefix + "b".repeat(64))]);
  } finally { f.close(); }
});

test("a matched canonical attempt closes on resume without an extra review gate or PATCH", async () => {
  const f = fixture();
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("保存した元の本文"); f.unknown(true); await c.saveMessageEdit(); c.dispose();
    const next = await f.open(); await next.resumeMessageEdit(); expect(next.state().messageAction).toBeUndefined(); expect(next.state().messageEditRecovery).toBeUndefined(); expect(f.bodies).toHaveLength(1);
    expect(await f.recovery.load()).toEqual([]);
  } finally { f.close(); }
});

test("failed pre-PATCH checkpoint refuses mutation and is recoverable by the existing explicit storage retry", async () => {
  const f = fixture();
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("保存失敗でも残す本文"); f.failWrite(true); await c.saveMessageEdit();
    expect(f.preconditions).toHaveLength(0); expect(c.state().messageAction).toMatchObject({ content: "保存失敗でも残す本文", needsReadback: false, canSave: false });
    expect(c.state().recovery?.error).not.toBe(""); f.failWrite(false); await c.flushRecovery(); await c.saveMessageEdit(); expect(f.bodies.map(x => x.content)).toEqual(["保存失敗でも残す本文"]);
  } finally { f.close(); }
});

test("confirmed edit ACK remains known when the final durable checkpoint fails", async () => {
  const f = fixture();
  try {
    const c = await f.open(); c.setDraft("独立した新規送信下書き"); await c.beginMessageEdit(f.id); c.setMessageEditContent("確定した編集"); f.failAfterAck(true); await c.saveMessageEdit();
    expect(c.state().messageAction).toBeUndefined(); expect(c.state().messages[0].content).toBe("確定した編集"); expect(c.state().recovery?.error).not.toBe(""); await c.saveMessageEdit(); expect(f.bodies).toHaveLength(1);
    f.failAfterAck(false); await c.flushRecovery(); c.dispose(); const next = await f.open(); expect(next.state().messageEditRecovery).toBeUndefined(); expect(next.state().content).toBe("独立した新規送信下書き"); expect(f.bodies).toHaveLength(1);
  } finally { f.close(); }
});

test("pre-PATCH storage wait captures the original attempt while persisting newer input", async () => {
  const f = fixture(), entered = deferred(), released = deferred(); let sending: Promise<void> | undefined;
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("先に保存する編集"); f.holdWrite(entered.resolve, released.promise); sending = c.saveMessageEdit(); await entered.promise;
    expect(f.bodies).toHaveLength(0); c.setMessageEditContent("保存待ちの追加入力"); released.resolve(); await sending;
    expect(f.bodies.map(x => x.content)).toEqual(["先に保存する編集"]); expect(c.state().messageAction?.content).toBe("保存待ちの追加入力");
    expect((await f.recovery.load())?.[0].edit).toMatchObject({ content: "保存待ちの追加入力", baseContent: "先に保存する編集" });
  } finally { released.resolve(); await sending; f.close(); }
});

test("dispose during an in-flight edit preserves its original attempt and newer draft for actual readback", async () => {
  const f = fixture(), entered = deferred(), released = deferred(); let sending: Promise<void> | undefined;
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("応答待ちの元編集"); f.holdPatch(entered.resolve, released.promise); sending = c.saveMessageEdit(); await entered.promise;
    c.setMessageEditContent("終了前の最新編集"); await c.flushRecovery(); c.dispose(); released.resolve(); await sending;
    const next = await f.open(); expect(next.state().messageEditRecovery).toMatchObject({ content: "終了前の最新編集", attempted: { content: "応答待ちの元編集" } });
    await next.resumeMessageEdit(); expect(next.state().messageAction).toMatchObject({ content: "終了前の最新編集", canSave: true }); expect(f.bodies).toHaveLength(1);
  } finally { released.resolve(); await sending; f.close(); }
});

test("a real group CAS conflict has zero effect and needs a fresh canonical read before the next save", async () => {
  const f = fixture("community");
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("競合する編集"); f.conflict(true); await c.saveMessageEdit();
    expect(f.bodies).toHaveLength(0); expect(f.preconditions).toHaveLength(1); expect(c.state().messageAction).toMatchObject({ needsReadback: true, content: "競合する編集" }); await c.saveMessageEdit(); expect(f.preconditions).toHaveLength(1);
    await c.flushRecovery(); c.dispose(); const next = await f.open(); await next.resumeMessageEdit(); f.conflict(false); await next.saveMessageEdit(); expect(f.bodies.map(x => x.content)).toEqual(["競合する編集"]);
  } finally { f.close(); }
});

test("failed and unsupported canonical reads retain unknown editing; only supported absence unlocks cancellation", async () => {
  const f = fixture();
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("不明な元の編集"); f.unknown(true); await c.saveMessageEdit(); c.setMessageEditContent("保護する新入力"); await c.flushRecovery(); c.dispose();
    f.failRead(true); const next = await f.open(); await next.resumeMessageEdit(); expect(next.state().messageAction).toMatchObject({ content: "保護する新入力", needsReadback: true, canSave: false, canCancel: false, originalAttempt: "不明な元の編集" });
    f.failRead(false); f.unsupported(true); await next.reconcileMessageAction(); expect(next.state().messageAction?.canCancel).toBe(false); expect(f.bodies).toHaveLength(1);
    f.unsupported(false); f.unavailable(true); await next.reconcileMessageAction(); expect(next.state().messageAction).toMatchObject({ content: "保護する新入力", unavailable: true, canSave: false, canCancel: true });
  } finally { f.close(); }
});

test("existing expiry review exposes and conditionally restores edit bytes without sending", async () => {
  const f = fixture();
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("期限後にも確認する編集"); await c.flushRecovery(); c.dispose(); f.time(Date.now() + 8 * 86400_000);
    const next = await f.open(); expect(next.state().recovery?.canReviewExpired).toBe(true); expect(next.state().canEditMessages).toBe(false); expect(next.state().canManageMessages).toBe(true);
    await next.reviewExpiredRecovery(); expect(next.state().recovery?.expiredDrafts?.[0].edit?.content).toBe("期限後にも確認する編集"); await next.restoreExpiredRecovery();
    expect(next.state().messageEditRecovery?.content).toBe("期限後にも確認する編集"); await next.resumeMessageEdit(); expect(next.state().messageAction?.canSave).toBe(true); expect(f.bodies).toHaveLength(0);
  } finally { f.close(); }
});

test("raw invalid edit input is retained; extra authority and corrupt bytes are not accepted or replaced", async () => {
  const f = fixture();
  try {
    const c = await f.open(); await c.beginMessageEdit(f.id); c.setMessageEditContent("x".repeat(5001)); await c.flushRecovery(); c.dispose();
    const next = await f.open(); await next.resumeMessageEdit(); expect(next.state().messageAction?.content).toHaveLength(5001); expect(next.state().messageAction?.canSave).toBe(false);
    const saved = (await f.recovery.load())!, before = [...f.values];
    await expect(f.recovery.save([{ ...saved[0], edit: { ...saved[0].edit!, revision: "not-read-authority" } } as never])).rejects.toThrow();
    expect([...f.values]).toEqual(before); expect([...f.values.values()].join("")).not.toContain("synthetic-local-only");
    const key = [...f.values.keys()][0]; next.dispose(); await f.recovery.load(); f.values.set(key, "invalid-json"); const after = await f.open(); await after.flushRecovery(); expect(after.state().recovery?.ready).toBe(false); expect(f.values.get(key)).toBe("invalid-json");
  } finally { f.close(); }
});

test("saved-row retirement includes edit-only snapshots and preserves a fresh same-person row", async () => {
  const f = fixture();
  try {
    const row = { id: "saved_edit_account_A_001", product: "yurume" as const, hostUrl: f.session.hostUrl }, fresh = { ...row, id: "saved_edit_account_B_002" };
    const accounts = createTalkRecoveryAccounts({ store: f.store }), old = accounts.bind(row, f.scope), replacement = accounts.bind(fresh, f.scope);
    const c = await f.open(old); await c.beginMessageEdit(f.id); c.setMessageEditContent("古い保存行の編集"); await c.flushRecovery();
    const next = await f.open(replacement); expect(next.state().messageEditRecovery).toBeUndefined(); await next.beginMessageEdit(f.id); next.setMessageEditContent("新しい保存行の編集"); await next.flushRecovery(); c.dispose();
    await accounts.retire(row); await expect(old.load()).rejects.toThrow(); expect((await replacement.load())?.[0].edit?.content).toBe("新しい保存行の編集");
  } finally { f.close(); }
});

test("old compose-only records stay readable and account epoch changes cannot reuse a persisted editing port", async () => {
  const f = fixture();
  try {
    await f.recovery.save([{ contact: { type: "user", apId: f.contact.ap_id }, content: "従来のcompose入力", attachments: [], sendState: "draft" }]);
    const c = await f.open(); expect(c.state().content).toBe("従来のcompose入力"); await c.beginMessageEdit(f.id); c.setMessageEditContent("旧scopeの編集"); await c.flushRecovery(); const before = [...f.values];
    c.updateActor(f.actorApId + "-other"); await c.beginMessageEdit(f.id); await c.flushRecovery(); expect(c.state().messageAction).toBeUndefined(); expect(c.state().canManageMessages).toBe(false); expect([...f.values]).toEqual(before); expect(f.bodies).toHaveLength(0);
  } finally { f.close(); }
});
