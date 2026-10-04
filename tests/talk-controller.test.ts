import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { createTalkController, type TalkState } from "../src/talk-controller.ts";
import type { TalkContact, TalkMessage } from "../src/api.ts";

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

const alice = contact("user", "https://remote.example/users/alice", "Alice");
const bob = contact("user", "https://remote.example/users/bob", "Bob");
const group = contact(
  "community",
  "https://talk.example/communities/friends",
  "Friends",
);

function contact(
  type: TalkContact["type"],
  ap_id: string,
  preferred_username: string,
): TalkContact {
  return {
    type,
    ap_id,
    preferred_username,
    name: preferred_username,
    icon_url: null,
    last_message: null,
    last_message_at: null,
    unread_count: 0,
  };
}

function message(id: string, content: string, sender = "me"): TalkMessage {
  return {
    id,
    content,
    created_at: "2026-10-04T00:00:00.000Z",
    sender: { ap_id: sender, preferred_username: sender, name: sender },
  };
}

function messages(...items: TalkMessage[]) {
  return Response.json({ messages: items });
}

function sent(item: TalkMessage) {
  return Response.json({ message: item });
}

function readAck() {
  return Response.json({ success: true, last_read_at: "2026-10-04T00:00:00Z" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function pathFor(item: TalkContact, suffix = "messages") {
  if (suffix === "read") {
    const kind = item.type === "community" ? "community" : "user";
    return `/api/dm/${kind}/${encodeURIComponent(item.ap_id)}/read`;
  }
  return item.type === "community"
    ? `/api/communities/${encodeURIComponent(item.ap_id)}/${suffix}`
    : `/api/dm/user/${encodeURIComponent(item.ap_id)}/${suffix}`;
}

function controller(options: {
  initialSession?: MobileSession;
  refreshHome?: () => Promise<void>;
} = {}) {
  const refreshHome = options.refreshHome ?? (async () => {});
  const subject = createTalkController({
    session: options.initialSession ?? session,
    refreshHome,
  });
  return { subject, refreshHome };
}

test("A to B to A keeps contact drafts and ignores the older open incarnation", async () => {
  const calls: string[] = [];
  const oldAlice = deferred<Response>();
  const bobRead = deferred<Response>();
  const currentAlice = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === pathFor(alice) && calls.filter((path) => path.startsWith(`${pathFor(alice)}?`)).length === 1)
      return oldAlice.promise;
    if (url.pathname === pathFor(bob)) return bobRead.promise;
    if (url.pathname === pathFor(alice)) return currentAlice.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const { subject } = controller();

  const firstAlice = subject.open(alice);
  subject.setDraft("Alice draft");
  subject.back();
  const openBob = subject.open(bob);
  expect(subject.state()).toMatchObject({ selected: bob, content: "" });
  subject.setDraft("Bob draft");
  bobRead.resolve(messages(message("b1", "Bob history", bob.ap_id)));
  await openBob;

  subject.back();
  const secondAlice = subject.open(alice);
  expect(subject.state()).toMatchObject({ selected: alice, content: "Alice draft", loading: true });
  currentAlice.resolve(messages(message("a2", "current Alice", alice.ap_id)));
  await secondAlice;
  expect(subject.state()).toMatchObject({
    selected: alice,
    messages: [message("a2", "current Alice", alice.ap_id)],
    content: "Alice draft",
    loading: false,
    error: "",
  });

  oldAlice.resolve(new Response("old read failed", { status: 503 }));
  await firstAlice;
  expect(subject.state()).toMatchObject({
    selected: alice,
    messages: [message("a2", "current Alice", alice.ap_id)],
    content: "Alice draft",
    loading: false,
    error: "",
  });
  expect(calls.filter((path) => path === pathFor(alice, "read") || path === pathFor(bob, "read"))).toHaveLength(2);
});

test("contact memory keys include type as well as AP ID", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const sharedId = "https://talk.example/communities/shared";
  const userContact = contact("user", sharedId, "Shared user");
  const communityContact = contact("community", sharedId, "Shared group");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });
    return url.pathname.endsWith("/read") ? readAck() : messages();
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(userContact);
  subject.setDraft("user-specific draft");
  subject.back();
  await subject.open(communityContact);
  expect(subject.state().content).toBe("");
  subject.setDraft("community-specific draft");
  subject.back();
  await subject.open(userContact);
  expect(subject.state().content).toBe("user-specific draft");
  subject.back();
  await subject.open(communityContact);
  expect(subject.state().content).toBe("community-specific draft");
  expect(calls.map((call) => call.path)).toEqual([
    `${pathFor(userContact)}?limit=50`,
    pathFor(userContact, "read"),
    `${pathFor(communityContact)}?limit=50`,
    pathFor(communityContact, "read"),
    `${pathFor(userContact)}?limit=50`,
    pathFor(userContact, "read"),
    `${pathFor(communityContact)}?limit=50`,
    pathFor(communityContact, "read"),
  ]);
});

