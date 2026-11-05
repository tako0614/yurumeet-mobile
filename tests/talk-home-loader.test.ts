import { expect, test } from "bun:test";
import type { MobileSession } from "@takosjp/mobile-kit";
import type { YurumeetMobileHome } from "../src/api.ts";
import { createTalkHomeLoader } from "../src/talk-home-loader.ts";

const session: MobileSession = {
  hostUrl: "https://talk.example",
  product: "yurume",
  accessToken: "token-one",
  tokenType: "Bearer",
  createdAt: "2026-10-04T00:00:00.000Z",
};

function home(name: string): YurumeetMobileHome {
  return {
    actor: {
      ap_id: `https://talk.example/users/${name.toLowerCase()}`,
      preferred_username: name.toLowerCase(),
      name,
    },
    contacts: [],
    requestCount: 0,
    unread: 0,
  };
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

async function microtask() {
  await Promise.resolve();
}

test("mount before the initial load publishes loading and then the loaded snapshot", async () => {
  const request = deferred<YurumeetMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({ loadHome: () => request.promise });
  const unmount = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));

  const loading = loader.load(session);
  expect(snapshots.at(-1)).toEqual({ session, home: undefined });
  await microtask();
  request.resolve(home("Loaded"));
  await loading;

  expect(snapshots.at(-1)).toEqual({ session, home: home("Loaded") });
  unmount();
});

test("a pre-mount initial load is adopted by the matching first mount", async () => {
  const request = deferred<YurumeetMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({ loadHome: () => request.promise });
  const loading = loader.load(session);
  await microtask();
  const unmount = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));
  expect(snapshots).toEqual([{ session, home: undefined }]);

  request.resolve(home("Adopted"));
  await loading;
  expect(snapshots.at(-1)).toEqual({ session, home: home("Adopted") });
  unmount();
});

test("overlapping refresh callers settle to the latest serialized snapshot", async () => {
  const requests: Array<Deferred<YurumeetMobileHome>> = [];
  const secondStarted = deferred<void>();
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: () => {
      const request = deferred<YurumeetMobileHome>();
      requests.push(request);
      if (requests.length === 2) secondStarted.resolve(undefined);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      return request.promise.finally(() => { activeRequests -= 1; });
    },
  });
  const unmount = loader.mount({ session, home: home("Previous") }, (snapshot) => snapshots.push(snapshot));

  const olderCaller = loader.load(session);
  await microtask();
  expect(requests).toHaveLength(1);
  const latestCaller = loader.load(session);
  expect(latestCaller).toBe(olderCaller);

  requests[0]!.resolve(home("Obsolete"));
  await secondStarted.promise;
  expect(requests).toHaveLength(2);
  expect(maximumActiveRequests).toBe(1);
  requests[1]!.resolve(home("Latest"));
  const [olderResult, latestResult] = await Promise.all([olderCaller, latestCaller]);

  expect(olderResult).toEqual(home("Latest"));
  expect(latestResult).toEqual(home("Latest"));
  expect(snapshots.at(-1)).toEqual({ session, home: home("Latest") });
  expect(snapshots.some((snapshot) => snapshot.home?.actor.name === "Obsolete")).toBe(false);
  unmount();
});

test("token replacement clears home and retires callers using old credentials", async () => {
  const oldRequest = deferred<YurumeetMobileHome>();
  const newRequest = deferred<YurumeetMobileHome>();
  const newCredentialStarted = deferred<void>();
  const requests: Array<{ token: string; request: Promise<YurumeetMobileHome> }> = [];
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: (current) => {
      const request = current.accessToken === "token-one" ? oldRequest : newRequest;
      requests.push({ token: current.accessToken, request: request.promise });
      if (current.accessToken === "token-two") newCredentialStarted.resolve(undefined);
      return request.promise;
    },
  });
  const unmount = loader.mount({ session, home: home("Previous") }, (snapshot) => snapshots.push(snapshot));
  const staleCaller = loader.load(session);
  const staleResult = staleCaller.catch((cause: unknown) => cause);
  await microtask();
  const replacement = { ...session, accessToken: "token-two" };
  const currentCaller = loader.load(replacement);

  expect(snapshots.at(-1)).toEqual({ session: replacement, home: undefined });
  await newCredentialStarted.promise;
  expect(requests.map(({ token }) => token)).toEqual(["token-one", "token-two"]);
  oldRequest.resolve(home("Old credential result"));
  newRequest.resolve(home("New credential result"));

  const currentResult = await currentCaller;
  expect(await staleResult).toBeInstanceOf(Error);
  expect(currentResult).toEqual(home("New credential result"));
  expect(snapshots.at(-1)).toEqual({ session: replacement, home: home("New credential result") });
  expect(snapshots.some((snapshot) => snapshot.home?.actor.name === "Old credential result")).toBe(false);
  unmount();
});

