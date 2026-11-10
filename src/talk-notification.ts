import type { MobilePushNotificationCallbackInput } from "@takosjp/mobile-kit";
import { talkSessionIdentity } from "./talk-session.ts";

export interface TalkNotificationRequest {
  readonly sessionKey: string;
  readonly eventId: string;
  readonly objectId?: string;
}

export function isTalkNotificationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Capture a hint only. Its activity/object IDs never identify a chat locally. */
export function talkNotificationRequest(input: MobilePushNotificationCallbackInput): TalkNotificationRequest | undefined {
  if (input.kind !== "tapped" || input.session.product !== "yurume") return;
  const data = input.notification.data;
  if (!isTalkNotificationId(data.event_id) ||
    (data.room_id !== undefined && !isTalkNotificationId(data.room_id))) return;
  return { sessionKey: talkSessionIdentity(input.session), eventId: data.event_id,
    ...(data.room_id !== undefined ? { objectId: data.room_id } : {}) };
}

/** Invalid taps cannot erase a valid hint waiting for this session's home. */
export function updateTalkNotificationRequest(
  current: TalkNotificationRequest | undefined,
  input: MobilePushNotificationCallbackInput,
): TalkNotificationRequest | undefined {
  if (input.kind !== "tapped") return current;
  const next = talkNotificationRequest(input);
  if (next) return next;
  return current?.sessionKey === talkSessionIdentity(input.session) ? current : undefined;
}
