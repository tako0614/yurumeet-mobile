import type { WireDecoder } from "@takosjp/mobile-kit";
import { isTalkNotificationId } from "./talk-notification.ts";

export interface TalkActor {
  ap_id: string;
  preferred_username: string;
  name: string | null;
}

export interface TalkContact extends TalkActor {
  type: "user" | "community";
  icon_url: string | null;
  last_message: { content: string; is_mine: boolean } | null;
  last_message_at: string | null;
  unread_count: number;
}

export interface TalkRequest {
  id: string;
  sender: TalkActor & { icon_url: string | null };
  content: string | null;
  created_at: string | null;
}

export const REQUESTS_RESPONSE: WireDecoder<TalkRequest[]> = {
  document: "Yurumeet message requests",
  decode(value) {
    return array(record(value, "response").requests, "requests").map((value, index) => {
      const field = `requests[${index}]`, item = record(value, field);
      const sender = record(item.sender, `${field}.sender`);
      const parsed = actor(sender, `${field}.sender`);
      if (!isTalkNotificationId(item.id) || !isTalkNotificationId(parsed.ap_id)) {
        throw new Error("Request identifiers must be bounded opaque IDs");
      }
      return { id: item.id, sender: { ...parsed, icon_url: nullableString(sender.icon_url, `${field}.sender.icon_url`) },
        content: nullableString(item.content, `${field}.content`), created_at: nullableString(item.created_at, `${field}.created_at`) };
    });
  },
};

export const REQUEST_REJECT_RESPONSE: WireDecoder<void> = {
  document: "Yurumeet request rejection",
  decode(value) {
    if (record(value, "response").success !== true) throw new Error("Request rejection was not acknowledged");
  },
};

export function notificationTargetResponse(eventId: string, recipientApId: string): WireDecoder<{ type: TalkContact["type"]; ap_id: string }> {
  return { document: "Yurumeet notification target", decode(value) {
    const response = record(value, "response"), target = record(response.target, "target");
    if (response.event_id !== eventId || response.recipient_ap_id !== recipientApId ||
      (target.type !== "user" && target.type !== "community") || !isTalkNotificationId(target.ap_id)) {
      throw new Error("Notification target does not match the selected account");
    }
    return { type: target.type, ap_id: target.ap_id };
  } };
}

export function notificationContactResponse(target: { type: TalkContact["type"]; ap_id: string }): WireDecoder<TalkContact> {
  return { document: "Yurumeet notification contact", decode(value) {
    const parsed = contact(record(value, "response").contact, target.type, "contact");
    if (parsed.ap_id !== target.ap_id) throw new Error("Notification contact does not match the target");
    return parsed;
  } };
}

export interface TalkMessage {
  id: string;
  content: string | null;
  created_at: string | null;
  sender: TalkActor;
  attachments?: Record<string, unknown>[];
}

export function isTalkMessageRevision(value: unknown): value is string {
  return typeof value === "string" && /^dm-v1:[a-f0-9]{64}$/.test(value);
}

export function ownedTalkMessageResponse(id: string, actorApId: string): WireDecoder<{ message: TalkMessage; revision: string }> {
  return { document: "Yurumeet owned DM", decode(value) {
    const data = record(value, "response"), parsed = message(data.message, "message");
    if (parsed.id !== id || parsed.sender.ap_id !== actorApId || !isTalkMessageRevision(data.revision)) {
      throw new Error("Owned DM does not match the selected author and message");
    }
    return { message: parsed, revision: data.revision };
  } };
}

export function ownedTalkEditResponse(id: string, content: string): WireDecoder<{ content: string; revision: string }> {
  return { document: "Yurumeet owned DM edit", decode(value) {
    const data = record(value, "response"), edited = record(data.message, "message");
    if (data.success !== true || edited.id !== id || edited.content !== content.trim() ||
      typeof edited.updated_at !== "string" || !Number.isFinite(Date.parse(edited.updated_at)) || !isTalkMessageRevision(data.revision)) {
      throw new Error("Owned DM edit was not acknowledged");
    }
    return { content: edited.content as string, revision: data.revision };
  } };
}

export const OWNED_TALK_DELETE_RESPONSE: WireDecoder<void> = {
  document: "Yurumeet owned DM delete",
  decode(value) { if (record(value, "response").success !== true) throw new Error("Owned DM deletion was not acknowledged"); },
};

export interface TalkMessagePage {
  messages: TalkMessage[];
  // Older hosts may omit continuation metadata; that is unknown, not exhausted.
  hasMore: boolean | undefined;
  nextCursor: string | null;
}

// The family producer owns these payloads. Validate the fields used by this
// client; extra producer fields and nullable profile/media values remain valid.
export const CURRENT_ACTOR_RESPONSE: WireDecoder<{ actor: TalkActor }> = {
  document: "Yurumeet current actor",
  decode(value) {
    return { actor: actor(record(value, "response").actor, "actor") };
  },
};

