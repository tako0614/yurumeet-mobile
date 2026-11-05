import { observedInitAck as initAck, observedMessageAck as ack } from "./talk-read-fixture.ts";
import { afterEach, expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import {
  loadTalkMessagePage,
  loadUserMessages,
  type TalkContact,
} from "../src/api.ts";
import { createTalkController } from "../src/talk-controller.ts";
import { MESSAGES_PAGE_RESPONSE } from "../src/talk-response.ts";
const original = globalThis.fetch;
const subjects: ReturnType<typeof createTalkController>[] = [];
afterEach(() => {
  for (const subject of subjects.splice(0)) subject.dispose();
  globalThis.fetch = original;
});
const session: MobileSession = {
  product: "yurume",
  hostUrl: "https://history.example",
  accessToken: "synthetic-account",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
const contact: TalkContact = {
  type: "user",
  ap_id: session.hostUrl + "/ap/users/buddy",
  preferred_username: "buddy",
  name: "Buddy",
  icon_url: null,
  last_message: null,
  last_message_at: null,
  unread_count: 0,
};
const timestamp = "2026-11-04T00:00:00.000Z";
function row(index: number) {
  return {
    id: session.hostUrl + "/ap/objects/" + String(index).padStart(3, "0"),
    content: "Message " + index,
    created_at: timestamp,
    sender: {
      ap_id: contact.ap_id,
      preferred_username: "buddy",
      name: "Buddy",
    },
  };
}
function rows(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => row(i + from));
}
function page(from: number, to: number, has_more: boolean) {
  return Response.json({ messages: rows(from, to), has_more });
}
function stub(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/read-observed/init")) return initAck();
    return handler(url, init);
  }) as unknown as typeof fetch;
}
function subject(refreshHome = async () => {}) {
  const value = createTalkController({
    observedMessageIds: () => value.state().messages.map(message => message.id), session, refreshHome });
  subjects.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function expectedCursor(index: number) {
  return `${timestamp} ${row(index).id}`;
}

test("the actual conversation exposes a continuation for the producer's older-message page", async () => {
  stub((url, init) => (url.pathname.endsWith("/read-observed") ? ack(init) : page(11, 60, true)));
  const value = subject();
  await value.open(contact);
  expect(value.state().hasMore).toBe(true);
  expect(typeof value.loadOlder).toBe("function");
  expect(value.state().messages).toHaveLength(50);
});

test("equal-timestamp history uses the exact composite cursor and prepends all older rows", async () => {
  const calls: URL[] = [];
  stub((url, init) => {
    calls.push(url);
    return url.pathname.endsWith("/read-observed")
      ? ack(init)
      : url.searchParams.has("before")
        ? page(1, 10, false)
        : page(11, 60, true);
  });
  let refreshes = 0;
  const value = subject(async () => {
    refreshes++;
  });
  await value.open(contact);
  value.setDraft("Keep draft");
  await value.loadOlder();
  expect(value.state().messages.map((item) => item.id)).toEqual(
    rows(1, 60).map((item) => item.id),
  );
  expect(value.state().content).toBe("Keep draft");
  expect(value.state().hasMore).toBe(false);
  expect(value.state().historyError).toBe("");
  expect(
    calls
      .filter((url) => url.searchParams.has("before"))[0]!
      .searchParams.get("before"),
  ).toBe(expectedCursor(11));
  expect(calls.filter((url) => url.pathname.endsWith("/read-observed"))).toHaveLength(1);
  expect(refreshes).toBe(1);
  const count = calls.length;
  await value.loadOlder();
  expect(calls).toHaveLength(count);
});

test("community page paths and query cursors encode AP IDs without changing selected-host authority", async () => {
  const id = "https://peer.example/ap/community/a?part=1&name=b",
    before = `${timestamp} https://peer.example/ap/objects/m?x=1&y=2`;
  const calls: { url: URL; init?: RequestInit }[] = [];
  stub((url, init) => {
    calls.push({ url, init });
    return page(1, 2, false);
  });
  const result = await loadTalkMessagePage(
    session,
    { type: "community", ap_id: id },
    undefined,
    before,
  );
  expect(result.hasMore).toBe(false);
  expect(calls[0]!.url.origin).toBe(session.hostUrl);
  expect(calls[0]!.url.pathname).toBe(
    `/api/communities/${encodeURIComponent(id)}/messages`,
  );
  expect(calls[0]!.url.searchParams.get("before")).toBe(before);
  expect(calls[0]!.url.searchParams.get("limit")).toBe("50");
  expect(calls[0]!.init).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(
    "Bearer synthetic-account",
  );
});

test("legacy missing continuation metadata stays unknown without inventing exhaustion or extra reads", async () => {
  let reads = 0;
  stub((url, init) =>
    url.pathname.endsWith("/read-observed")
      ? ack(init)
      : (reads++, Response.json({ messages: [row(1)] })),
  );
  expect(await loadUserMessages(session, contact.ap_id)).toEqual([row(1)]);
  const value = subject();
  await value.open(contact);
  expect(value.state().hasMore).toBeUndefined();
  expect(value.state().messages).toHaveLength(1);
  await value.loadOlder();
  expect(reads).toBe(2);
});

for (const wire of [
  { messages: [row(1)], has_more: "true" },
  { messages: [row(1)], has_more: null },
  { messages: [], has_more: true },
  { messages: [{ ...row(1), created_at: null }], has_more: true },
  { messages: [{ ...row(1), created_at: "not a date" }], has_more: true },
  { messages: [{ ...row(1), id: "id with space" }], has_more: true },
])
  test(
    "malformed supplied continuation cannot become an empty/exhausted page: " +
      JSON.stringify(wire),
    () => {
      expect(() => MESSAGES_PAGE_RESPONSE.decode(wire)).toThrow();
    },
  );

test("empty explicit cursor is rejected before any request", async () => {
  let calls = 0;
  stub(() => {
    calls++;
    return page(1, 2, false);
  });
  await expect(
    loadTalkMessagePage(session, contact, undefined, "  "),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("held older page coalesces repeated clicks and preserves concurrent ACK and newer draft", async () => {
  const held = deferred<Response>();
  let olderReads = 0,
    receipts = 0,
    refreshes = 0;
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) {
      receipts++;
      return ack(init);
    }
    if (init?.method === "POST")
      return Response.json({ message: row(61) }, { status: 201 });
    if (url.searchParams.has("before")) {
      olderReads++;
      return held.promise;
    }
    return page(11, 60, true);
  });
  const value = subject(async () => {
    refreshes++;
  });
  await value.open(contact);
  value.setDraft("Submitted");
  const loading = value.loadOlder();
  await value.loadOlder();
  expect(value.state().loadingOlder).toBe(true);
  expect(value.state().canSend).toBe(true);
  await value.send();
  value.setDraft("Newer unsent");
  held.resolve(page(1, 10, false));
  await loading;
  expect(olderReads).toBe(1);
  expect(receipts).toBe(1);
  expect(refreshes).toBe(2);
  expect(value.state().content).toBe("Newer unsent");
  expect(value.state().messages.map((item) => item.id)).toEqual(
    rows(1, 61).map((item) => item.id),
  );
  expect(value.state().loadingOlder).toBe(false);
});

test("failed page preserves rows and cursor and offers a single explicit retry", async () => {
  let fail = true;
  const cursors: string[] = [];
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    if (!url.searchParams.has("before")) return page(11, 60, true);
    cursors.push(url.searchParams.get("before")!);
    if (fail) {
      fail = false;
      return Response.json({ error: "history unavailable" }, { status: 503 });
    }
    return page(1, 10, false);
  });
  const value = subject();
  await value.open(contact);
  const shown = value.state().messages;
  await value.loadOlder();
  expect(value.state().messages).toBe(shown);
  expect(value.state().hasMore).toBe(true);
  expect(value.state().historyError).toContain("history unavailable");
  expect(value.state().loadingOlder).toBe(false);
  await value.loadOlder();
  expect(cursors).toEqual([expectedCursor(11), expectedCursor(11)]);
  expect(value.state().messages).toHaveLength(60);
  expect(value.state().historyError).toBe("");
});

