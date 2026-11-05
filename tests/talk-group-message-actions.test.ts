import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

const session = { hostUrl: "https://group-actions.example", product: "yurume" as const, accessToken: "synthetic-account", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const me = session.hostUrl + "/ap/users/me", group: TalkContact = { type: "community", ap_id: session.hostUrl + "/ap/groups/opaque%2Fgroup", preferred_username: "friends", name: "Friends", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const mine: TalkMessage = { id: session.hostUrl + "/objects/opaque%2Fone", content: "Original", created_at: "2026-11-05T00:00:00Z", sender: { ap_id: me, preferred_username: "me", name: "Me" } };
const rev = "group-message-v1:" + "a".repeat(64), nextRev = "group-message-v1:" + "b".repeat(64);
const path = `/api/communities/${encodeURIComponent(group.ap_id)}/messages/${encodeURIComponent(mine.id)}`;
const originalFetch = globalThis.fetch, subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function subject() {
  const c = createTalkController({ session, actorApId: me, refreshHome: async () => {}, observedMessageIds: () => [], receive: { isForeground: () => true, schedule: () => () => {} } });
  subjects.push(c); return c;
}
function transport(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  let current = { ...mine }, revision = rev;
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-account");
    calls.push({ path: url.pathname, method: init?.method ?? "GET" });
    expect(url.pathname.startsWith("/api/dm/messages/")).toBe(false);
    const handled = handler?.(url, init); if (handled) return handled;
    if (url.pathname.endsWith("/read-observed/init")) return observedInitAck();
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [current], has_more: false });
    if (url.pathname === path) {
      if (!init?.method || init.method === "GET") return Response.json({ community_ap_id: group.ap_id, message: current, revision });
      if (init.method === "PATCH") {
        expect(new Headers(init.headers).get("if-match")).toBe(JSON.stringify(revision));
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
        const content = JSON.parse(String(init.body)).content.trim(); current = { ...current, content }; revision = nextRev;
        return Response.json({ success: true, community_ap_id: group.ap_id, message: { id: mine.id, content, updated_at: "2026-11-05T00:00:01Z" }, revision });
      }
    }
    throw Error("Unexpected path " + url.pathname);
  }) as typeof fetch;
  return { calls, setCurrent(content: string, author = me) { current = { ...mine, content, sender: { ...mine.sender, ap_id: author } }; revision = nextRev; } };
}

