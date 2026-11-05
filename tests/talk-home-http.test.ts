import { expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import { loadHome } from "../src/api.ts";
import { createTalkHomeLoader } from "../src/talk-home-loader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const contacts = { mutual_followers: [], communities: [], request_count: 0 };
function me(name: string) {
  return { actor: { ap_id: name, preferred_username: name, name } };
}
function session(hostUrl: string, accessToken = "first-local-account"): MobileSession {
  return { hostUrl, accessToken, tokenType: "Bearer", product: "yurume", createdAt: "2026-11-05T00:00:00Z" };
}

function stalledBody() {
  const canceled = deferred<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode('{"mutual_followers":['));
    },
    cancel() { canceled.resolve(); },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "application/json" } }),
    canceled: canceled.promise,
    close() { try { controller.close(); } catch { /* already canceled */ } },
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error("Local read did not retire promptly.")), 1_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("an account switch cancels a real stalled HTTP body before the new home finishes", async () => {
  const body = stalledBody();
  const started = deferred<void>();
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      methods.push(request.method);
      const first = request.headers.get("authorization") === "Bearer first-local-account";
      if (new URL(request.url).pathname === "/api/auth/me") return Response.json(me(first ? "old" : "current"));
      if (first) { started.resolve(); return body.response; }
      return Response.json(contacts);
    },
  });
  const loader = createTalkHomeLoader({ loadHome });
  const initial = session(server.url.origin);
  const published: string[] = [];
  const release = loader.mount({ session: initial }, (value) => {
    if (value.home) published.push(value.home.actor.preferred_username);
  });
  const old = loader.load(initial).catch((cause: unknown) => cause);
  try {
    await bounded(started.promise);
    const home = await bounded(loader.load({ ...initial, accessToken: "second-local-account" }));
    expect(home.actor.preferred_username).toBe("current");
    expect(await bounded(old)).toBeInstanceOf(Error);
    await bounded(body.canceled);
    expect(published).toEqual(["current"]);
    expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
  } finally {
    release();
    body.close();
    await server.stop(true);
    await old;
  }
});

test("a pre-canceled home read makes no HTTP request", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      calls += 1;
      return Response.json(new URL(request.url).pathname === "/api/auth/me" ? me("local") : contacts);
    },
  });
  try {
    const cancel = new AbortController();
    const reason = new Error("retired local account");
    cancel.abort(reason);
    await expect(loadHome(session(server.url.origin), cancel.signal)).rejects.toBe(reason);
    expect(calls).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("a genuine HTTP error cancels the unfinished sibling body without retrying", async () => {
  const body = stalledBody();
  const started = deferred<void>();
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      calls += 1;
      if (new URL(request.url).pathname === "/api/auth/me") {
        await started.promise;
        return Response.json({ error: "local auth rejected" }, { status: 403 });
      }
      started.resolve();
      return body.response;
    },
  });
  try {
    await expect(bounded(loadHome(session(server.url.origin)))).rejects.toMatchObject({
      name: "MobileApiError", status: 403, path: "/api/auth/me", detail: "local auth rejected",
    });
    await bounded(body.canceled);
    expect(calls).toBe(2);
  } finally {
    body.close();
    await server.stop(true);
  }
});
