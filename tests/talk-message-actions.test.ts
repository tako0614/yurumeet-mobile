import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

const session = { hostUrl: "https://actions.example", product: "yurume" as const, accessToken: "synthetic-account", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const me = session.hostUrl + "/users/me", peer: TalkContact = { type: "user", ap_id: "https://peer.example/users/buddy", preferred_username: "buddy", name: "Buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const mine: TalkMessage = { id: "https://actions.example/objects/opaque%2Fone", content: "Original", created_at: "2026-11-05T00:00:00Z", sender: { ap_id: me, preferred_username: "me", name: "Me" } };
const theirs: TalkMessage = { ...mine, id: "their-message", content: "From buddy", sender: { ap_id: peer.ap_id, preferred_username: "buddy", name: "Buddy" } };
const rev = "dm-v1:" + "a".repeat(64), nextRev = "dm-v1:" + "b".repeat(64);
const path = "/api/dm/messages/" + encodeURIComponent(mine.id);
const originalFetch = globalThis.fetch, subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function subject() {
  const c = createTalkController({ session, actorApId: me, refreshHome: async () => {}, observedMessageIds: () => [],
    receive: { isForeground: () => true, schedule: () => () => {} } });
  subjects.push(c); return c;
}
function transport(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  let current: TalkMessage | undefined = { ...mine }, revision = rev;
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-account");
    calls.push({ path: url.pathname, method: init?.method ?? "GET" });
    const handled = handler?.(url, init); if (handled) return handled;
    if (url.pathname.endsWith("/read-observed/init")) return observedInitAck();
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: current ? [current, theirs] : [theirs], has_more: false });
    if (url.pathname === path) {
      if (!init?.method || init.method === "GET") return current ? Response.json({ message: current, revision })
        : Response.json({ error: "owned_dm_not_found", code: "owned_dm_not_found" }, { status: 404 });
      expect(new Headers(init.headers).get("if-match")).toBe(JSON.stringify(revision));
      if (init.method === "PATCH") {
        const content = JSON.parse(String(init.body)).content.trim(); current = { ...current!, content }; revision = nextRev;
        return Response.json({ success: true, message: { id: mine.id, content, updated_at: "2026-11-05T00:00:01Z" }, revision });
      }
      if (init.method === "DELETE") { current = undefined; return Response.json({ success: true }); }
    }
    throw Error("Unexpected path " + url.pathname);
  }) as typeof fetch;
  return { calls, setCurrent(value: TalkMessage | undefined) { current = value; revision = nextRev; } };
}