test("changing product endpoints invalidates an otherwise identical session", async () => {
  const oldRequest = deferred<YurumeetMobileHome>();
  const newRequest = deferred<YurumeetMobileHome>();
  const newRouteStarted = deferred<void>();
  const routedSession = { ...session, productEndpoints: { conversations: "/old/contacts" } };
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: (current) => {
      if (current.productEndpoints?.conversations === "/new/contacts") {
        newRouteStarted.resolve(undefined);
        return newRequest.promise;
      }
      return oldRequest.promise;
    },
  });
  const unmount = loader.mount({ session: routedSession, home: home("Old route") }, (snapshot) => snapshots.push(snapshot));
  const staleCaller = loader.load(routedSession);
  const staleResult = staleCaller.catch((cause: unknown) => cause);
  await microtask();
  const nextRouteSession = { ...routedSession, productEndpoints: { conversations: "/new/contacts" } };
  const currentCaller = loader.load(nextRouteSession);
  expect(snapshots.at(-1)).toEqual({ session: nextRouteSession, home: undefined });

  oldRequest.resolve(home("Old route response"));
  await newRouteStarted.promise;
  newRequest.resolve(home("New route response"));
  expect(await staleResult).toBeInstanceOf(Error);
  await expect(currentCaller).resolves.toEqual(home("New route response"));
  unmount();
});

test("unmount and same-session remount form new lifetimes that reject old successes", async () => {
  const oldRequest = deferred<YurumeetMobileHome>();
  const newRequest = deferred<YurumeetMobileHome>();
  let requestNumber = 0;
  const firstSnapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const secondSnapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: () => (++requestNumber === 1 ? oldRequest.promise : newRequest.promise),
  });
  const unmountFirst = loader.mount({ session }, (snapshot) => firstSnapshots.push(snapshot));
  const firstCaller = loader.load(session);
  await microtask();
  unmountFirst();

  const unmountSecond = loader.mount({ session }, (snapshot) => secondSnapshots.push(snapshot));
  const secondCaller = loader.load(session);
  await microtask();
  const secondMountPublicationCount = secondSnapshots.length;
  oldRequest.resolve(home("Old mount"));
  await expect(firstCaller).rejects.toThrow();
  expect(firstSnapshots.every((snapshot) => snapshot.home === undefined)).toBe(true);
  expect(secondSnapshots).toHaveLength(secondMountPublicationCount);
  expect(secondSnapshots.every((snapshot) => snapshot.home === undefined)).toBe(true);

  newRequest.resolve(home("Current mount"));
  await expect(secondCaller).resolves.toEqual(home("Current mount"));
  expect(secondSnapshots.at(-1)).toEqual({ session, home: home("Current mount") });
  unmountSecond();
});

test("unmount and same-session remount ignore old failures without clearing new home", async () => {
  const oldRequest = deferred<YurumeetMobileHome>();
  const newRequest = deferred<YurumeetMobileHome>();
  let requestNumber = 0;
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: () => (++requestNumber === 1 ? oldRequest.promise : newRequest.promise),
  });
  const unmountFirst = loader.mount({ session }, () => {});
  const firstCaller = loader.load(session);
  await microtask();
  unmountFirst();
  const unmountSecond = loader.mount({ session }, (snapshot) => snapshots.push(snapshot));
  const secondCaller = loader.load(session);
  await microtask();

  newRequest.resolve(home("Current home"));
  await secondCaller;
  const publicationCountAfterSuccess = snapshots.length;
  oldRequest.reject(new Error("old request failed"));
  await expect(firstCaller).rejects.toThrow("old request failed");
  expect(snapshots.at(-1)).toEqual({ session, home: home("Current home") });
  expect(snapshots).toHaveLength(publicationCountAfterSuccess);
  unmountSecond();
});