test("a stale successful read cannot replace the selected contact or start a read ACK", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const staleRead = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: `${url.pathname}${url.search}`, method });
    if (url.pathname === pathFor(alice)) return staleRead.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    if (url.pathname === pathFor(bob)) return messages(message("bob", "Bob message", bob.ap_id));
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const { subject } = controller();

  const aliceOpen = subject.open(alice);
  subject.back();
  await subject.open(bob);
  staleRead.resolve(messages(message("alice", "late Alice message", alice.ap_id)));
  await aliceOpen;

  expect(subject.state()).toMatchObject({
    selected: bob,
    messages: [message("bob", "Bob message", bob.ap_id)],
    loading: false,
    error: "",
  });
  expect(calls.filter((call) => call.path === pathFor(alice, "read"))).toHaveLength(0);
  expect(calls.filter((call) => call.path === pathFor(bob, "read"))).toHaveLength(1);
});

test("a send ACK during a reopened delayed GET survives its older message snapshot", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const sendAck = deferred<Response>();
  const reopenedRead = deferred<Response>();
  let aliceGets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST") return sendAck.promise;
    if (url.pathname === pathFor(alice) && ++aliceGets === 1)
      return messages(message("before", "before send", alice.ap_id));
    if (url.pathname === pathFor(alice)) return reopenedRead.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    if (url.pathname === pathFor(bob)) return messages();
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(alice);
  subject.setDraft("sent text");
  const send = subject.send();
  expect(subject.state().sending).toBe(true);
  subject.back();
  await subject.open(bob);
  subject.back();
  const reopen = subject.open(alice);
  expect(subject.state()).toMatchObject({ selected: alice, loading: true });

  sendAck.resolve(sent(message("sent-1", "sent text")));
  await send;
  expect(subject.state()).toMatchObject({
    selected: alice,
    loading: true,
    sending: false,
    content: "",
  });

  reopenedRead.resolve(messages(message("before", "before send", alice.ap_id)));
  await reopen;
  expect(subject.state().messages.map((item) => item.id)).toEqual(["before", "sent-1"]);
  expect(calls).toEqual([
    { path: `${pathFor(alice)}?limit=50`, method: "GET" },
    { path: pathFor(alice, "read"), method: "POST" },
    { path: pathFor(alice), method: "POST", body: { content: "sent text" } },
    { path: `${pathFor(bob)}?limit=50`, method: "GET" },
    { path: pathFor(bob, "read"), method: "POST" },
    { path: `${pathFor(alice)}?limit=50`, method: "GET" },
    { path: pathFor(alice, "read"), method: "POST" },
  ]);
});

