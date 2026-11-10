import { expect, test } from "bun:test";
import type { MobilePushNotificationCallbackInput, MobileSession } from "@takosjp/mobile-kit";
import { talkNotificationRequest, updateTalkNotificationRequest } from "../src/talk-notification.ts";
import { talkSessionIdentity } from "../src/talk-session.ts";

const session: MobileSession = {
  hostUrl: "https://talk-pending.example", product: "yurume",
  accessToken: "synthetic-local-session", tokenType: "Bearer",
  createdAt: "2026-11-10T00:00:00Z",
};
const input: MobilePushNotificationCallbackInput = {
  session, kind: "tapped", notification: { data: { event_id: "original-event", room_id: "original-object" } },
};

test("a malformed same-session tap preserves the valid hint waiting for home", () => {
  const pending = talkNotificationRequest(input)!;
  for (const data of [
    {}, { event_id: "" }, { event_id: " value" }, { event_id: "a\n" },
    { event_id: "x".repeat(2049) }, { event_id: "other", room_id: 1 },
    { url: "https://foreign.example/untrusted" },
  ]) {
    const rejected = { ...input, notification: { data } };
    expect(talkNotificationRequest(rejected)).toBeUndefined();
    expect(updateTalkNotificationRequest(pending, rejected)).toBe(pending);
  }
});

test("a later valid tap replaces the pending event without guessing a contact or using its URL", () => {
  const pending = talkNotificationRequest(input)!;
  const next = updateTalkNotificationRequest(pending, {
    ...input, notification: { data: { event_id: "latest-event", room_id: "latest-object", url: "https://foreign.example/" } },
  });
  expect(next).toEqual({ sessionKey: talkSessionIdentity(session), eventId: "latest-event", objectId: "latest-object" });
  expect(next).not.toBe(pending);
});

test("an invalid current-scope tap cannot retain a hint from another session or API root", () => {
  const pending = talkNotificationRequest(input)!;
  for (const changed of [
    { ...session, accessToken: "different-synthetic-session" },
    { ...session, tokenType: "different" },
    { ...session, createdAt: "2026-11-10T00:01:00Z" },
    { ...session, hostUrl: "https://other-talk.example" },
    { ...session, apiBaseUrl: session.hostUrl + "/api/other" },
    { ...session, productEndpoints: { currentUser: "/api/another-me" } },
  ]) {
    expect(updateTalkNotificationRequest(pending, {
      ...input, session: changed, notification: { data: { event_id: "" } },
    })).toBeUndefined();
  }
});

test("a new valid current-session hint is admitted after scope changes", () => {
  const current = { ...session, accessToken: "next-synthetic-session" };
  expect(updateTalkNotificationRequest(talkNotificationRequest(input), { ...input, session: current }))
    .toEqual({ sessionKey: talkSessionIdentity(current), eventId: "original-event", objectId: "original-object" });
});

test("receiving a notification cannot replace the pending tap", () => {
  const pending = talkNotificationRequest(input)!;
  expect(updateTalkNotificationRequest(pending, { ...input, kind: "received" })).toBe(pending);
  expect(updateTalkNotificationRequest(undefined, { ...input, kind: "received" })).toBeUndefined();
});

test("an invalid tap cannot manufacture a pending target when none exists", () => {
  expect(updateTalkNotificationRequest(undefined, { ...input, notification: { data: {} } })).toBeUndefined();
});