test("a current load failure clears the current home snapshot", async () => {
  const currentRequest = deferred<YurumeetMobileHome>();
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({ loadHome: () => currentRequest.promise });
  const unmount = loader.mount({ session, home: home("Previously loaded") }, (snapshot) => snapshots.push(snapshot));
  const loading = loader.load(session);
  await microtask();
  currentRequest.reject(new Error("connection lost"));

  await expect(loading).rejects.toThrow("connection lost");
  expect(snapshots.at(-1)).toEqual({ session, home: undefined });
  unmount();
});

test("a changed identity starts its read without waiting for a retired body", async () => {
  const oldRequest = deferred<YurumeetMobileHome>();
  const newRequest = deferred<YurumeetMobileHome>();
  const reads: Array<{ token: string; signal?: AbortSignal }> = [];
  const snapshots: Array<{ session: MobileSession; home?: YurumeetMobileHome }> = [];
  const loader = createTalkHomeLoader({
    loadHome: (current, signal) => {
      reads.push({ token: current.accessToken, signal });
      // Even a late adapter that ignores cancellation must not hold the new
      // identity's read or later clear its pending work.
      return current.accessToken === session.accessToken ? oldRequest.promise : newRequest.promise;
    },
  });
  const release = loader.mount({ session }, (value) => snapshots.push(value));
  const oldCaller = loader.load(session);
  const oldResult = oldCaller.catch((cause: unknown) => cause);
  await microtask();
  const replacement = { ...session, accessToken: "replacement-token" };
  const newCaller = loader.load(replacement);
  await microtask();
  const observed = { tokens: reads.map((read) => read.token), canceled: reads[0]?.signal?.aborted };
  try {
    expect(observed).toEqual({ tokens: [session.accessToken, replacement.accessToken], canceled: true });
    expect(newCaller).not.toBe(oldCaller);
    // Settle the retired promise while the new read is still pending: its
    // finally must not clear the current read and start a duplicate request.
    oldRequest.resolve(home("Retired"));
    expect(await oldResult).toBeInstanceOf(Error);
    const overlap = loader.load(replacement);
    expect(overlap).toBe(newCaller);
    newRequest.resolve(home("Current"));
    expect(await newCaller).toEqual(home("Current"));
    await overlap;
    expect(reads).toHaveLength(3); // one latest same-identity refresh after the overlap
    expect(snapshots.some((value) => value.home?.actor.name === "Retired")).toBe(false);
  } finally {
    oldRequest.resolve(home("Retired"));
    newRequest.resolve(home("Current"));
    await Promise.allSettled([oldCaller, newCaller]);
    release();
  }
});

test("unmount cancels the pending read and a new mount starts independently", async () => {
  const requests: Array<{ signal?: AbortSignal; request: Deferred<YurumeetMobileHome> }> = [];
  const loader = createTalkHomeLoader({
    loadHome: (_current, signal) => {
      const request = deferred<YurumeetMobileHome>();
      requests.push({ signal, request });
      return request.promise;
    },
  });
  const releaseOld = loader.mount({ session }, () => {});
  const old = loader.load(session).catch((cause: unknown) => cause);
  await microtask();
  releaseOld();
  const canceled = requests[0]?.signal?.aborted;
  const releaseNew = loader.mount({ session }, () => {});
  const current = loader.load(session);
  await microtask();
  requests[1]!.request.resolve(home("Current"));
  await current;
  requests[0]!.request.resolve(home("Retired"));
  expect(await old).toBeInstanceOf(Error);
  expect(canceled).toBe(true);
  releaseNew();
});
