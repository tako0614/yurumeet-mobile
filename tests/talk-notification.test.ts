import { afterEach, expect, test } from "bun:test";
import { createTalkController } from "../src/talk-controller.ts";
import { talkNotificationRequest } from "../src/talk-notification.ts";
import { talkSessionIdentity } from "../src/talk-session.ts";
import { observedInitAck } from "./talk-read-fixture.ts";
import type { MobilePushNotificationCallbackInput } from "@takosjp/mobile-kit";
import type { TalkContact } from "../src/api.ts";

const session = { hostUrl: "https://talk.example", product: "yurume" as const,
  accessToken: "local-account", tokenType: "Bearer", createdAt: "2026-11-05T00:00:00Z" };
const me = "https://talk.example/users/me";
const event = "https://remote.example/activities/create";
const object = "https://remote.example/objects/message";
const peer: TalkContact = { type: "user", ap_id: "https://peer.example/users/buddy", preferred_username: "buddy",
  name: "Buddy", icon_url: null, last_message: null, last_message_at: null, unread_count: 0 };
const group: TalkContact = { ...peer, type: "community", ap_id: "https://talk.example/groups/room", name: "Room" };
const request = () => talkNotificationRequest({ session, kind: "tapped", notification: { data: { event_id: event, room_id: object } } })!;