test("the next canonical read expires an ACK overlay omitted from its page", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const post = deferred<Response>();
  const delayedRead = deferred<Response>();
  let aliceReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST") return post.promise;
    if (url.pathname === pathFor(alice)) {
      aliceReads += 1;
      return aliceReads === 2 ? delayedRead.promise : messages();
    }
    if (url.pathname.endsWith("/read")) return readAck();
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(alice);
  subject.setDraft("acknowledged");
  const sending = subject.send();
  subject.back();
  const reopened = subject.open(alice);
  post.resolve(sent(message("acknowledged", "acknowledged")));
  await sending;
  delayedRead.resolve(messages());
  await reopened;
  expect(subject.state().messages.map((item) => item.id)).toEqual(["acknowledged"]);

  await subject.open(alice);
  expect(subject.state().messages).toEqual([]);
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toEqual([
    { path: pathFor(alice), method: "POST", body: { content: "acknowledged" } },
  ]);
});

test("refresh failure after a confirmed send does not turn the accepted POST into a failed send", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let refreshCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST")
      return sent(message("accepted", "one delivery"));
    if (url.pathname.endsWith("/read")) return readAck();
    return messages();
  }) as unknown as typeof fetch;
  const { subject } = controller({
    refreshHome: async () => {
      refreshCalls += 1;
      if (refreshCalls === 2) throw new Error("Home refresh failed");
    },
  });

  await subject.open(alice);
  subject.setDraft("one delivery");
  await subject.send();
  expect(subject.state()).toMatchObject({
    messages: [message("accepted", "one delivery")],
    content: "",
    sending: false,
  });
  expect(subject.state().error).toBe("Home refresh failed");
  await subject.send();
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toEqual([
    { path: pathFor(alice), method: "POST", body: { content: "one delivery" } },
  ]);
});

test("a confirmed send updates its contact after navigation and preserves a newer edit", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const post = deferred<Response>();
  let aliceReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST") return post.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    if (url.pathname === pathFor(alice) && ++aliceReads > 1)
      return messages(
        message("history", "history", alice.ap_id),
        message("confirmed", "submitted version"),
      );
    return messages(message("history", "history", url.pathname === pathFor(bob) ? bob.ap_id : alice.ap_id));
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(alice);
  subject.setDraft("submitted version");
  const sending = subject.send();
  subject.setDraft("newer edit");
  subject.back();
  await subject.open(bob);
  expect(subject.state()).toMatchObject({ selected: bob, sending: false });
  post.resolve(sent(message("confirmed", "submitted version")));
  await sending;
  expect(subject.state()).toMatchObject({
    selected: bob,
    messages: [message("history", "history", bob.ap_id)],
    content: "",
    sending: false,
    error: "",
  });

  subject.back();
  await subject.open(alice);
  expect(subject.state()).toMatchObject({
    selected: alice,
    messages: [message("history", "history", alice.ap_id), message("confirmed", "submitted version")],
    content: "newer edit",
    sending: false,
  });
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toEqual([
    { path: pathFor(alice), method: "POST", body: { content: "submitted version" } },
  ]);
});

test("pending and uncertain sends never auto-resend and preserve edits made after submit", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const pendingPost = deferred<Response>();
  let aliceGets = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST") return pendingPost.promise;
    if (url.pathname === pathFor(alice) && ++aliceGets === 1) return messages();
    if (url.pathname === pathFor(alice)) return messages(message("history", "server copy", alice.ap_id));
    if (url.pathname === pathFor(bob)) return messages();
    if (url.pathname.endsWith("/read")) return readAck();
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(alice);
  subject.setDraft("original payload");
  const pending = subject.send();
  subject.setDraft("newer edit");
  subject.back();
  await subject.open(bob);
  subject.back();
  await subject.open(alice);
  expect(subject.state()).toMatchObject({
    selected: alice,
    content: "newer edit",
    sending: true,
  });
  await subject.send();
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toHaveLength(1);

  pendingPost.reject(new TypeError("network disconnected after submit"));
  await pending;
  expect(subject.state()).toMatchObject({
    selected: alice,
    content: "newer edit",
    sending: false,
  });
  expect(subject.state().error).toContain("送信結果を確認できませんでした");
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toEqual([
    { path: pathFor(alice), method: "POST", body: { content: "original payload" } },
  ]);
});

