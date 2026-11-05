import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import type { TalkContact } from "../src/api.ts";

const session = { hostUrl: "https://talk.example", product: "yurume" as const,
  accessToken: "local-account", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const peer: TalkContact = { type: "user", ap_id: "https://peer.example/users/buddy", preferred_username: "buddy",
  name: "Buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const request = { id: "https://peer.example/objects/request", sender: { ...peer, username: "buddy" },
  content: "Hello", created_at: "2026-11-05T00:00:00Z" };
const originalFetch = globalThis.fetch;
const subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; });
function subject() {
  const c = createTalkController({ session, refreshHome: async () => {}, observedMessageIds: () => [] });
  subjects.push(c); return c;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function transport(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let pending = [request];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.accessToken}`);
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const result = handler?.(url, init); if (result) return result;
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: pending });
    if (url.pathname === "/api/dm/requests/reject-pending") { pending = []; return Response.json({ success: true }); }
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: peer });
    if (url.pathname.endsWith("/read-observed/init")) return observedInitAck();
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [], has_more: false });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  return calls;
}

test("requests open the canonical peer without accepting, and back restores the inbox and drafts", async () => {
  const calls = transport(), c = subject();
  await c.open(peer); c.setDraft("keep my draft");
  calls.length = 0;
  await c.showRequests();
  expect(c.state().selected).toBeUndefined();
  expect(c.state().requests?.items).toMatchObject([{ id: request.id, sender: { ap_id: peer.ap_id }, content: "Hello" }]);
  await c.openRequest(c.state().requests!.items[0]!);
  expect(c.state().selected?.ap_id).toBe(peer.ap_id);
  expect(c.state().content).toBe("keep my draft");
  expect(calls.filter(x => x.method === "POST").map(x => x.path))
    .toEqual([`/api/dm/user/${encodeURIComponent(peer.ap_id)}/read-observed/init`]);
  c.back();
  await Promise.resolve();
  expect(c.state().requests?.visible).toBe(true);
  expect(c.state().selected).toBeUndefined();
});

test("reject requires a current confirmation and posts exact sender, then reconciles the real list", async () => {
  const calls = transport(), c = subject();
  await c.showRequests();
  const item = c.state().requests!.items[0]!;
  await c.rejectRequest();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(0);
  c.confirmRejectRequest(item); c.cancelRejectRequest();
  await c.rejectRequest();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(0);
  c.confirmRejectRequest({ ...item, sender: { ...item.sender, ap_id: "other" } });
  await c.rejectRequest();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(0);
  c.confirmRejectRequest(item);
  await c.rejectRequest();
  const posts = calls.filter(x => x.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.path).toBe("/api/dm/requests/reject-pending");
  expect(JSON.parse(posts[0]!.body!)).toEqual({ sender_ap_id: peer.ap_id, block: false });
  expect(c.state().requests?.items).toHaveLength(0);
  expect(calls.filter(x => x.path === "/api/dm/requests")).toHaveLength(2);
});

test("an explicit conversation retry preserves the request-inbox back destination", async () => {
  let fail = true;
  transport(url => url.pathname.endsWith("/read-observed/init") && fail
    ? Response.json({ error: "unavailable" }, { status: 503 }) : undefined);
  const c = subject(); await c.showRequests();
  await c.openRequest(c.state().requests!.items[0]!);
  expect(c.state().error).not.toBe("");
  c.setDraft("keep during retry");
  fail = false; await c.reload();
  expect(c.state().error).toBe("");
  expect(c.state().content).toBe("keep during retry");
  c.back();
  expect(c.state().requests?.visible).toBe(true);
});

test("failed list is not empty success and only explicit refresh recovers", async () => {
  let fail = true;
  const calls = transport(url => url.pathname === "/api/dm/requests" && fail
    ? Response.json({ error: "unavailable" }, { status: 503 }) : undefined);
  const c = subject(); await c.showRequests();
  expect(c.state().requests?.error).not.toBe("");
  expect(c.state().requests?.needsRefresh).toBe(true);
  expect(calls).toHaveLength(1);
  fail = false; await c.refreshRequests();
  expect(c.state().requests?.error).toBe("");
  expect(c.state().requests?.items).toHaveLength(1);
});

test("lost reject ACK never retries the POST and reconciles before another destructive action", async () => {
  let lost = true, present = true;
  const calls = transport(url => {
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: present ? [request] : [] });
    if (url.pathname === "/api/dm/requests/reject-pending" && lost) { present = false; return new Response("broken", { status: 200 }); }
  });
  const c = subject(); await c.showRequests();
  const item = c.state().requests!.items[0]!;
  c.confirmRejectRequest(item); await c.rejectRequest();
  expect(c.state().requests?.needsRefresh).toBe(true);
  expect(c.state().requests?.error).not.toBe("");
  c.confirmRejectRequest(item); await c.rejectRequest();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(1);
  lost = false; await c.refreshRequests();
  expect(c.state().requests?.items).toHaveLength(0);
  c.confirmRejectRequest(item); await c.rejectRequest();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(1);
});

test("old hosts and pending conflicts never use legacy rejection or retry a mutation", async () => {
  for (const status of [404, 409]) {
    const calls = transport(url => url.pathname === "/api/dm/requests/reject-pending"
      ? Response.json({ error: "not available" }, { status }) : undefined);
    const c = subject(); await c.showRequests();
    const item = c.state().requests!.items[0]!;
    c.confirmRejectRequest(item); await c.rejectRequest();
    expect(c.state().requests?.needsRefresh).toBe(true);
    expect(c.state().requests?.error).toContain(status === 404 ? "更新が必要" : "状態が変わりました");
    c.confirmRejectRequest(item); await c.rejectRequest();
    expect(calls.filter(x => x.method === "POST")).toHaveLength(1);
    expect(calls.some(x => x.path === "/api/dm/requests/reject")).toBe(false);
  }
});

test("back, account ABA and disposal abort a held list and never publish its stale payload", async () => {
  for (const action of ["back", "ABA", "dispose"]) {
    const held = deferred<Response>(), entered = deferred<void>(); let signal: AbortSignal | undefined;
    transport((url, init) => { if (url.pathname === "/api/dm/requests") { signal = init?.signal ?? undefined; entered.resolve(); return held.promise; } });
    const c = subject(), work = c.showRequests(); await entered.promise;
    if (action === "back") c.back();
    if (action === "ABA") { c.updateSession({ ...session, accessToken: "other" }); c.updateSession(session); }
    if (action === "dispose") c.dispose();
    expect(signal?.aborted).toBe(true);
    held.resolve(Response.json({ requests: [request] })); await work;
    expect(c.state().requests?.visible ?? false).toBe(false);
    expect(c.state().requests?.items ?? []).toHaveLength(0);
  }
});

test("stale contact lookup cannot navigate after a manual conversation or back", async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  const calls = transport(url => { if (url.pathname.startsWith("/api/dm/contact/")) { entered.resolve(); return held.promise; } });
  const c = subject(); await c.showRequests();
  const work = c.openRequest(c.state().requests!.items[0]!); await entered.promise;
  const other = { ...peer, ap_id: "other-peer", name: "Other" };
  await c.open(other);
  held.resolve(Response.json({ contact: peer })); await work;
  expect(c.state().selected).toEqual(other);
  expect(calls.filter(x => x.path === `/api/dm/user/${encodeURIComponent(peer.ap_id)}/messages`)).toHaveLength(0);
});

test("the same sender can retain an older request after the current conversation was rejected", async () => {
  const older = { ...request, id: "older-message", content: "older conversation" };
  let rejected = false;
  const calls = transport(url => {
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: rejected ? [older] : [request, older] });
    if (url.pathname === "/api/dm/requests/reject-pending") { rejected = true; return Response.json({ success: true }); }
  });
  const c = subject(); await c.showRequests();
  expect(c.state().requests?.items).toHaveLength(2);
  c.confirmRejectRequest(c.state().requests!.items[1]!); await c.rejectRequest();
  expect(c.state().requests?.items.map(x => x.id)).toEqual([older.id]);
  expect(calls.filter(x => x.method === "POST")).toHaveLength(1);
});

test("malformed requests are errors, nullable content is valid and mismatched contact cannot open", async () => {
  for (const requests of [null, [{ ...request, sender: { ...request.sender, ap_id: " bad" } }], [{ ...request, id: "x".repeat(2049) }]]) {
    transport(url => url.pathname === "/api/dm/requests" ? Response.json({ requests }) : undefined);
    const c = subject(); await c.showRequests();
    expect(c.state().requests?.needsRefresh).toBe(true);
    expect(c.state().requests?.error).not.toBe("");
  }
  const calls = transport(url => {
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: [{ ...request, content: null, created_at: null }] });
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: { ...peer, ap_id: "wrong" } });
  });
  const c = subject(); await c.showRequests();
  expect(c.state().requests?.items[0]?.content).toBeNull();
  await c.openRequest(c.state().requests!.items[0]!);
  expect(c.state().requests?.error).not.toBe("");
  expect(c.state().selected).toBeUndefined();
  expect(calls.filter(x => x.method === "POST")).toHaveLength(0);
});

test("navigation while rejecting keeps the result unknown and an old ACK cannot affect a new view", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let signal: AbortSignal | undefined;
  const calls = transport((url, init) => {
    if (url.pathname === "/api/dm/requests/reject-pending") { signal = init?.signal ?? undefined; entered.resolve(); return held.promise; }
  });
  const c = subject(); await c.showRequests();
  c.confirmRejectRequest(c.state().requests!.items[0]!);
  const work = c.rejectRequest(); await entered.promise;
  c.back();
  expect(signal?.aborted).toBe(true);
  await c.open(peer); c.setDraft("new view draft");
  held.resolve(Response.json({ success: true })); await work;
  expect(c.state().selected).toEqual(peer);
  expect(c.state().content).toBe("new view draft");
  expect(c.state().requests).toBeUndefined();
  expect(calls.filter(x => x.path === "/api/dm/requests/reject-pending")).toHaveLength(1);
});

test("an unresolved send to that peer cannot be deleted through request rejection", async () => {
  const calls = transport((url, init) => url.pathname.endsWith("/messages") && init?.method === "POST"
    ? new Response("unknown ACK") : undefined);
  const c = subject(); await c.open(peer); c.setDraft("unsent or sent?"); await c.send();
  expect(c.state().uncertain).toBe(true);
  await c.showRequests();
  c.confirmRejectRequest(c.state().requests!.items[0]!); await c.rejectRequest();
  expect(c.state().requests?.confirmation).toBeUndefined();
  expect(c.state().requests?.error).toContain("送信結果");
  expect(calls.filter(x => x.path === "/api/dm/requests/reject-pending")).toHaveLength(0);
});
