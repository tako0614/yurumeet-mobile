import { observedInitAck as initAck, observedMessageAck as readAck } from "./talk-read-fixture.ts";
import { afterEach, expect, test } from "bun:test";
import { MobileApiError } from "@takosjp/mobile-kit";
import { createTalkController } from "../src/talk-controller.ts";
import {
  sendUserMessage,
  isUncertainMessageSend,
  type YurumeetMobileHome,
} from "../src/api.ts";
const session = {
  product: "yurume" as const,
  hostUrl: "https://talk-recovery.example",
  accessToken: "synthetic-yurume-session",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const alice = {
  type: "user" as const,
  ap_id: "https://peer.example/users/alice",
  preferred_username: "alice",
  name: "Alice",
  icon_url: null,
  last_message: null,
  last_message_at: null,
  unread_count: 0,
};
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("an unknown send cannot POST the same retained draft again before message readback", async () => {
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sends++;
      return Response.json({ message: null });
    }
    return Response.json({ messages: [] });
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Keep this message");
  await c.send();
  await c.send();
  expect(sends).toBe(1);
  expect(c.state()).toMatchObject({
    content: "Keep this message",
    uncertain: true,
    canSend: false,
  });
  c.dispose();
});
test("HTTP503 send is treated as an unknown outcome rather than a definite rejection", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "upstream unavailable" },
      { status: 503 },
    )) as unknown as typeof fetch;
  try {
    await sendUserMessage(session, alice.ap_id, "Maybe committed");
    throw Error("expected rejection");
  } catch (cause) {
    expect(cause).toBeInstanceOf(MobileApiError);
    expect(cause).toMatchObject({
      status: 503,
      path: "/api/dm/user/" + encodeURIComponent(alice.ap_id) + "/messages",
    });
    expect(isUncertainMessageSend(cause)).toBe(true);
  }
});

import { createTalkHomeLoader } from "../src/talk-home-loader.ts";
test("an API-root change retires the prior conversation POST even with identical bearer", async () => {
  let finish: ((value: Response) => void) | undefined,
    postSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      postSignal = init.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json({ messages: [] });
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id),
    session: { ...session, apiBaseUrl: session.hostUrl + "/api/a" },
    refreshHome: async () => {},
  });
  await c.open(alice);
  c.setDraft("Old root draft");
  const sending = c.send();
  c.updateSession({ ...session, apiBaseUrl: session.hostUrl + "/api/b" });
  finish!(
    Response.json({
      message: {
        id: "old-root",
        content: "Old root draft",
        created_at: null,
        sender: { ap_id: "me", preferred_username: "me", name: null },
      },
    }),
  );
  await sending;
  expect(postSignal?.aborted).toBe(true);
  expect(c.state()).toMatchObject({
    selected: undefined,
    messages: [],
    content: "",
  });
  c.dispose();
});
test("an API-root change clears the previously published home before new readback", async () => {
  const previous: YurumeetMobileHome = {
    actor: { ap_id: "me", preferred_username: "me", name: null },
    contacts: [],
    requestCount: 0,
    unread: 9,
  };
  let finish: ((value: typeof previous) => void) | undefined;
  const snapshots: { home?: YurumeetMobileHome }[] = [];
  const loader = createTalkHomeLoader({
    loadHome: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const release = loader.mount(
    {
      session: { ...session, apiBaseUrl: session.hostUrl + "/api/a" },
      home: previous,
    },
    (s) => snapshots.push(s),
  );
  const pending = loader.load({
    ...session,
    apiBaseUrl: session.hostUrl + "/api/b",
  });
  const observed = snapshots.at(-1)?.home;
  await Bun.sleep(0);
  finish!({ ...previous, unread: 0 });
  await pending;
  release();
  expect(observed).toBeUndefined();
});

function wireMessage(id: string, content = "message") {
  return {
    id,
    content,
    created_at: null,
    sender: { ap_id: "me", preferred_username: "me", name: null },
  };
}
const page = () => Response.json({ messages: [] });
async function until(check: () => boolean) {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await Bun.sleep(1);
  expect(check()).toBe(true);
}
test("successful explicit read restores sending without automatically resending retained input", async () => {
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sends++;
      return sends === 1
        ? Response.json({ message: null })
        : Response.json({ message: wireMessage("new", "A different draft") });
    }
    return page();
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Maybe sent");
  await c.send();
  expect(c.state().uncertain).toBe(true);
  await c.open(alice);
  expect(sends).toBe(1);
  expect(c.state()).toMatchObject({
    content: "Maybe sent",
    uncertain: false,
    canSend: true,
  });
  c.setDraft("A different draft");
  await c.send();
  expect(sends).toBe(2);
  expect(c.state().content).toBe("");
  c.dispose();
});
test("failed recovery GET cannot unlock an unknown send or erase a newer draft", async () => {
  let sends = 0,
    failRead = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sends++;
      return new Response("unavailable", { status: 503 });
    }
    return failRead ? new Response("failed read", { status: 500 }) : page();
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Maybe sent");
  await c.send();
  c.setDraft("Newer draft");
  failRead = true;
  await c.open(alice);
  await c.send();
  expect(sends).toBe(1);
  expect(c.state()).toMatchObject({
    content: "Newer draft",
    uncertain: true,
    canSend: false,
    loading: false,
  });
  c.dispose();
});
test("a read begun before send failure cannot clear the later unknown outcome", async () => {
  let finishRead: ((r: Response) => void) | undefined,
    finishSend: ((r: Response) => void) | undefined,
    gets = 0,
    sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sends++;
      return new Promise<Response>((r) => {
        finishSend = r;
      });
    }
    if (++gets === 1) return page();
    return new Promise<Response>((r) => {
      finishRead = r;
    });
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Maybe sent");
  const sending = c.send();
  const reading = c.open(alice);
  finishSend!(new Response("unavailable", { status: 503 }));
  await sending;
  finishRead!(page());
  await reading;
  await c.send();
  expect(sends).toBe(1);
  expect(c.state()).toMatchObject({ uncertain: true, canSend: false });
  c.dispose();
});
for (const status of [400, 401, 403, 404, 409, 422, 429])
  test(`known HTTP ${status} rejection keeps its genuine status without marking a send unknown`, async () => {
    globalThis.fetch = (async () =>
      new Response("rejected", { status })) as unknown as typeof fetch;
    try {
      await sendUserMessage(session, alice.ap_id, "rejected");
      throw Error("expected rejection");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MobileApiError);
      expect(cause).toMatchObject({ status });
      expect(isUncertainMessageSend(cause)).toBe(false);
    }
  });