test("a known HTTP send failure stays with its contact and cannot clear a newer draft", async () => {
  const calls: Array<{
    path: string;
    method: string;
    authorization: string | null;
    body?: unknown;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (method === "POST" && url.pathname === pathFor(group))
      return new Response("rejected", { status: 422 });
    return url.pathname.endsWith("/read") ? readAck() : messages();
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(group);
  subject.setDraft("first attempt");
  const failed = subject.send();
  subject.setDraft("edited while sending");
  await failed;
  expect(subject.state()).toMatchObject({
    selected: group,
    content: "edited while sending",
    sending: false,
  });
  expect(subject.state().error).toBeTruthy();
  expect(calls).toEqual([
    { path: `${pathFor(group)}?limit=50`, method: "GET", authorization: "Bearer host-session" },
    { path: pathFor(group, "read"), method: "POST", authorization: "Bearer host-session" },
    {
      path: pathFor(group),
      method: "POST",
      authorization: "Bearer host-session",
      body: { content: "first attempt" },
    },
  ]);
});

test("read ACK errors keep loaded messages visible and expose the HTTP failure", async () => {
  const calls: Array<{ path: string; method: string; authorization: string | null; body?: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return url.pathname.endsWith("/read")
      ? new Response("read unavailable", { status: 503 })
      : messages(message("visible", "loaded", alice.ap_id));
  }) as unknown as typeof fetch;
  const { subject } = controller();

  await subject.open(alice);
  expect(subject.state()).toMatchObject({
    selected: alice,
    messages: [message("visible", "loaded", alice.ap_id)],
    loading: false,
  });
  expect(subject.state().error).toBeTruthy();
  expect(calls).toEqual([
    { path: `${pathFor(alice)}?limit=50`, method: "GET", authorization: "Bearer host-session" },
    { path: pathFor(alice, "read"), method: "POST", authorization: "Bearer host-session" },
  ]);
});

test("session replacement through ABA and dispose invalidate every captured callback", async () => {
  const calls: Array<{ path: string; method: string; authorization: string | null; body?: unknown }> = [];
  const staleRead = deferred<Response>();
  const oldSend = deferred<Response>();
  const refreshed: string[] = [];
  const refreshHome = async () => { refreshed.push("refresh"); };
  const { subject } = controller({ refreshHome });
  const nextSession = { ...session, accessToken: "replacement-session" };
  const freshRead = deferred<Response>();
  const disposedPost = deferred<Response>();
  let aliceReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "GET") {
      aliceReads += 1;
      if (aliceReads === 1) return messages();
      if (aliceReads === 2) return staleRead.promise;
      return freshRead.promise;
    }
    if (url.pathname === pathFor(alice) && method === "POST")
      return calls.filter((call) => call.method === "POST" && call.path === pathFor(alice)).length === 1
        ? oldSend.promise
        : disposedPost.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    return messages();
  }) as unknown as typeof fetch;

  await subject.open(alice);
  subject.setDraft("private old-session draft");
  const sending = subject.send();
  const staleOpening = subject.open(alice);
  const refreshCountBeforeInvalidatedCallbacks = refreshed.length;
  subject.updateSession(nextSession);
  expect(subject.state()).toMatchObject({ selected: undefined, content: "", messages: [], loading: false, sending: false, error: "" });
  subject.updateSession(session);
  const currentRead = subject.open(alice);
  oldSend.resolve(sent(message("old-session-send", "private old-session draft")));
  await sending;
  staleRead.resolve(messages(message("old-session-read", "private old history", alice.ap_id)));
  await staleOpening;
  expect(refreshed).toHaveLength(refreshCountBeforeInvalidatedCallbacks);
  expect(calls.filter((call) => call.path === pathFor(alice, "read"))).toHaveLength(1);

  // Resolve the new authority's read, then dispose with a separately captured send.
  const activeRead = calls.find((call) => call.method === "GET" && call.authorization === "Bearer host-session");
  expect(activeRead).toBeDefined();
  freshRead.resolve(messages(message("new-history", "fresh", alice.ap_id)));
  await currentRead;
  subject.setDraft("dispose send");
  const refreshCountBeforeDispose = refreshed.length;
  const disposedSend = subject.send();
  subject.dispose();
  disposedPost.resolve(sent(message("late-after-dispose", "dispose send")));
  await disposedSend;
  expect(refreshed).toHaveLength(refreshCountBeforeDispose);
  expect(subject.state()).toMatchObject({ selected: undefined, content: "", messages: [], loading: false, sending: false, error: "" });
});

