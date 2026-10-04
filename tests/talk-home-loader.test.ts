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

test("token replacement clears home immediately and retries stale work with current credentials", async () => {
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
  await microtask();
  const replacement = { ...session, accessToken: "token-two" };
  const currentCaller = loader.load(replacement);

  expect(snapshots.at(-1)).toEqual({ session: replacement, home: undefined });
  expect(requests.map(({ token }) => token)).toEqual(["token-one"]);
  oldRequest.resolve(home("Old credential result"));
  await newCredentialStarted.promise;
  expect(requests.map(({ token }) => token)).toEqual(["token-one", "token-two"]);
  newRequest.resolve(home("New credential result"));

  const [staleResult, currentResult] = await Promise.all([staleCaller, currentCaller]);
  expect(staleResult).toEqual(home("New credential result"));
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
  await microtask();
  const nextRouteSession = { ...routedSession, productEndpoints: { conversations: "/new/contacts" } };
  const currentCaller = loader.load(nextRouteSession);
  expect(snapshots.at(-1)).toEqual({ session: nextRouteSession, home: undefined });

  oldRequest.resolve(home("Old route response"));
  await newRouteStarted.promise;
  newRequest.resolve(home("New route response"));
  await expect(staleCaller).resolves.toEqual(home("New route response"));
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
