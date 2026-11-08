import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import { createTalkDiscoveryController } from "../src/talk-discovery.ts";
import { createTalkBackAction } from "../src/talk-back.ts";
import { observedInitAck, observedMessageAck } from "./talk-read-fixture.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

const session = { hostUrl: "https://back.example", product: "yurume" as const,
  accessToken: "synthetic-back-session", tokenType: "Bearer", createdAt: "2026-11-08T00:00:00Z" };
const me = session.hostUrl + "/ap/users/me";
const peer: TalkContact = { type: "user", ap_id: "https://peer.example/ap/users/buddy", name: "Buddy",
  preferred_username: "buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const mine: TalkMessage = { id: session.hostUrl + "/ap/objects/back", content: "Original",
  created_at: "2026-11-08T00:00:00Z", sender: { ap_id: me, preferred_username: "me", name: "Me" } };
const request = { id: "https://peer.example/ap/objects/request", sender: { ...peer, username: "buddy" },
  content: "Hello", created_at: "2026-11-08T00:00:00Z" };
const owned = "/api/dm/messages/" + encodeURIComponent(mine.id);
const messages = "/api/dm/user/" + encodeURIComponent(peer.ap_id) + "/messages";
const revision = "dm-v1:" + "a".repeat(64);
const originalFetch = globalThis.fetch, disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); globalThis.fetch = originalFetch; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function transport(intercept?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const calls: { path: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-back-session");
    calls.push({ path: url.pathname, method });
    const result = intercept?.(url, init); if (result) return result;
    if (url.pathname.endsWith("/read-observed/init")) return observedInitAck();
    if (url.pathname.endsWith("/read-observed")) return observedMessageAck(init);
    if (url.pathname === messages && method === "GET") return Response.json({ messages: [mine], has_more: false });
    if (url.pathname === owned && method === "GET") return Response.json({ message: mine, revision });
    if (url.pathname === "/api/dm/requests") return Response.json({ requests: [request] });
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: peer });
    throw Error("Unexpected synthetic HTTP " + method + " " + url.pathname);
  }) as typeof fetch;
  return calls;
}
function subject() {
  const talk = createTalkController({ session, actorApId: me, refreshHome: async () => {},
    observedMessageIds: () => [], receive: { isForeground: () => true, schedule: () => () => {} } });
  const discovery = createTalkDiscoveryController({ session, actorApId: me, onOpen: contact => { void talk.open(contact); } });
  disposers.push(() => { discovery.dispose(); talk.dispose(); });
  return { talk, discovery, back: createTalkBackAction({ talk, discovery, closeDiscovery: () => discovery.close() }) };
}

test("talk Back retains the actual conversation draft without posting it", async () => {
  const calls = transport(), { talk, back } = subject();
  await talk.open(peer); talk.setDraft("Keep compose draft"); await back();
  expect(talk.state().selected).toBeUndefined();
  await talk.open(peer); expect(talk.state().content).toBe("Keep compose draft");
  expect(calls.filter(call => call.path === messages && call.method === "POST")).toHaveLength(0);
});

test("Back closes a cancellable actual editor before leaving its talk", async () => {
  const calls = transport(), { talk, back } = subject();
  await talk.open(peer); talk.setDraft("Keep compose"); await talk.beginMessageEdit(mine.id);
  talk.setMessageEditContent("Unsubmitted edit"); await back();
  expect(talk.state().selected?.ap_id).toBe(peer.ap_id);
  expect(talk.state().messageAction).toBeUndefined();
  expect(talk.state().content).toBe("Keep compose");
  expect(calls.some(call => call.method === "PATCH")).toBe(false);
});

for (const kind of ["edit", "delete"] as const) test(`Back leaves an actual pending ${kind} intact for the same conversation`, async () => {
  const held = deferred<Response>(), entered = deferred<void>();
  const calls = transport((url, init) => {
    if (url.pathname === owned && init?.method === (kind === "edit" ? "PATCH" : "DELETE")) {
      expect(new Headers(init.headers).get("if-match")).toBe(JSON.stringify(revision));
      entered.resolve(); return held.promise;
    }
  });
  const { talk, back } = subject(); await talk.open(peer); talk.setDraft("Keep unrelated compose");
  if (kind === "edit") { await talk.beginMessageEdit(mine.id); talk.setMessageEditContent("Submitted edit"); }
  else await talk.beginMessageDelete(mine.id);
  const pending = kind === "edit" ? talk.saveMessageEdit() : talk.confirmMessageDelete();
  await entered.promise; expect(talk.state().messageAction?.pending).toBe(true);
  await back(); expect(talk.state().selected).toBeUndefined();
  await talk.open(peer);
  expect(talk.state().messageAction).toMatchObject({ kind, pending: true, canCancel: false });
  expect(talk.state().content).toBe("Keep unrelated compose");
  expect(calls.filter(call => call.path === owned && call.method === "GET")).toHaveLength(1);
  expect(calls.filter(call => call.method === (kind === "edit" ? "PATCH" : "DELETE"))).toHaveLength(1);
  held.resolve(Response.json({ error: "synthetic receipt unavailable" }, { status: 503 })); await pending;
  expect(talk.state().messageAction).toMatchObject({ kind, pending: false, needsReadback: true, canCancel: false });
  await back(); expect(talk.state().selected).toBeUndefined();
  expect(calls.filter(call => call.method === (kind === "edit" ? "PATCH" : "DELETE"))).toHaveLength(1);
});

test("Back cancels only request confirmation, then restores the talk list", async () => {
  const calls = transport(), { talk, back } = subject(); await talk.showRequests();
  talk.confirmRejectRequest(talk.state().requests!.items[0]!); await back();
  expect(talk.state().requests?.visible).toBe(true);
  expect(talk.state().requests?.confirmation).toBeUndefined();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  await back(); expect(talk.state().requests?.visible).not.toBe(true);
});

test("Back from a request talk restores its actual inbox rather than the root", async () => {
  transport(); const { talk, back } = subject(); await talk.showRequests();
  await talk.openRequest(talk.state().requests!.items[0]!); await back();
  expect(talk.state().selected).toBeUndefined(); expect(talk.state().requests?.visible).toBe(true);
  await back(); expect(talk.state().requests?.visible).not.toBe(true);
});

test("Back closes actual discovery without discarding its query or doing a read/write", async () => {
  const calls = transport(), { discovery, back } = subject();
  discovery.show(); discovery.setQuery("Retained search"); await back();
  expect(discovery.state()).toMatchObject({ visible: false, query: "Retained search" });
  discovery.show(); expect(discovery.state().query).toBe("Retained search");
  expect(calls).toHaveLength(0);
});
