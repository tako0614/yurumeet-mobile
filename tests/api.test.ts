import { afterEach, expect, test } from "bun:test";
import {
  loadCommunityMessages,
  loadHome,
  loadUserMessages,
  markTalkAsRead,
  sendCommunityMessage,
  sendUserMessage,
} from "../src/api.ts";
import type { MobileSession } from "@takosjp/mobile-kit";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const session: MobileSession = {
  hostUrl: "https://talk.example",
  product: "yurume",
  accessToken: "host-session",
  tokenType: "Bearer",
  createdAt: "2026-07-16T00:00:00.000Z",
};

async function expectResponseError(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ name: "YurumeetResponseError" });
    return error;
  }
  throw new Error("Expected a YurumeetResponseError.");
}

test("talk home uses the shared family conversation API", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer host-session",
    );
    if (url.pathname === "/api/auth/me")
      return Response.json({
        actor: { ap_id: "me", preferred_username: "me", name: "Me" },
      });
    return Response.json({
      mutual_followers: [
        {
          type: "user",
          ap_id: "alice",
          preferred_username: "alice",
          name: "Alice",
          icon_url: null,
          last_message: null,
          last_message_at: null,
          unread_count: 2,
        },
      ],
      communities: [],
      request_count: 1,
    });
  }) as unknown as typeof fetch;
  const home = await loadHome(session);
  expect(home.contacts).toHaveLength(1);
  expect(home.unread).toBe(2);
  expect(home.requestCount).toBe(1);
});

test("user talk loads and sends through the actor-addressed DM route", async () => {
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(
      "/api/dm/user/https%3A%2F%2Fremote.example%2Fusers%2Falice/messages",
    );
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      expect(await new Response(init.body).json()).toEqual({ content: "hi" });
      return Response.json({
        message: {
          id: "m2",
          content: "hi",
          created_at: "now",
          sender: { ap_id: "me", name: "Me", preferred_username: "me" },
        },
      });
    }
    return Response.json({ messages: [] });
  }) as unknown as typeof fetch;
  await loadUserMessages(session, "https://remote.example/users/alice");
  expect(
    (await sendUserMessage(session, "https://remote.example/users/alice", "hi"))
      .id,
  ).toBe("m2");
  expect(methods).toEqual(["GET", "POST"]);
});

test("community talk stays in-app and marks the group read", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer host-session",
    );
    if (url.pathname.startsWith("/api/communities/")) {
      if (method === "POST") {
        expect(await new Response(init?.body).json()).toEqual({
          content: "hello group",
        });
        return Response.json({
          message: {
            id: "group-2",
            content: "hello group",
            created_at: "now",
            sender: { ap_id: "me", name: "Me", preferred_username: "me" },
          },
        });
      }
      return Response.json({ messages: [] });
    }
    return Response.json({ success: true, last_read_at: "2026-10-04T00:00:00Z" });
  }) as unknown as typeof fetch;

  const community = "https://talk.example/communities/friends";
  await loadCommunityMessages(session, community);
  expect(
    (await sendCommunityMessage(session, community, "hello group")).id,
  ).toBe("group-2");
  await markTalkAsRead(session, { type: "community", ap_id: community });

  expect(calls).toEqual([
    {
      path: "/api/communities/https%3A%2F%2Ftalk.example%2Fcommunities%2Ffriends/messages",
      method: "GET",
    },
    {
      path: "/api/communities/https%3A%2F%2Ftalk.example%2Fcommunities%2Ffriends/messages",
      method: "POST",
    },
    {
      path: "/api/dm/community/https%3A%2F%2Ftalk.example%2Fcommunities%2Ffriends/read",
      method: "POST",
    },
  ]);
});

