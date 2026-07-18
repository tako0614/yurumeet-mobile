import { afterEach, expect, test } from "bun:test";
import {
  loadCommunityMessages,
  loadHome,
  loadUserMessages,
  markTalkAsRead,
  sendCommunityMessage,
  sendUserMessage,
} from "../src/api.ts";
import type { MobileSession } from "@takosjp/takosumi-mobile-kit";

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
    return Response.json({ success: true });
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