const originalFetch = globalThis.fetch;
const subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => { subjects.splice(0).forEach(c => c.dispose()); globalThis.fetch = originalFetch; });
function subject() {
  const c = createTalkController({ session, refreshHome: async () => {}, observedMessageIds: () => [] });
  subjects.push(c);
  return c;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function target(contact = peer, eventId = event) {
  return { event_id: eventId, recipient_ap_id: me, target: { type: contact.type, ap_id: contact.ap_id } };
}
function transport(handler?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined, contact = peer) {
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(session.hostUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.accessToken}`);
    calls.push({ path: url.pathname, method: init?.method ?? "GET" });
    const result = handler?.(url, init);
    if (result) return result;
    if (url.pathname === "/api/dm/notification-target") return Response.json(target(contact, url.searchParams.get("event_id")!));
    if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact });
    if (url.pathname.endsWith("/read-observed/init")) return observedInitAck();
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [], has_more: false });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  return calls;
}

test("only a tapped opaque event captures a session-bound request", () => {
  const input: MobilePushNotificationCallbackInput = { session, kind: "tapped", notification: { data: { event_id: event, room_id: object, sender: "untrusted", url: "https://foreign.example/" } } };
  expect(talkNotificationRequest(input)).toEqual({ sessionKey: talkSessionIdentity(session), eventId: event, objectId: object });
  expect(talkNotificationRequest({ ...input, kind: "received" })).toBeUndefined();
  for (const data of [{ room_id: object }, { event_id: "" }, { event_id: "x".repeat(2049) }, { event_id: event, room_id: 4 }, { event_id: " a" }]) {
    expect(talkNotificationRequest({ ...input, notification: { data } })).toBeUndefined();
  }
});

test("DM and Group taps resolve the event, fetch the actual contact and use the original native open", async () => {
  for (const contact of [peer, group]) {
    const calls = transport((url) => {
      if (url.pathname === "/api/dm/notification-target") {
        expect(url.searchParams.get("event_id")).toBe(event);
        expect(url.searchParams.get("object_id")).toBe(object);
      }
      return undefined;
    }, contact);
    const c = subject();
    await c.openNotification(request(), me);
    expect(c.state().selected).toEqual(contact);
    expect(c.state().notification).toBeUndefined();
    expect(calls[0]?.path).toBe("/api/dm/notification-target");
    expect(calls[1]?.path).toBe(`/api/dm/contact/${encodeURIComponent(contact.ap_id)}`);
    expect(calls.filter(call => call.path.endsWith("/messages"))).toHaveLength(1);
    expect(calls.filter(call => call.method === "POST").map(call => call.path))
      .toEqual([`/api/dm/${contact.type === "user" ? "user" : "community"}/${encodeURIComponent(contact.ap_id)}/read-observed/init`]);
  }
});

test("wrong recipient, event, kind or contact never starts a chat or discards the current draft", async () => {
  for (const body of [{ ...target(), recipient_ap_id: "other" }, { ...target(), event_id: "wrong" },
    { ...target(), target: { type: "post", ap_id: peer.ap_id } }, "contact-mismatch"]) {
    let resolving = false;
    const calls = transport(url => {
      if (!resolving) return;
      if (url.pathname === "/api/dm/notification-target") return Response.json(body === "contact-mismatch" ? target() : body);
      if (url.pathname.startsWith("/api/dm/contact/")) return Response.json({ contact: { ...peer, ap_id: "wrong" } });
    });
    const c = subject();
    await c.open(peer);
    c.setDraft("keep this draft");
    calls.length = 0; resolving = true;
    await c.openNotification(request(), me);
    expect(c.state().selected).toEqual(peer);
    expect(c.state().content).toBe("keep this draft");
    expect(c.state().notification?.error).not.toBe("");
    expect(calls.every(call => call.method === "GET" && !call.path.endsWith("/messages"))).toBe(true);
  }
});

test("unavailable or rejected targets stay usable and retry only on an explicit action", async () => {
  for (const status of [404, 401, 403, 503]) {
    let reject = true;
    const calls = transport(url => url.pathname === "/api/dm/notification-target" && reject
      ? Response.json({ error: "unavailable" }, { status }) : undefined);
    const c = subject();
    await c.openNotification(request(), me);
    expect(c.state().selected).toBeUndefined();
    expect(c.state().notification).toMatchObject({ loading: false });
    expect(c.state().notification?.error).not.toBe("");
    expect(calls).toHaveLength(1);
    reject = false;
    await c.retryNotification();
    expect(c.state().selected).toEqual(peer);
    expect(calls.filter(call => call.path === "/api/dm/notification-target")).toHaveLength(2);
  }
});

test("account ABA and dismissal abort a pending target and ignore late results", async () => {
  for (const retire of ["account", "dismiss", "back", "dispose"] as const) {
    const pending = deferred<Response>();
    const started = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const calls = transport((url, init) => {
      if (url.pathname !== "/api/dm/notification-target") return;
      signal = init?.signal; started.resolve();
      return pending.promise;
    });
    const c = subject();
    const old = c.openNotification(request(), me);
    await started.promise;
    if (retire === "account") { c.updateSession({ ...session, accessToken: "new-local-account" }); c.updateSession(session); }
    else if (retire === "dismiss") c.dismissNotification();
    else if (retire === "back") c.back();
    else c.dispose();
    const canceled = signal?.aborted;
    pending.resolve(Response.json(target()));
    await old;
    expect(canceled).toBe(true);
    expect(c.state().selected).toBeUndefined();
    expect(c.state().notification).toBeUndefined();
    expect(calls).toHaveLength(1);
  }
});

test("the latest tap owns completion and a different-session request never invokes the API", async () => {
  const pending = deferred<Response>(), started = deferred<void>();
  const calls = transport(url => {
    if (url.pathname === "/api/dm/notification-target" && url.searchParams.get("event_id") === event) {
      started.resolve(); return pending.promise;
    }
  });
  const c = subject();
  await c.openNotification({ ...request(), sessionKey: talkSessionIdentity({ ...session, accessToken: "other" }) }, me);
  expect(calls).toHaveLength(0);
  const old = c.openNotification(request(), me);
  await started.promise;
  await c.openNotification({ ...request(), eventId: "new-event" }, me);
  pending.resolve(Response.json(target()));
  await old;
  expect(c.state().selected).toEqual(peer);
  expect(c.state().notification).toBeUndefined();
  expect(calls.filter(call => call.path.startsWith("/api/dm/contact/"))).toHaveLength(1);
});

for (const phase of ["target", "contact"] as const) {
  test(`hiding during notification ${phase} resolution preserves the chat and requires a foreground retry`, async () => {
    let foreground = true, hold = true;
    const pending = deferred<Response>(), started = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const calls = transport((url, init) => {
      if (!hold || (phase === "target" ? url.pathname !== "/api/dm/notification-target" : !url.pathname.startsWith("/api/dm/contact/"))) return;
      hold = false; signal = init?.signal; started.resolve();
      return pending.promise; // Deliberately ignores abort to test the late-response fence too.
    }, group);
    const c = createTalkController({ session, actorApId: me, refreshHome: async () => {}, observedMessageIds: () => [],
      receive: { isForeground: () => foreground, schedule: () => () => {} } });
    subjects.push(c);
    await c.open(peer);
    c.setDraft("Keep the original conversation draft");
    calls.length = 0;
    const opening = c.openNotification(request(), me);
    await started.promise;

    foreground = false;
    c.foregroundChanged();
    pending.resolve(Response.json(phase === "target" ? target(group) : { contact: group }));
    await opening;
    expect(c.state().selected).toEqual(peer);
    expect(c.state().content).toBe("Keep the original conversation draft");
    expect(signal?.aborted).toBe(true);
    expect(c.state().notification).toMatchObject({ loading: false });
    expect(c.state().notification?.error).not.toBe("");
    expect(calls.every(call => call.method === "GET" && !call.path.endsWith("/messages"))).toBe(true);
    const countWhileHidden = calls.length;
    await c.retryNotification();
    expect(calls).toHaveLength(countWhileHidden);

    foreground = true;
    const targetCount = calls.filter(call => call.path === "/api/dm/notification-target").length;
    c.foregroundChanged();
    await Promise.resolve();
    expect(calls.filter(call => call.path === "/api/dm/notification-target")).toHaveLength(targetCount);
    expect(c.state().selected).toEqual(peer);
    await c.retryNotification();
    expect(c.state().selected).toEqual(group);
    expect(c.state().notification).toBeUndefined();
    c.back();
    await c.open(peer);
    expect(c.state().content).toBe("Keep the original conversation draft");
  });
}

test("a hidden target response cannot open a chat before the visibility listener runs", async () => {
  let foreground = true;
  const pending = deferred<Response>(), started = deferred<void>();
  let signal: AbortSignal | null | undefined;
  const calls = transport((url, init) => {
    if (url.pathname !== "/api/dm/notification-target") return;
    signal = init?.signal; started.resolve();
    return pending.promise;
  }, group);
  const c = createTalkController({ session, refreshHome: async () => {}, observedMessageIds: () => [],
    receive: { isForeground: () => foreground, schedule: () => () => {} } });
  subjects.push(c);
  await c.open(peer);
  c.setDraft("Draft before the visibility event");
  calls.length = 0;
  const opening = c.openNotification(request(), me);
  await started.promise;
  foreground = false; // The document state is already hidden; its event has not run yet.
  pending.resolve(Response.json(target(group)));
  await opening;

  expect(c.state().selected).toEqual(peer);
  expect(c.state().content).toBe("Draft before the visibility event");
  expect(c.state().notification).toMatchObject({ loading: false });
  expect(c.state().notification?.error).not.toBe("");
  expect(signal?.aborted).toBe(true);
  expect(calls.map(call => call.path)).toEqual(["/api/dm/notification-target"]);
});

for (const action of ["draft", "edit", "delete"] as const) {
  test(`a notification switch keeps a conversation with only a ${action} message action reachable`, async () => {
    const mine = { id: session.hostUrl + "/objects/owned-message", content: "Original", created_at: "2026-11-05T00:00:00Z",
      sender: { ap_id: me, preferred_username: "me", name: "Me" } };
    const ownedPath = "/api/dm/messages/" + encodeURIComponent(mine.id), revision = "dm-v1:" + "a".repeat(64);
    const held = deferred<Response>(), started = deferred<void>();
    const calls = transport((url, init) => {
      if (url.pathname === ownedPath) {
        if (init?.method === "PATCH" || init?.method === "DELETE") { started.resolve();return held.promise; }
        return Response.json({ message: mine, revision });
      }
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: url.pathname === `/api/dm/user/${encodeURIComponent(peer.ap_id)}/messages` ? [mine] : [], has_more: false });
    }, group);
    const c = createTalkController({ session, actorApId: me, refreshHome: async () => {}, observedMessageIds: () => [],
      receive: { isForeground: () => true, schedule: () => () => {} } });
    subjects.push(c);
    await c.open(peer);
    if (action === "delete") await c.beginMessageDelete(mine.id);
    else { await c.beginMessageEdit(mine.id);c.setMessageEditContent("Retained edit input"); }
    let saving: Promise<void> | undefined;
    if (action !== "draft") {
      saving = action === "edit" ? c.saveMessageEdit() : c.confirmMessageDelete();
      await started.promise;
    }
    try {
      await c.openNotification(request(), me);
      expect(c.state().selected).toEqual(group);
      expect(c.state().content).toBe("");
      // The current home can omit the old contact. This is the actual source
      // used by TalkScreen to offer a return path, not a manual reopen oracle.
      expect(c.state().retainedContacts).toContainEqual(peer);
      await c.open(peer);
      expect(c.state().messageAction).toMatchObject({ kind: action === "delete" ? "delete" : "edit",
        ...(action === "draft" ? { content: "Retained edit input" } : { pending: true }) });
    } finally {
      held.resolve(Response.json({ error: "synthetic original ACK unavailable" }, { status: 503 }));
      await saving;
    }
    if (action !== "draft") {
      expect(c.state().messageAction).toMatchObject({ pending: false, needsReadback: true });
      expect(c.state().retainedContacts).toContainEqual(peer);
      await c.saveMessageEdit();await c.confirmMessageDelete();
      expect(calls.filter(call => call.method === (action === "edit" ? "PATCH" : "DELETE"))).toHaveLength(1);
      await c.reconcileMessageAction();
    }
    c.cancelMessageAction();
    expect(c.state().messageAction).toBeUndefined();
    expect(c.state().retainedContacts).not.toContainEqual(peer);
  });
}