test("home rejects malformed successful envelopes and entities", async () => {
  const validActor = { ap_id: "https://talk.example/users/me", preferred_username: "me", name: "Me" };
  const validContact = {
    type: "user",
    ap_id: "https://talk.example/users/alice",
    preferred_username: "alice",
    name: "Alice",
    icon_url: null,
    last_message: null,
    last_message_at: null,
    unread_count: 0,
  };
  const cases: Array<{ label: string; actor?: unknown; contacts?: unknown }> = [
    { label: "actor envelope", actor: null, contacts: { mutual_followers: [], communities: [], request_count: 0 } },
    { label: "missing actor identity", actor: { preferred_username: "me", name: "Me" }, contacts: { mutual_followers: [], communities: [], request_count: 0 } },
    { label: "missing mutual followers", actor: validActor, contacts: { communities: [], request_count: 0 } },
    { label: "missing communities", actor: validActor, contacts: { mutual_followers: [], request_count: 0 } },
    { label: "missing request count", actor: validActor, contacts: { mutual_followers: [], communities: [] } },
    { label: "invalid request count", actor: validActor, contacts: { mutual_followers: [], communities: [], request_count: -1 } },
    { label: "invalid actor identity", actor: { ...validActor, ap_id: "" }, contacts: { mutual_followers: [], communities: [], request_count: 0 } },
    { label: "invalid contact identity", actor: validActor, contacts: { mutual_followers: [{ ...validContact, ap_id: "" }], communities: [], request_count: 0 } },
    { label: "missing contact identity", actor: validActor, contacts: { mutual_followers: [{ ...validContact, preferred_username: undefined }], communities: [], request_count: 0 } },
    { label: "invalid contact kind", actor: validActor, contacts: { mutual_followers: [{ ...validContact, type: "community" }], communities: [], request_count: 0 } },
    { label: "invalid unread count", actor: validActor, contacts: { mutual_followers: [{ ...validContact, unread_count: -1 }], communities: [], request_count: 0 } },
    { label: "invalid last message", actor: validActor, contacts: { mutual_followers: [{ ...validContact, last_message: { content: 3, is_mine: "no" } }], communities: [], request_count: 0 } },
  ];

  for (const item of cases) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      return new URL(String(input)).pathname === "/api/auth/me"
        ? Response.json(item.actor === undefined ? { actor: validActor } : { actor: item.actor })
        : Response.json(item.contacts);
    }) as unknown as typeof fetch;
    await expectResponseError(loadHome(session));
  }
});

test("home and message helpers normalize valid nullable data and tolerate extra fields", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === "/api/auth/me") {
      return Response.json({
        actor: { ap_id: "https://talk.example/users/me", preferred_username: null, name: null, extra: true },
      });
    }
    if (path === "/api/dm/contacts") {
      return Response.json({
        mutual_followers: [{
          type: "user",
          ap_id: "https://talk.example/users/alice",
          preferred_username: null,
          name: null,
          icon_url: null,
          last_message: null,
          last_message_at: null,
          unread_count: 0,
          extra: "ignored",
        }],
        communities: [],
        request_count: 0,
      });
    }
    return Response.json({
      messages: [{
        id: "media-1",
        content: null,
        created_at: null,
        sender: {
          ap_id: "https://talk.example/users/alice",
          preferred_username: null,
          username: "alice",
          name: null,
        },
        attachments: [{ type: "image", url: "https://talk.example/media/1", extra: 1 }],
        extra: true,
      }],
    });
  }) as unknown as typeof fetch;

  const home = await loadHome(session);
  expect(home.actor).toMatchObject({
    ap_id: "https://talk.example/users/me",
    preferred_username: "https://talk.example/users/me",
    name: null,
  });
  expect(home.contacts[0]).toMatchObject({
    preferred_username: "https://talk.example/users/alice",
    name: null,
    icon_url: null,
  });
  expect(await loadUserMessages(session, "https://talk.example/users/alice")).toEqual([
    {
      id: "media-1",
      content: null,
      created_at: null,
      sender: {
        ap_id: "https://talk.example/users/alice",
        preferred_username: "alice",
        name: null,
      },
      attachments: [{ type: "image", url: "https://talk.example/media/1", extra: 1 }],
    },
  ]);
  expect(requests).toHaveLength(3);
});

test("empty home and message collections are valid", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/auth/me") {
      return Response.json({ actor: { ap_id: "me", preferred_username: "me", name: null } });
    }
    if (path === "/api/dm/contacts") {
      return Response.json({ mutual_followers: [], communities: [], request_count: 0 });
    }
    return Response.json({ messages: [] });
  }) as unknown as typeof fetch;

  expect(await loadHome(session)).toMatchObject({ contacts: [], requestCount: 0, unread: 0 });
  expect(await loadUserMessages(session, "alice")).toEqual([]);
  expect(await loadCommunityMessages(session, "community")).toEqual([]);
});