test("Group author edit uses the community route and current revision without touching compose", async () => {
  const t = transport(), c = subject(); await c.open(group); c.setDraft("Compose draft");
  await c.beginMessageEdit(mine.id); expect(c.state().messageAction?.kind).toBe("edit");
  c.setMessageEditContent(" Updated group body "); await c.saveMessageEdit();
  expect(c.state().messageAction).toBeUndefined(); expect(c.state().messages[0]?.content).toBe("Updated group body");
  expect(c.state().content).toBe("Compose draft"); expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("Group edit keeps newer input after an in-flight save ACK", async () => {
  const entered = deferred<void>(), held = deferred<Response>();
  const t = transport((url, init) => { if (url.pathname === path && init?.method === "PATCH") { entered.resolve(); return held.promise; } });
  const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id);
  expect(c.state().messageAction).toBeDefined();
  c.setMessageEditContent("Submitted"); const work = c.saveMessageEdit(); await entered.promise;
  c.setMessageEditContent("Newer draft"); held.resolve(Response.json({ success: true, community_ap_id: group.ap_id, message: { id: mine.id, content: "Submitted", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev })); await work;
  expect(c.state().messageAction?.content).toBe("Newer draft"); expect(c.state().messageAction?.canSave).toBe(true);
  expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

for (const failure of ["unknown ACK", "conflict", "wrong community ACK"] as const) {
  test(`Group ${failure} preserves the draft and requires explicit one-message reconciliation`, async () => {
    let wrote = false;
    const t = transport((url, init) => {
      if (url.pathname !== path || init?.method !== "PATCH") return;
      wrote = true;
      if (failure === "conflict") { t.setCurrent("Other device"); return Response.json({ error: "message_changed" }, { status: 409 }); }
      t.setCurrent("Submitted");
      return failure === "unknown ACK" ? new Response("broken ACK")
        : Response.json({ success: true, community_ap_id: "other-group", message: { id: mine.id, content: "Submitted", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev });
    });
    const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Submitted");
    await c.saveMessageEdit(); expect(wrote).toBe(true); expect(c.state().messageAction?.needsReadback).toBe(true);
    expect(c.state().messageAction?.content).toBe("Submitted");
    await c.saveMessageEdit(); expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
    await c.reconcileMessageAction();
    if (failure === "conflict") {
      expect(c.state().messageAction?.serverContent).toBe("Other device"); expect(c.state().messageAction?.content).toBe("Submitted");
      expect(c.state().messageAction?.canSave).toBe(true);
    } else expect(c.state().messageAction).toBeUndefined();
    expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
  });
}

test("an unsupported group GET or revoked membership cannot be treated as a deleted message or trigger PATCH", async () => {
  let status = 404;
  const t = transport((url, init) => { if (url.pathname === path && !init?.method) return Response.json({ error: "unsupported or unreadable" }, { status }); });
  const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id);
  expect(c.state().messageAction?.needsReadback).toBe(true); expect(c.state().messageAction?.unavailable).toBe(false);
  expect(c.state().messages).toHaveLength(1);
  status = 403; await c.reconcileMessageAction(); expect(c.state().messageAction?.needsReadback).toBe(true);
  expect(c.state().messageAction?.unavailable).toBe(false);
  await c.saveMessageEdit(); expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(0);
  c.cancelMessageAction(); expect(c.state().messageAction).toBeUndefined();
});

test("Group supported absence leaves an unsaved edit draft available to copy/cancel", async () => {
  let gone = false;
  const t = transport((url, init) => { if (gone && url.pathname === path && !init?.method) return Response.json({ error: "owned_group_message_not_found", code: "owned_group_message_not_found" }, { status: 404 }); });
  const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Keep my text");
  gone = true; await c.reconcileMessageAction();
  expect(c.state().messageAction?.unavailable).toBe(true); expect(c.state().messageAction?.content).toBe("Keep my text");
  expect(c.state().messages).toHaveLength(0); expect(c.state().messageAction?.canCancel).toBe(true);
  expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(0);
});

test("a delayed Group write ACK remains in its conversation and cannot cross an account switch", async () => {
  const entered = deferred<void>(), held = deferred<Response>(); let signal: AbortSignal | undefined;
  const t = transport((url, init) => { if (url.pathname === path && init?.method === "PATCH") { signal = init.signal ?? undefined; entered.resolve(); return held.promise; } });
  const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Old account draft");
  const work = c.saveMessageEdit(); await entered.promise; c.updateSession({ ...session, accessToken: "another-synthetic-account" });
  expect(signal?.aborted).toBe(true);
  held.resolve(Response.json({ success: true, community_ap_id: group.ap_id, message: { id: mine.id, content: "Old account draft", updated_at: "2026-11-05T00:00:01Z" }, revision: nextRev })); await work;
  expect(c.state().messageAction).toBeUndefined(); expect(c.state().messages).toHaveLength(0); expect(c.state().selected).toBeUndefined();
  expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});

test("Group actions cannot edit another author or invoke the DM-only delete endpoint", async () => {
  const t = transport(), c = subject(); await c.open(group);
  await c.beginMessageDelete(mine.id); expect(c.state().messageAction).toBeUndefined();
  t.setCurrent("Another author's body", session.hostUrl + "/ap/users/other"); c.foregroundChanged(); await Bun.sleep(0);
  await c.beginMessageEdit(mine.id); expect(c.state().messageAction).toBeUndefined();
  expect(t.calls.filter(x => x.path === path)).toHaveLength(0);
});

test("a definitive Group edit denial leaves the text recoverable and lets the user close the editor", async () => {
  const t = transport((url, init) => { if (url.pathname === path && init?.method === "PATCH") return Response.json({ error: "Not a community member" }, { status: 403 }); });
  const c = subject(); await c.open(group); await c.beginMessageEdit(mine.id); c.setMessageEditContent("Keep this draft");
  await c.saveMessageEdit();
  expect(c.state().messageAction?.content).toBe("Keep this draft"); expect(c.state().messageAction?.needsReadback).toBe(true);
  expect(c.state().messageAction?.canSave).toBe(false); expect(c.state().messageAction?.canCancel).toBe(true);
  c.cancelMessageAction(); expect(c.state().messageAction).toBeUndefined();
  expect(c.state().messages[0]?.content).toBe("Original"); expect(t.calls.filter(x => x.method === "PATCH")).toHaveLength(1);
});