test("Back/A-B-A fences an old page even if its aborted transport still delivers", async () => {
  const held = deferred<Response>();
  let signal: AbortSignal | undefined;
  let first = true;
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    if (url.searchParams.has("before")) {
      signal = init?.signal ?? undefined;
      return held.promise;
    }
    if (first) {
      first = false;
      return page(11, 60, true);
    }
    return page(90, 90, false);
  });
  const value = subject();
  await value.open(contact);
  const old = value.loadOlder();
  value.back();
  expect(signal?.aborted).toBe(true);
  await value.open({ ...contact, ap_id: session.hostUrl + "/ap/users/other" });
  await value.open(contact);
  held.resolve(page(1, 10, false));
  await old;
  expect(value.state().messages.map((item) => item.id)).toEqual([row(90).id]);
  expect(value.state().loadingOlder).toBe(false);
  expect(value.state().hasMore).toBe(false);
});

for (const changed of [
  { ...session, accessToken: "next-synthetic-account" },
  { ...session, apiBaseUrl: "https://history.example/other-api" },
])
  test(
    "a changed account/routing incarnation cancels and rejects its prior history page: " +
      JSON.stringify(changed),
    async () => {
      const held = deferred<Response>();
      let signal: AbortSignal | undefined;
      stub((url, init) => {
        if (url.pathname.endsWith("/read-observed")) return ack(init);
        if (url.searchParams.has("before")) {
          signal = init?.signal ?? undefined;
          return held.promise;
        }
        return page(11, 60, true);
      });
      const value = subject();
      await value.open(contact);
      const pending = value.loadOlder();
      value.updateSession(changed);
      expect(signal?.aborted).toBe(true);
      held.resolve(page(1, 10, false));
      await pending;
      expect(value.state().selected).toBeUndefined();
      expect(value.state().messages).toEqual([]);
      expect(value.state().hasMore).toBeUndefined();
      expect(value.state().loadingOlder).toBe(false);
    },
  );