test("user and community message GET reject malformed envelopes and entities", async () => {
  const cases: Array<{ label: string; payload: unknown }> = [
    { label: "missing messages", payload: {} },
    { label: "non-array messages", payload: { messages: {} } },
    { label: "missing required message identity", payload: { messages: [{ content: "hi", created_at: "now", sender: { ap_id: "alice", preferred_username: "alice", name: null } }] } },
    { label: "invalid message identity", payload: { messages: [{ id: "", content: "hi", created_at: "now", sender: { ap_id: "alice", preferred_username: "alice", name: null } }] } },
    { label: "missing sender identity", payload: { messages: [{ id: "m1", content: "hi", created_at: "now", sender: { preferred_username: "alice", name: null } }] } },
    { label: "invalid sender", payload: { messages: [{ id: "m1", content: "hi", created_at: "now", sender: { ap_id: "", preferred_username: "alice", name: null } }] } },
  ];
  for (const kind of ["user", "community"] as const) {
    for (const item of cases) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return Response.json(item.payload);
      }) as unknown as typeof fetch;
      const operation = kind === "user"
        ? loadUserMessages(session, "alice")
        : loadCommunityMessages(session, "group");
      await expectResponseError(operation);
      expect(calls, `${kind} GET ${item.label}`).toBe(1);
    }
  }
});

test("message POST uncertainty is surfaced without retrying", async () => {
  const postCases = [
    { label: "user", send: () => sendUserMessage(session, "alice", "hi") },
    { label: "community", send: () => sendCommunityMessage(session, "group", "hi") },
  ];
  for (const item of postCases) {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      expect(init?.method).toBe("POST");
      return Response.json({ message: { id: "m1", content: "hi", created_at: "now" } });
    }) as unknown as typeof fetch;
    const error = await expectResponseError(item.send());
    expect(error).toMatchObject({ message: expect.stringContaining("再送する前に") });
    expect(calls, item.label).toBe(1);
  }
});

test("empty-content media-only messages preserve attachments", async () => {
  const attachments = [{ type: "image", url: "https://talk.example/media/1" }];
  globalThis.fetch = (async () => Response.json({
    messages: [{
      id: "media-2",
      content: "",
      created_at: "2026-10-04T00:00:00Z",
      sender: { ap_id: "me", preferred_username: "me", name: null },
      attachments,
    }],
  })) as unknown as typeof fetch;

  const [message] = await loadUserMessages(session, "alice");
  expect(message.content).toBe("");
  expect(message.attachments).toEqual(attachments);
});

test("message POST rejects invalid JSON as an uncertain single attempt", async () => {
  for (const send of [
    () => sendUserMessage(session, "alice", "hi"),
    () => sendCommunityMessage(session, "group", "hi"),
  ]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const error = await expectResponseError(send());
    expect(error).toMatchObject({ message: expect.stringContaining("再送する前に") });
    expect(calls).toBe(1);
  }
});

test("mark-read malformed JSON is uncertain and is not retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await expectResponseError(
    markTalkAsRead(session, { type: "community", ap_id: "group" }),
  );
  expect(calls).toBe(1);
});

test("message POST preserves genuine HTTP errors without retrying", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ error: "unavailable" }, { status: 503 });
  }) as unknown as typeof fetch;
  try {
    await sendUserMessage(session, "alice", "hi");
    throw new Error("Expected a MobileApiError.");
  } catch (error) {
    expect(error).toMatchObject({
      name: "MobileApiError",
      status: 503,
      path: "/api/dm/user/alice/messages",
    });
  }
  expect(calls).toBe(1);
});

test("mark read accepts only a successful timestamp acknowledgement", async () => {
  const contact = { type: "user" as const, ap_id: "alice" };
  for (const payload of [
    { success: false, last_read_at: "2026-10-04T00:00:00Z" },
    { last_read_at: "2026-10-04T00:00:00Z" },
    { success: true },
    { success: true, last_read_at: "" },
    { success: true, last_read_at: 3 },
  ]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json(payload);
    }) as unknown as typeof fetch;
    await expectResponseError(markTalkAsRead(session, contact));
    expect(calls).toBe(1);
  }
});