test("edit uses a fresh owned revision and keeps the compose draft separate", async () => {
  const { calls } = transport(), c = subject(); await c.open(peer); c.setDraft("compose draft");
  await c.beginMessageEdit(mine.id); c.setMessageEditContent(" Edited ");
  await c.saveMessageEdit();
  expect(c.state().messages.find(x => x.id === mine.id)?.content).toBe("Edited");
  expect(c.state().content).toBe("compose draft"); expect(c.state().messageAction).toBeUndefined();
  expect(calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("a newer edit draft survives an earlier save ACK without another mutation", async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  const { calls } = transport((url, init) => {
    if (url.pathname === path && init?.method === "PATCH") { entered.resolve(); return held.promise; }
  });
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id);
  c.setMessageEditContent("First edit"); const work = c.saveMessageEdit(); await entered.promise;
  c.setMessageEditContent("Newer edit draft");
  held.resolve(Response.json({ success: true, message: { id: mine.id, content: "First edit", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev })); await work;
  expect(c.state().messages.find(x => x.id === mine.id)?.content).toBe("First edit");
  expect(c.state().messageAction?.content).toBe("Newer edit draft");
  expect(c.state().messageAction?.canSave).toBe(true);
  expect(calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("a pre-mutation receive cannot restore an older body after an edit ACK", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let hold = false, signal: AbortSignal | undefined;
  const { calls } = transport((url, init) => {
    if (hold && url.pathname.endsWith("/messages")) { signal = init?.signal ?? undefined; entered.resolve(); return held.promise; }
  });
  const c = subject(); await c.open(peer); hold = true; c.foregroundChanged(); await entered.promise;
  await c.beginMessageEdit(mine.id); expect(signal?.aborted).toBe(true);
  c.setMessageEditContent("Current body"); await c.saveMessageEdit();
  held.resolve(Response.json({ messages: [mine, theirs], has_more: false })); await Bun.sleep(0);
  expect(c.state().messages.find(x => x.id === mine.id)?.content).toBe("Current body");
  expect(calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("lost edit ACK requires explicit per-message readback and never resends", async () => {
  let committed = false;
  const { calls } = transport((url, init) => {
    if (url.pathname !== path) return;
    if (init?.method === "PATCH") { committed = true; return new Response("broken ACK"); }
    if (committed) return Response.json({ message: { ...mine, content: "Committed edit" }, revision: nextRev });
  });
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Committed edit");
  await c.saveMessageEdit(); expect(c.state().messageAction?.needsReadback).toBe(true);
  await c.saveMessageEdit(); expect(calls.filter(x => x.method === "PATCH")).toHaveLength(1);
  await c.reconcileMessageAction();
  expect(c.state().messageAction).toBeUndefined();
  expect(c.state().messages.find(x => x.id === mine.id)?.content).toBe("Committed edit");
});

test("delete confirmation can cancel, and a lost ACK uses supported absence readback", async () => {
  let gone = false;
  const { calls } = transport((url, init) => {
    if (url.pathname !== path) return;
    if (init?.method === "DELETE") { gone = true; return new Response("broken ACK"); }
    if (gone) return Response.json({ error: "owned_dm_not_found", code: "owned_dm_not_found" }, { status: 404 });
  });
  const c = subject(); await c.open(peer); c.setDraft("keep compose");
  await c.beginMessageDelete(mine.id); c.cancelMessageAction();
  expect(calls.filter(x => x.method === "DELETE")).toHaveLength(0);
  await c.beginMessageDelete(mine.id); await c.confirmMessageDelete();
  expect(c.state().messageAction?.needsReadback).toBe(true);
  await c.confirmMessageDelete(); expect(calls.filter(x => x.method === "DELETE")).toHaveLength(1);
  await c.reconcileMessageAction();
  expect(c.state().messageAction).toBeUndefined();
  expect(c.state().messages.map(x => x.id)).toEqual([theirs.id]); expect(c.state().content).toBe("keep compose");
});

test("other authors and Group deletion cannot use the DM-only mutation path", async () => {
  const { calls } = transport(), c = subject(); await c.open(peer);
  await c.beginMessageEdit(theirs.id); await c.beginMessageDelete(theirs.id);
  expect(c.state().messageAction).toBeUndefined();
  await c.open({ ...peer, type: "community" });
  await c.beginMessageDelete(mine.id);
  expect(c.state().messageAction).toBeUndefined(); expect(calls.filter(x => x.path === path)).toHaveLength(0);
});

test("account ABA retires pending mutation state and ignores its late ACK", async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  transport((url, init) => url.pathname === path && init?.method === "PATCH" ? (entered.resolve(), held.promise) : undefined);
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id); c.setMessageEditContent("old actor edit");
  const work = c.saveMessageEdit(); await entered.promise;
  c.updateSession({ ...session, accessToken: "other-account" }); c.updateSession(session); c.updateActor(me);
  held.resolve(Response.json({ success: true, message: { id: mine.id, content: "old actor edit", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev })); await work;
  expect(c.state().messageAction).toBeUndefined(); expect(c.state().messages).toHaveLength(0); expect(c.state().selected).toBeUndefined();
});

test("a changed actor under the same session retires a pending owner read", async () => {
  const held = deferred<Response>(), entered = deferred<void>(); let signal: AbortSignal | undefined;
  transport((url, init) => url.pathname === path ? (signal = init?.signal ?? undefined, entered.resolve(), held.promise) : undefined);
  const c = subject(); await c.open(peer);
  const work = c.beginMessageEdit(mine.id); await entered.promise;
  c.updateActor("another-actor");
  expect(signal?.aborted).toBe(true);
  held.resolve(Response.json({ message: mine, revision: rev })); await work;
  expect(c.state().selected).toBeUndefined(); expect(c.state().messages).toHaveLength(0); expect(c.state().messageAction).toBeUndefined();
});

test("a generic unsupported404 never proves that an uncertain delete completed", async () => {
  let attempted = false;
  const { calls } = transport((url, init) => {
    if (url.pathname !== path) return;
    if (init?.method === "DELETE") { attempted = true; return new Response("unknown ACK"); }
    if (attempted) return Response.json({ error: "unknown route" }, { status: 404 });
  });
  const c = subject(); await c.open(peer); await c.beginMessageDelete(mine.id); await c.confirmMessageDelete();
  await c.reconcileMessageAction();
  expect(c.state().messageAction?.needsReadback).toBe(true);
  expect(c.state().messageAction?.canCancel).toBe(false);
  expect(c.state().messages.map(x => x.id)).toContain(mine.id);
  expect(calls.filter(x => x.method === "DELETE")).toHaveLength(1);
});

test("an uncertain mutation is reconciled by its single message even outside the latest page", async () => {
  let edited = false;
  const { calls } = transport((url, init) => {
    if (url.pathname === path && init?.method === "PATCH") { edited = true; return new Response("unknown ACK"); }
    if (edited && url.pathname.endsWith("/messages")) return Response.json({ messages: [theirs], has_more: true });
    if (edited && url.pathname === path) return Response.json({ message: { ...mine, content: "Older edit" }, revision: nextRev });
  });
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Older edit"); await c.saveMessageEdit();
  await c.reload();
  expect(c.state().messages.map(x => x.id)).not.toContain(mine.id);
  expect(c.state().messageAction?.needsReadback).toBe(true);
  await c.reconcileMessageAction();
  expect(c.state().messageAction).toBeUndefined(); expect(c.state().messages.map(x => x.id)).toEqual([theirs.id]);
  expect(calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("a late mutation ACK updates its own conversation without navigating or touching another draft", async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  const t = transport((url, init) => {
    if (url.pathname === path && init?.method === "PATCH") { t.setCurrent({ ...mine, content: "Old conversation edit" }); entered.resolve(); return held.promise; }
  });
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Old conversation edit");
  const work = c.saveMessageEdit(); await entered.promise;
  c.back(); const other = { ...peer, ap_id: "other-peer", name: "Other" }; await c.open(other); c.setDraft("other draft");
  held.resolve(Response.json({ success: true, message: { id: mine.id, content: "Old conversation edit", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev })); await work;
  expect(c.state().selected).toEqual(other); expect(c.state().content).toBe("other draft"); expect(c.state().messageAction).toBeUndefined();
});

test("ordinary latest receive already adopts another device's same-ID edit and deletion", async () => {
  const t = transport(), c = subject(); await c.open(peer); c.setDraft("compose retained");
  t.setCurrent({ ...mine, content: "Other device's edit" }); c.foregroundChanged(); await Bun.sleep(0);
  expect(c.state().messages.find(x => x.id === mine.id)?.content).toBe("Other device's edit");
  t.setCurrent(undefined); c.foregroundChanged(); await Bun.sleep(0);
  expect(c.state().messages.map(x => x.id)).toEqual([theirs.id]); expect(c.state().content).toBe("compose retained");
});

test("an uncertain own-message change also fences rejection of that peer's pending request", async () => {
  const { calls } = transport((url, init) => {
    if (url.pathname === path && init?.method === "PATCH") return new Response("unknown ACK");
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: [{ id: "pending-incoming", sender: { ...peer, username: "buddy" }, content: "incoming", created_at: null }] });
  });
  const c = subject(); await c.open(peer); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Uncertain edit"); await c.saveMessageEdit();
  c.back(); await c.showRequests();
  c.confirmRejectRequest(c.state().requests!.items[0]!); await c.rejectRequest();
  expect(c.state().requests?.error).toContain("変更結果");
  expect(calls.filter(x => x.path === "/api/dm/requests/reject-pending")).toHaveLength(0);
});

test("deleting one of two adjacent gap anchors keeps their combined interval recoverable", async () => {
  function row(index: number): TalkMessage {
    return { ...mine, id: `message-${String(index).padStart(3, "0")}`, content: `Message ${index}` };
  }
  let latest = 1, deleted = false;
  const target = row(56), targetPath = "/api/dm/messages/" + encodeURIComponent(target.id);
  transport((url, init) => {
    if (url.pathname === targetPath) {
      if (init?.method === "DELETE") { deleted = true; return Response.json({ success: true }); }
      return Response.json({ message: target, revision: rev });
    }
    if (url.pathname.endsWith("/messages")) {
      const before = url.searchParams.get("before");
      if (!before) return Response.json({ messages: [row(latest)], has_more: latest !== 1 });
      const boundary = Number(before.split("message-").at(-1));
      const candidates = Array.from({ length: boundary - 1 }, (_, index) => row(index + 1))
        .filter(message => !deleted || message.id !== target.id);
      return Response.json({ messages: candidates.slice(-50), has_more: candidates.length > 50 });
    }
  });
  const c = subject(); await c.open(peer);
  latest = 56; c.foregroundChanged(); await Bun.sleep(0);
  latest = 106; c.foregroundChanged(); await Bun.sleep(0);
  expect(c.state().gaps.map(gap => gap.beforeId)).toEqual([row(56).id, row(106).id]);
  expect(c.state().messages.map(message => message.id)).toEqual([row(1).id, row(56).id, row(106).id]);
  await c.beginMessageDelete(target.id); await c.confirmMessageDelete();
  expect(c.state().gaps.map(gap => gap.beforeId)).toEqual([row(106).id]);
  for (let step = 0; step < 4 && c.state().gaps.length; step++) await c.loadGap(c.state().gaps[0]!.beforeId);
  expect(c.state().gaps).toHaveLength(0);
  expect(c.state().messages.map(message => message.id)).toEqual(Array.from({ length: 106 }, (_, index) => row(index + 1).id).filter(id => id !== target.id));
});
