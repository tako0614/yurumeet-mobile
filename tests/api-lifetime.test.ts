import { expect, test } from "bun:test";
import { MobileApiError } from "@takosjp/mobile-kit";
import { sendUserMessage, loadUserMessages } from "../src/api.ts";
const session = {
  product: "yurume" as const,
  hostUrl: "https://body.example",
  accessToken: "synthetic-yurume-body",
  tokenType: "Bearer",
  createdAt: "2026-11-04T00:00:00Z",
};
test("a known HTTP rejection survives a stalled error body and caller cancellation", async () => {
  let headers = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch() {
      headers = true;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"error":'));
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    },
  });
  const abort = new AbortController();
  try {
    const pending = sendUserMessage(
      { ...session, hostUrl: server.url.origin },
      "alice",
      "hello",
      abort.signal,
    );
    for (const end = Date.now() + 1000; !headers && Date.now() < end;)
      await Bun.sleep(1);
    expect(headers).toBe(true);
    await Bun.sleep(20);
    abort.abort(Error("closed owner"));
    try {
      await pending;
      throw Error("expected HTTP rejection");
    } catch (cause) {
      expect(cause).toBeInstanceOf(MobileApiError);
      expect(cause).toMatchObject({
        status: 401,
        path: "/api/dm/user/alice/messages",
      });
    }
  } finally {
    server.stop(true);
  }
});

test("actual HTTP successful send headers with a stalled JSON body expire once within 15s", async () => {
  let writes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(req) {
      if (req.method === "POST") {
        writes++;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"message":'));
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ messages: [] });
    },
  });
  const start = Date.now();
  try {
    try {
      await sendUserMessage(
        { ...session, hostUrl: server.url.origin },
        "alice",
        "Maybe committed",
      );
      throw Error("expected deadline");
    } catch (cause) {
      expect(cause).toMatchObject({
        name: "YurumeetResponseError",
        uncertainSend: true,
      });
    }
    expect(writes).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(14500);
    expect(Date.now() - start).toBeLessThan(19000);
  } finally {
    server.stop(true);
  }
}, 20000);
test("caller cancellation after successful read headers aborts the body", async () => {
  let started = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch() {
      started = true;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"messages":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const abort = new AbortController();
  try {
    const pending = loadUserMessages(
      { ...session, hostUrl: server.url.origin },
      "alice",
      abort.signal,
    );
    for (const end = Date.now() + 1000; !started && Date.now() < end;)
      await Bun.sleep(1);
    expect(started).toBe(true);
    await Bun.sleep(20);
    abort.abort(Error("retired reader"));
    await expect(pending).rejects.toThrow("retired reader");
  } finally {
    server.stop(true);
  }
});
test("preaborted send dispatches zero requests", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as unknown as typeof fetch;
  const abort = new AbortController();
  abort.abort(Error("retired"));
  try {
    await expect(
      sendUserMessage(session, "alice", "No dispatch", abort.signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});