for (const status of [408, 500, 502, 503, 504])
  test(`HTTP ${status} may have committed, so it blocks another POST`, async () => {
    let sends = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
      if (new URL(String(input)).pathname.endsWith("/read-observed")) return readAck(init);
      if (init?.method === "POST") {
        sends++;
        return new Response("ambiguous", { status });
      }
      return page();
    }) as unknown as typeof fetch;
    const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
    await c.open(alice);
    c.setDraft("Maybe sent");
    await c.send();
    await c.send();
    expect(sends).toBe(1);
    expect(c.state()).toMatchObject({
      uncertain: true,
      canSend: false,
      content: "Maybe sent",
    });
    c.dispose();
  });
test("a known rejection permits a deliberately edited next attempt", async () => {
  let sends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    if (new URL(String(input)).pathname.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sends++;
      return sends === 1
        ? new Response("invalid text", { status: 422 })
        : Response.json({ message: wireMessage("new", "Changed") });
    }
    return page();
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Rejected");
  await c.send();
  expect(c.state()).toMatchObject({ uncertain: false, canSend: true });
  c.setDraft("Changed");
  await c.send();
  expect(sends).toBe(2);
  expect(c.state().content).toBe("");
  c.dispose();
});
test("unknown state belongs to type plus AP ID and cannot contaminate a different conversation", async () => {
  let userSends = 0,
    groupSends = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      if (path.startsWith("/api/communities/")) {
        groupSends++;
        return Response.json({ message: wireMessage("group") });
      }
      userSends++;
      return Response.json({ message: null });
    }
    return page();
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("User pending");
  await c.send();
  c.back();
  const group = { ...alice, type: "community" as const };
  await c.open(group);
  c.setDraft("Group text");
  expect(c.state().uncertain).toBe(false);
  await c.send();
  expect(groupSends).toBe(1);
  expect(userSends).toBe(1);
  c.dispose();
});
test("Back aborts a pending view read but does not cancel its conversation-owned send", async () => {
  let readSignal: AbortSignal | null | undefined,
    sendSignal: AbortSignal | null | undefined,
    finishRead: ((r: Response) => void) | undefined,
    finishSend: ((r: Response) => void) | undefined,
    gets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/read-observed/init")) return initAck();
    if (new URL(String(input)).pathname.endsWith("/read-observed")) return readAck(init);
    if (init?.method === "POST") {
      sendSignal = init.signal;
      return new Promise<Response>((r) => {
        finishSend = r;
      });
    }
    if (++gets === 1) return page();
    readSignal = init?.signal;
    return new Promise<Response>((r) => {
      finishRead = r;
    });
  }) as unknown as typeof fetch;
  const c = createTalkController({
    observedMessageIds: () => c.state().messages.map(message => message.id), session, refreshHome: async () => {} });
  await c.open(alice);
  c.setDraft("Sending");
  const sending = c.send(),
    reading = c.open(alice);
  await until(() => !!readSignal);
  c.back();
  expect(readSignal?.aborted).toBe(true);
  expect(sendSignal?.aborted).toBe(false);
  finishRead!(page());
  await reading;
  finishSend!(Response.json({ message: wireMessage("accepted", "Sending") }));
  await sending;
  c.dispose();
});