test("sending is blocked while a contact read is still loading", async () => {
  const calls: Array<{ path: string; method: string; authorization: string | null; body?: unknown }> = [];
  const pendingRead = deferred<Response>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice)) return pendingRead.promise;
    return readAck();
  }) as unknown as typeof fetch;
  const { subject } = controller();

  const opening = subject.open(alice);
  subject.setDraft("not sent during load");
  await subject.send();
  expect(subject.state().sending).toBe(false);
  expect(calls.filter((call) => call.method === "POST" && call.path === pathFor(alice))).toHaveLength(0);
  pendingRead.resolve(messages());
  await opening;
  expect(calls.map((call) => [call.path, call.method])).toEqual([
    [`${pathFor(alice)}?limit=50`, "GET"],
    [pathFor(alice, "read"), "POST"],
  ]);
});

test("an inactive pending read emits no read ACK, refresh, or further change before disposal", async () => {
  const pendingRead = deferred<Response>();
  const calls: Array<{ path: string; method: string }> = [];
  const changes: TalkState[] = [];
  let active = true;
  let refreshCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });
    if (url.pathname === pathFor(alice)) return pendingRead.promise;
    return readAck();
  }) as unknown as typeof fetch;
  const subject = createTalkController({
    session,
    refreshHome: async () => { refreshCalls += 1; },
    onChange: (state) => changes.push(state),
    isActive: () => active,
  });

  const opening = subject.open(alice);
  const publishedBeforeInactive = changes.length;
  const refreshesBeforeInactive = refreshCalls;
  active = false;
  pendingRead.resolve(messages(message("late", "late result", alice.ap_id)));
  await opening;

  expect(calls).toEqual([{ path: `${pathFor(alice)}?limit=50`, method: "GET" }]);
  expect(refreshCalls).toBe(refreshesBeforeInactive);
  expect(changes).toHaveLength(publishedBeforeInactive);
});

test("an inactive pending successful POST emits no state change or home refresh", async () => {
  const pendingPost = deferred<Response>();
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const changes: TalkState[] = [];
  let active = true;
  let refreshCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      path: `${url.pathname}${url.search}`,
      method,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    });
    if (url.pathname === pathFor(alice) && method === "POST") return pendingPost.promise;
    if (url.pathname.endsWith("/read")) return readAck();
    return messages();
  }) as unknown as typeof fetch;
  const subject = createTalkController({
    session,
    refreshHome: async () => { refreshCalls += 1; },
    onChange: (state) => changes.push(state),
    isActive: () => active,
  });

  await subject.open(alice);
  subject.setDraft("accepted by server, view closed");
  const sending = subject.send();
  const publishedBeforeInactive = changes.length;
  const refreshesBeforeInactive = refreshCalls;
  active = false;
  pendingPost.resolve(sent(message("accepted", "accepted by server, view closed")));
  await sending;

  expect(calls).toEqual([
    { path: `${pathFor(alice)}?limit=50`, method: "GET" },
    { path: pathFor(alice, "read"), method: "POST" },
    {
      path: pathFor(alice),
      method: "POST",
      body: { content: "accepted by server, view closed" },
    },
  ]);
  expect(refreshCalls).toBe(refreshesBeforeInactive);
  expect(changes).toHaveLength(publishedBeforeInactive);
});
