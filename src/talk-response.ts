import type { WireDecoder } from "@takosjp/mobile-kit";

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

export interface TalkMessage {
  id: string;
  content: string | null;
  created_at: string | null;
  sender: TalkActor;
  attachments?: Record<string, unknown>[];
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