test("disposal aborts a held page and suppresses late publishes", async () => {
  const held = deferred<Response>();
  let signal: AbortSignal | undefined,
    changes = 0;
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    if (url.searchParams.has("before")) {
      signal = init?.signal ?? undefined;
      return held.promise;
    }
    return page(11, 60, true);
  });
  const value = createTalkController({
    observedMessageIds: () => value.state().messages.map(message => message.id),
    session,
    refreshHome: async () => {},
    onChange: () => {
      changes++;
    },
  });
  subjects.push(value);
  await value.open(contact);
  const pending = value.loadOlder();
  value.dispose();
  const before = changes;
  expect(signal?.aborted).toBe(true);
  held.resolve(page(1, 10, false));
  await pending;
  expect(changes).toBe(before);
});

test("an older read cannot unlock a send that becomes unknown while the read is pending", async () => {
  const held = deferred<Response>();
  let posts = 0;
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    if (init?.method === "POST") {
      posts++;
      return Response.json({ error: "unknown send" }, { status: 503 });
    }
    return url.searchParams.has("before") ? held.promise : page(11, 60, true);
  });
  const value = subject();
  await value.open(contact);
  value.setDraft("Retained draft");
  const pending = value.loadOlder();
  await value.send();
  expect(value.state().uncertain).toBe(true);
  held.resolve(page(1, 10, false));
  await pending;
  expect(value.state().uncertain).toBe(true);
  expect(value.state().canSend).toBe(false);
  expect(value.state().content).toBe("Retained draft");
  await value.send();
  expect(posts).toBe(1);
  expect(value.state().messages).toHaveLength(60);
});

for (const wire of [
  { messages: rows(11, 60), has_more: true },
  { messages: rows(20, 25), has_more: true },
  { messages: rows(1, 10) },
  { messages: [], has_more: true },
])
  test(
    "nonadvancing/missing-metadata page retains retry position: " +
      JSON.stringify(wire).slice(0, 100),
    async () => {
      const cursors: string[] = [];
      stub((url, init) => {
        if (url.pathname.endsWith("/read-observed")) return ack(init);
        if (url.searchParams.has("before")) {
          cursors.push(url.searchParams.get("before")!);
          return Response.json(wire);
        }
        return page(11, 60, true);
      });
      const value = subject();
      await value.open(contact);
      const shown = value.state().messages;
      await value.loadOlder();
      expect(value.state().messages).toBe(shown);
      expect(value.state().hasMore).toBe(true);
      expect(value.state().historyError).not.toBe("");
      await value.loadOlder();
      expect(cursors).toEqual([expectedCursor(11), expectedCursor(11)]);
    },
  );

test("overlap deduplicates by ID while retaining currently confirmed values", async () => {
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    return url.searchParams.has("before")
      ? Response.json({
          messages: [...rows(1, 10), { ...row(11), content: "Stale overlap" }],
          has_more: false,
        })
      : page(11, 60, true);
  });
  const value = subject();
  await value.open(contact);
  await value.loadOlder();
  expect(value.state().messages).toHaveLength(60);
  expect(value.state().messages[10]!.content).toBe("Message 11");
});

test("an explicit latest refresh resets history continuation and cancels the stale older page", async () => {
  const held = deferred<Response>();
  let latest = 0,
    aborted = false;
  stub((url, init) => {
    if (url.pathname.endsWith("/read-observed")) return ack(init);
    if (url.searchParams.has("before")) {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return held.promise;
    }
    return latest++ === 0 ? page(11, 60, true) : page(51, 100, true);
  });
  const value = subject();
  await value.open(contact);
  const old = value.loadOlder();
  await value.open(contact);
  held.resolve(page(1, 10, false));
  await old;
  expect(aborted).toBe(true);
  expect(value.state().messages.map((item) => item.id)).toEqual(
    rows(51, 100).map((item) => item.id),
  );
  expect(value.state().hasMore).toBe(true);
});
