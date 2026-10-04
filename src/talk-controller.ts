import { talkSessionIdentity } from "./talk-session.ts";
import {
  appendUniqueMobileItemsById,
  canSubmitMobileText,
  type MobileSession,
} from "@takosjp/mobile-kit";
import {
  loadCommunityMessages,
  loadUserMessages,
  markTalkAsRead,
  sendCommunityMessage,
  sendUserMessage,
  type TalkContact,
  type TalkMessage,
} from "./api.ts";

export interface TalkState {
  readonly selected?: TalkContact;
  readonly messages: readonly TalkMessage[];
  readonly content: string;
  readonly loading: boolean;
  readonly sending: boolean;
  readonly error: string;
}

interface Conversation {
  contact: TalkContact;
  messages: readonly TalkMessage[];
  content: string;
  draftRevision: number;
  sending: boolean;
  readError: string;
  sendError: string;
  sendOutcome: number;
  confirmed: Map<string, TalkMessage>;
}

// Conversations own their draft and pending send. A separate view incarnation
// owns reads, including leaving and reopening the same AP ID.
export function createTalkController(options: {
  session: MobileSession;
  refreshHome: () => Promise<void>;
  onChange?: (state: TalkState) => void;
  isActive?: () => boolean;
}) {
  let session = { ...options.session };
  let sessionKey = talkSessionIdentity(session);
  let authority = 0;
  let view = 0;
  let disposed = false;
  let selected: Conversation | undefined;
  let loading = false;
  const conversations = new Map<string, Conversation>();

  function state(): TalkState {
    return {
      selected: selected?.contact,
      messages: selected?.messages ?? [],
      content: selected?.content ?? "",
      loading,
      sending: selected?.sending ?? false,
      error: selected?.sendError || selected?.readError || "",
    };
  }

  function publish() {
    if (active(authority)) options.onChange?.(state());
  }

  function active(expected: number) {
    return !disposed && options.isActive?.() !== false && authority === expected;
  }

  function current(expected: number, incarnation: number, entry: Conversation) {
    return active(expected) && view === incarnation && selected === entry;
  }

  function conversation(contact: TalkContact) {
    const key = JSON.stringify([contact.type, contact.ap_id]);
    let entry = conversations.get(key);
    if (!entry) {
      entry = {
        contact, messages: [], content: "", draftRevision: 0, sending: false,
        readError: "", sendError: "", sendOutcome: 0, confirmed: new Map(),
      };
      conversations.set(key, entry);
    }
    entry.contact = contact;
    return entry;
  }

  async function open(contact: TalkContact) {
    if (!active(authority)) return;
    const entry = conversation(contact);
    const expected = authority;
    const incarnation = ++view;
    const requestSession = session;
    const sendOutcome = entry.sendOutcome;
    selected = entry;
    entry.confirmed.clear();
    loading = true;
    entry.readError = "";
    publish();
    try {
      const messages = contact.type === "community"
        ? await loadCommunityMessages(requestSession, contact.ap_id)
        : await loadUserMessages(requestSession, contact.ap_id);
      if (!current(expected, incarnation, entry)) return;
      for (const message of messages) entry.confirmed.delete(message.id);
      // A read started before a send ACK may omit that message. Merge only
      // ACKs received since this read began, preserving the producer page limit.
      entry.messages = appendUniqueMobileItemsById(messages, [...entry.confirmed.values()]);
      if (entry.sendOutcome === sendOutcome) entry.sendError = "";
      publish();
      await markTalkAsRead(requestSession, contact);
      if (!current(expected, incarnation, entry)) return;
      await options.refreshHome();
    } catch (cause) {
      if (!current(expected, incarnation, entry)) return;
      entry.readError = errorMessage(cause, "トークを読み込めませんでした。");
    } finally {
      if (current(expected, incarnation, entry)) {
        loading = false;
        publish();
      }
    }
  }

  function back() {
    if (disposed) return;
    view += 1;
    selected = undefined;
    loading = false;
    publish();
  }

  function setDraft(value: string) {
    if (disposed || !selected || selected.content === value) return;
    selected.content = value;
    selected.draftRevision += 1;
    publish();
  }

  async function send() {
    const entry = selected;
    if (!active(authority) || !entry || !canSubmitMobileText({
      value: entry.content, disabled: loading || entry.sending, maxLength: 2000,
    })) return;
    const expected = authority;
    const requestSession = session;
    const contact = entry.contact;
    const content = entry.content;
    const revision = entry.draftRevision;
    entry.sending = true;
    entry.sendError = "";
    publish();
    let accepted = false;
    try {
      const message = contact.type === "community"
        ? await sendCommunityMessage(requestSession, contact.ap_id, content)
        : await sendUserMessage(requestSession, contact.ap_id, content);
      if (!active(expected)) return;
      accepted = true;
      entry.confirmed.set(message.id, message);
      entry.messages = appendUniqueMobileItemsById(entry.messages, [message]);
      entry.sendOutcome += 1;
      if (entry.draftRevision === revision) {
        entry.content = "";
        entry.draftRevision += 1;
      }
      publish();
    } catch (cause) {
      if (!active(expected)) return;
      entry.sendOutcome += 1;
      entry.sendError = errorMessage(cause, "メッセージを送れませんでした。");
    } finally {
      if (active(expected)) {
        entry.sending = false;
        publish();
      }
    }
    // A confirmed POST is separate from reloading root counts. A failing
    // readback must not describe an already accepted message as a failed send.
    if (active(expected) && accepted) {
      try {
        await options.refreshHome();
      } catch (cause) {
        if (active(expected)) {
          entry.readError = errorMessage(cause, "トーク一覧を更新できませんでした。");
          publish();
        }
      }
    }
  }

  function updateSession(next: MobileSession) {
    if (disposed) return;
    const key = talkSessionIdentity(next);
    session = { ...next };
    if (key === sessionKey) return;
    sessionKey = key;
    authority += 1;
    view += 1;
    conversations.clear();
    selected = undefined;
    loading = false;
    publish();
  }

  function dispose() {
    disposed = true;
    authority += 1;
    view += 1;
    conversations.clear();
    selected = undefined;
    loading = false;
  }

  return { state, open, back, setDraft, send, updateSession, dispose };
}


function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