export const CONTACTS_RESPONSE: WireDecoder<{
  mutual_followers: TalkContact[];
  communities: TalkContact[];
  request_count: number;
}> = {
  document: "Yurumeet contacts",
  decode(value) {
    const response = record(value, "response");
    return {
      mutual_followers: array(response.mutual_followers, "mutual_followers").map(
        (value, index) => contact(value, "user", `mutual_followers[${index}]`),
      ),
      communities: array(response.communities, "communities").map(
        (value, index) => contact(value, "community", `communities[${index}]`),
      ),
      request_count: count(response.request_count, "request_count"),
    };
  },
};

export const MESSAGES_RESPONSE: WireDecoder<TalkMessage[]> = {
  document: "Yurumeet messages",
  decode(value) {
    return array(record(value, "response").messages, "messages").map(
      (value, index) => message(value, `messages[${index}]`),
    );
  },
};

export const MESSAGES_PAGE_RESPONSE: WireDecoder<TalkMessagePage> = {
  document: "Yurumeet message page",
  decode(value) {
    const messages = MESSAGES_RESPONSE.decode(value);
    const hasMore = record(value, "response").has_more;
    if (hasMore !== undefined && typeof hasMore !== "boolean") {
      throw new Error("has_more must be a boolean");
    }
    let nextCursor: string | null = null;
    if (hasMore) {
      const first = messages[0];
      if (!first?.created_at || /\s/.test(first.created_at) ||
        !Number.isFinite(Date.parse(first.created_at)) || /\s/.test(first.id)) {
        throw new Error("an older page requires a dated first message");
      }
      // Core orders oldest-first and accepts its published + AP-ID tuple.
      // Keep the exact timestamp: normalizing it can skip equal-time rows.
      nextCursor = `${first.created_at} ${first.id}`;
    }
    return { messages, hasMore, nextCursor };
  },
};

export const SENT_MESSAGE_RESPONSE: WireDecoder<TalkMessage> = {
  document: "Yurumeet sent message",
  decode(value) {
    return message(record(value, "response").message, "message");
  },
};

export const READ_RESPONSE: WireDecoder<void> = {
  document: "Yurumeet read acknowledgment",
  decode(value) {
    const response = record(value, "response");
    if (response.success !== true) throw new Error("success must be true");
    identity(response.last_read_at, "last_read_at");
  },
};

export const OBSERVED_READ_INIT_RESPONSE: WireDecoder<void> = {
  document: "Yurumeet observed read initialization",
  decode(value) {
    const response = record(value, "response");
    const contract = record(response.read_observed, "read_observed");
    if (response.success !== true || contract.version !== 1 || contract.max_ids !== 50) {
      throw new Error("Observed read v1 capability required");
    }
  },
};

export function observedReadResponse(expected: readonly string[]): WireDecoder<void> {
  const ids = [...expected];
  return {
    document: "Yurumeet observed message acknowledgment",
    decode(value) {
      const response = record(value, "response");
      const acknowledged = array(response.message_ids, "message_ids");
      if (response.success !== true || acknowledged.length !== ids.length ||
          acknowledged.some((id, index) => id !== ids[index])) {
        throw new Error("Acknowledged message IDs do not match the request");
      }
    },
  };
}

function actor(value: unknown, field: string): TalkActor {
  const item = record(value, field);
  const apId = identity(item.ap_id, `${field}.ap_id`);
  const preferred = nullableString(item.preferred_username, `${field}.preferred_username`);
  // Remote actors may have no preferred username. The producer's display
  // username is a useful fallback, and the AP ID always identifies the actor.
  const username = typeof item.username === "string" && item.username.trim()
    ? item.username
    : apId;
  return {
    ap_id: apId,
    preferred_username: preferred ?? username,
    name: nullableString(item.name, `${field}.name`),
  };
}

function contact(value: unknown, kind: TalkContact["type"], field: string): TalkContact {
  const item = record(value, field);
  if (item.type !== kind) throw new Error(`${field}.type must be ${kind}`);
  let lastMessage: TalkContact["last_message"] = null;
  if (item.last_message !== null) {
    const last = record(item.last_message, `${field}.last_message`);
    if (typeof last.is_mine !== "boolean") throw new Error(`${field}.last_message.is_mine must be a boolean`);
    lastMessage = {
      content: string(last.content, `${field}.last_message.content`),
      is_mine: last.is_mine,
    };
  }
  return {
    ...actor(item, field),
    type: kind,
    icon_url: nullableString(item.icon_url, `${field}.icon_url`),
    last_message: lastMessage,
    last_message_at: nullableString(item.last_message_at, `${field}.last_message_at`),
    unread_count: count(item.unread_count, `${field}.unread_count`),
  };
}

function message(value: unknown, field: string): TalkMessage {
  const item = record(value, field);
  return {
    id: identity(item.id, `${field}.id`),
    content: nullableString(item.content, `${field}.content`),
    created_at: nullableString(item.created_at, `${field}.created_at`),
    sender: actor(item.sender, `${field}.sender`),
    ...(item.attachments === undefined ? {} : {
      attachments: array(item.attachments, `${field}.attachments`).map(
        (attachment, index) => record(attachment, `${field}.attachments[${index}]`),
      ),
    }),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function identity(value: unknown, field: string): string {
  const text = string(value, field);
  if (!text.trim()) throw new Error(`${field} must not be empty`);
  return text;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
  return value;
}
