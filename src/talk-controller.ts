import { talkSessionIdentity } from "./talk-session.ts";
import type { TalkMessagePage } from "./talk-response.ts";
import type { TalkNotificationRequest } from "./talk-notification.ts";
import {
  appendUniqueMobileItemsById,
  prependUniqueMobileItemsByKey,
  canSubmitMobileText,
  MobileApiError,
  type MobileSession,
} from "@takosjp/mobile-kit";
import {
  loadTalkMessagePage,
  initializeObservedTalkRead,
  acknowledgeObservedTalkMessages,
  sendCommunityMessage,
  sendUserMessage,
  isUncertainMessageSend,
  loadTalkNotificationContact,
  type TalkContact,
  type TalkMessage,
} from "./api.ts";

export interface TalkState {
  readonly notification?: { readonly loading: boolean; readonly error: string };
  readonly selected?: TalkContact;
  readonly messages: readonly TalkMessage[];
  readonly content: string;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly refreshing: boolean;
  readonly gaps: readonly { beforeId: string; canLoad: boolean }[];
  readonly hasMore: boolean | undefined;
  readonly historyError: string;
  readonly sending: boolean;
  readonly uncertain: boolean;
  readonly canSend: boolean;
  readonly error: string;
}

interface Conversation {
  contact: TalkContact;
  messages: readonly TalkMessage[];
  content: string;
  draftRevision: number;
  sending: boolean;
  uncertain: boolean;
  sendAbort?: AbortController;
  readError: string;
  sendError: string;
  sendOutcome: number;
  confirmed: Map<string, TalkMessage>;
  hasMore: boolean | undefined;
  nextCursor: string | null;
  cursors: Set<string>;
  historyError: string;
  gaps: Map<string, { cursor: string | null; seen: Set<string> }>;
  pendingRead: boolean;
  acknowledged: Set<string>;
  homePending: boolean;
}

// Conversations own their draft and pending send. A separate view incarnation
// owns reads, including leaving and reopening the same AP ID.
export function createTalkController(options: {
  session: MobileSession;
  refreshHome: () => Promise<void>;
  onChange?: (state: TalkState) => void;
  isActive?: () => boolean;
  observedMessageIds: () => readonly string[];
  receive?: {
    isForeground: () => boolean;
    canMarkRead?: () => boolean;
    schedule?: (work: () => void, delayMs: number) => () => void;
  };
}) {
  let session = { ...options.session };
  let sessionKey = talkSessionIdentity(session);
  let authority = 0;
  let view = 0;
  let disposed = false;
  let selected: Conversation | undefined;
  let loading = false;
  let loadingOlder = false;
  let readAbort: AbortController | undefined;
  let receiveAbort: AbortController | undefined;
  let cancelReceive: (() => void) | undefined;
  let receiveFailed = false;
  let notificationAbort: AbortController | undefined;
  let notification: { request: TalkNotificationRequest; recipient: string; loading: boolean; error: string } | undefined;
  const conversations = new Map<string, Conversation>();

  function state(): TalkState {
    return {
      notification: notification ? { loading: notification.loading, error: notification.error } : undefined,
      selected: selected?.contact,
      messages: selected?.messages ?? [],
      content: selected?.content ?? "",
      loading,
      loadingOlder,
      refreshing: !!receiveAbort,
      gaps: [...(selected?.gaps ?? [])].map(([beforeId, gap]) => ({ beforeId, canLoad: gap.cursor !== null })),
      hasMore: selected?.hasMore,
      historyError: selected?.historyError ?? "",
      sending: selected?.sending ?? false,
      uncertain: selected?.uncertain ?? false,
      canSend: active(authority) && !!selected && !selected.uncertain && canSubmitMobileText({
        value: selected.content, disabled: loading || selected.sending, maxLength: 2000,
      }),
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

  function stopReceive() {
    cancelReceive?.();
    cancelReceive = undefined;
    const pending = receiveAbort;
    receiveAbort = undefined;
    pending?.abort();
  }

  function dismissNotification() {
    notificationAbort?.abort();
    notificationAbort = undefined;
    notification = undefined;
    publish();
  }

  async function openNotification(request: TalkNotificationRequest, recipient: string) {
    if (!active(authority) || request.sessionKey !== sessionKey) return;
    notificationAbort?.abort();
    const read = new AbortController();
    notificationAbort = read;
    notification = { request, recipient, loading: true, error: "" };
    const expected = authority, incarnation = view;
    const owns = () => active(expected) && view === incarnation && notificationAbort === read && !read.signal.aborted;
    publish();
    try {
      const contact = await loadTalkNotificationContact(session, request, recipient, read.signal);
      if (!owns()) return;
      notificationAbort = undefined;
      notification = undefined;
      await open(contact);
    } catch (cause) {
      if (!owns()) return;
      notification = { request, recipient, loading: false,
        error: cause instanceof MobileApiError && cause.status === 404
          ? "通知先のトークは現在利用できません。一覧からも開けます。"
          : "通知先のトークを確認できませんでした。接続を確認してから再確認するか、一覧から開いてください。" };
      publish();
    } finally {
      if (notificationAbort === read) notificationAbort = undefined;
    }
  }

  function retryNotification() {
    if (!notification || notification.loading) return Promise.resolve();
    return openNotification(notification.request, notification.recipient);
  }

  function canReceive() {
    return !!options.receive && options.receive.isForeground() && active(authority) && !!selected;
  }

  function scheduleReceive() {
    cancelReceive?.();
    cancelReceive = undefined;
    if (!canReceive() || receiveFailed || receiveAbort) return;
    const schedule = options.receive!.schedule ?? ((work: () => void, delayMs: number) => {
      const id = setTimeout(work, delayMs);
      return () => clearTimeout(id);
    });
    cancelReceive = schedule(() => {
      cancelReceive = undefined;
      void refreshLatest();
    }, 5_000);
  }

  async function refreshLatest(readPage = true) {
    const entry = selected;
    if (!canReceive() || !entry || receiveAbort) return;
    if (!readPage && (receiveFailed || (!entry.homePending && (!entry.pendingRead || entry.gaps.size > 0)) ||
      options.receive?.canMarkRead?.() === false)) return;
    if (loading || loadingOlder || entry.sending) { scheduleReceive(); return; }
    const expected = authority, incarnation = view, requestSession = session;
    const read = new AbortController();
    cancelReceive?.();
    cancelReceive = undefined;
    receiveAbort = read;
    const owns = () => receiveAbort === read && !read.signal.aborted && canReceive() && current(expected, incarnation, entry);
    publish();
    try {
      if (readPage) {
        const page = await loadTalkMessagePage(requestSession, entry.contact, read.signal);
        if (!owns()) return;
        const shown = new Set(entry.messages.map(message => message.id));
        const arrived = page.messages.some(message => !shown.has(message.id));
        mergeLatest(entry, page);
        entry.pendingRead ||= arrived;
        entry.readError = "";
        publish();
      }
      // Let the view follow the new tail before checking actual visibility.
      await Promise.resolve();
      if (!owns()) return;
      if (entry.pendingRead && entry.gaps.size === 0 && options.receive?.canMarkRead?.() !== false) {
        await acknowledgeVisible(entry, requestSession, read.signal, owns);
        if (!owns()) return;
      }
      if (entry.homePending) {
        await options.refreshHome();
        if (owns()) entry.homePending = false;
      }
    } catch (cause) {
      if (owns()) {
        receiveFailed = true;
        entry.readError = errorMessage(cause, "新着メッセージを確認できませんでした。");
      }
    } finally {
      if (receiveAbort === read) {
        receiveAbort = undefined;
        publish();
        scheduleReceive();
      }
    }
  }

  async function acknowledgeVisible(entry: Conversation, requestSession: MobileSession, signal: AbortSignal, owns: () => boolean) {
    if (!owns() || options.receive?.isForeground() === false || options.receive?.canMarkRead?.() === false || entry.gaps.size > 0) return;
    const available = new Set(entry.messages.map(message => message.id));
    if (typeof options.observedMessageIds !== "function") throw new Error("表示済みメッセージを確認できませんでした。");
    const visible = options.observedMessageIds();
    const ids = [...new Set(visible)].filter(id => available.has(id) && !entry.acknowledged.has(id));
    if (!ids.length) return;
    await acknowledgeObservedTalkMessages(requestSession, entry.contact, ids, signal);
    if (!owns()) return;
    for (const id of ids) entry.acknowledged.add(id);
    entry.pendingRead = entry.messages.some(message => !entry.acknowledged.has(message.id));
    entry.homePending = true;
  }

  function foregroundChanged() {
    stopReceive();
    receiveFailed = false;
    if (canReceive()) void refreshLatest();
    else publish();
  }

  function setHistoryCursor(entry: Conversation, page: TalkMessagePage) {
    entry.hasMore = page.hasMore;
    entry.nextCursor = page.nextCursor;
    entry.cursors = new Set(page.nextCursor ? [page.nextCursor] : []);
  }

  function mergeLatest(entry: Conversation, page: TalkMessagePage) {
    const previous = entry.messages;
    const positions = new Map(previous.map((message, index) => [message.id, index]));
    const firstKnown = page.messages.find(message => positions.has(message.id));
    const anchor = firstKnown ? positions.get(firstKnown.id)! : previous.length;
    const anchorGap = firstKnown ? entry.gaps.get(firstKnown.id) : undefined;
    const prefix = page.hasMore === false ? [] : previous.slice(0, anchor);
    for (const id of entry.gaps.keys()) {
      if (page.hasMore === false || (positions.get(id) ?? -1) > anchor) entry.gaps.delete(id);
    }
    if (page.hasMore === false || prefix.length === 0) setHistoryCursor(entry, page);
    const oldest = page.messages[0];
    if (oldest && page.hasMore !== false && prefix.length > 0 && !positions.has(oldest.id)) {
      if (firstKnown && anchorGap) entry.gaps.delete(firstKnown.id);
      entry.gaps.set(oldest.id, { cursor: page.nextCursor, seen: new Set(page.nextCursor ? [page.nextCursor] : []) });
    }
    // A background read never discards an acknowledged send before a producer
    // page has observed it, and never unlocks an uncertain send.
    for (const message of page.messages) entry.confirmed.delete(message.id);
    entry.messages = appendUniqueMobileItemsById(
      appendUniqueMobileItemsById(prefix, page.messages), [...entry.confirmed.values()],
    );
    for (const id of entry.gaps.keys()) {
      if (!entry.messages.some(message => message.id === id)) entry.gaps.delete(id);
    }
  }

  function conversation(contact: TalkContact) {
    const key = JSON.stringify([contact.type, contact.ap_id]);
    let entry = conversations.get(key);
    if (!entry) {
      entry = {
        contact, messages: [], content: "", draftRevision: 0, sending: false, uncertain: false,
        readError: "", sendError: "", sendOutcome: 0, confirmed: new Map(),
        hasMore: undefined, nextCursor: null, cursors: new Set(), historyError: "",
        gaps: new Map(),
        pendingRead: false, homePending: false, acknowledged: new Set(),
      };
      conversations.set(key, entry);
    }
    entry.contact = contact;
    return entry;
  }

  async function open(contact: TalkContact) {
    if (!active(authority)) return;
    dismissNotification();
    stopReceive();
    receiveFailed = false;
    const entry = conversation(contact);
    const expected = authority;
    const incarnation = ++view;
    readAbort?.abort();
    const read = new AbortController();
    readAbort = read;
    const requestSession = session;
    const sendOutcome = entry.sendOutcome;
    selected = entry;
    entry.confirmed.clear();
    entry.gaps.clear();
    entry.pendingRead = false;
    entry.acknowledged.clear();
    entry.homePending = false;
    loading = true;
    loadingOlder = false;
    entry.historyError = "";
    entry.readError = "";
    publish();
    try {
      await initializeObservedTalkRead(requestSession, contact, read.signal);
      if (!current(expected, incarnation, entry)) return;
      const page = await loadTalkMessagePage(requestSession, contact, read.signal);
      if (!current(expected, incarnation, entry)) return;
      const { messages } = page;
      entry.hasMore = page.hasMore;
      entry.nextCursor = page.nextCursor;
      entry.cursors = new Set(page.nextCursor ? [page.nextCursor] : []);
      for (const message of messages) entry.confirmed.delete(message.id);
      // A read started before a send ACK may omit that message. Merge only
      // ACKs received since this read began, preserving the producer page limit.
      entry.messages = appendUniqueMobileItemsById(messages, [...entry.confirmed.values()]);
      if (entry.sendOutcome === sendOutcome && !entry.sending) {
        entry.sendError = "";
        entry.uncertain = false;
      }
      entry.pendingRead = entry.messages.length > 0;
      loading = false;
      publish();
      // The loading fallback has now yielded to the rendered message list.
      // The view's queued tail-follow runs before querying its visible IDs.
      await Promise.resolve();
      if (!current(expected, incarnation, entry)) return;
      await acknowledgeVisible(entry, requestSession, read.signal, () => current(expected, incarnation, entry) && !read.signal.aborted);
      if (!current(expected, incarnation, entry)) return;
      await options.refreshHome();
      if (current(expected, incarnation, entry)) entry.homePending = false;
    } catch (cause) {
      if (!current(expected, incarnation, entry)) return;
      receiveFailed = true;
      entry.readError = errorMessage(cause, "トークを読み込めませんでした。");
    } finally {
      if (readAbort === read) readAbort = undefined;
      if (current(expected, incarnation, entry)) {
        loading = false;
        publish();
        scheduleReceive();
      }
    }
  }

  async function loadOlder() {
    const entry = selected;
    if (!active(authority) || !entry || loading || loadingOlder ||
      entry.hasMore !== true || !entry.nextCursor) return;
    stopReceive();
    const expected = authority;
    const incarnation = view;
    const cursor = entry.nextCursor;
    const requestSession = session;
    const read = new AbortController();
    readAbort?.abort();
    readAbort = read;
    loadingOlder = true;
    entry.historyError = "";
    publish();
    try {
      const page = await loadTalkMessagePage(requestSession, entry.contact, read.signal, cursor);
      if (!current(expected, incarnation, entry)) return;
      if (page.hasMore === undefined || (page.hasMore && (
        !page.nextCursor || entry.cursors.has(page.nextCursor) ||
        page.messages.every((message) => entry.messages.some((shown) => shown.id === message.id))
      ))) throw new Error("以前のメッセージの続きを確認できませんでした。もう一度読み込んでください。");
      entry.messages = prependUniqueMobileItemsByKey(page.messages, entry.messages, (message) => message.id);
      entry.pendingRead ||= page.messages.some(message => !entry.acknowledged.has(message.id));
      entry.hasMore = page.hasMore;
      entry.nextCursor = page.nextCursor;
      if (page.nextCursor) entry.cursors.add(page.nextCursor);
      // An older page is not a latest-state read or a read receipt. It must
      // never clear an uncertain send or repeat any message/read mutation.
    } catch (cause) {
      if (current(expected, incarnation, entry)) {
        entry.historyError = errorMessage(cause, "以前のメッセージを読み込めませんでした。");
      }
    } finally {
      if (readAbort === read) readAbort = undefined;
      if (current(expected, incarnation, entry)) {
        loadingOlder = false;
        publish();
        scheduleReceive();
      }
    }
  }

  async function loadGap(beforeId: string) {
    const entry = selected, gap = entry?.gaps.get(beforeId);
    if (!active(authority) || !entry || !gap?.cursor || loading || loadingOlder) return;
    stopReceive();
    const expected = authority, incarnation = view, requestSession = session, cursor = gap.cursor;
    const read = new AbortController();
    readAbort?.abort();
    readAbort = read;
    loadingOlder = true;
    entry.historyError = "";
    publish();
    try {
      const page = await loadTalkMessagePage(requestSession, entry.contact, read.signal, cursor);
      if (!current(expected, incarnation, entry) || entry.gaps.get(beforeId) !== gap) return;
      if (page.messages.some(message => !isBeforeCursor(message, cursor)) ||
        (page.hasMore && (!page.nextCursor || gap.seen.has(page.nextCursor)))) {
        throw new Error("メッセージの間の続きを確認できませんでした。もう一度確認してください。");
      }
      const split = entry.messages.findIndex(message => message.id === beforeId);
      if (split < 0) return;
      const older = entry.messages.slice(0, split), newer = entry.messages.slice(split);
      const firstKnown = page.messages.find(message => older.some(shown => shown.id === message.id));
      const anchor = firstKnown ? older.findIndex(message => message.id === firstKnown.id) : -1;
      const anchorGap = firstKnown ? entry.gaps.get(firstKnown.id) : undefined;
      const prefix = page.hasMore === false ? [] : firstKnown
        ? older.slice(0, anchor) : older;
      if (!firstKnown && page.hasMore !== false && page.messages.length === 0) {
        throw new Error("間のメッセージを確認できませんでした。");
      }
      for (const id of entry.gaps.keys()) {
        const position = entry.messages.findIndex(message => message.id === id);
        if (id === beforeId || (position < split && (
          page.hasMore === false || (anchor >= 0 && position > anchor)
        ))) entry.gaps.delete(id);
      }
      const extendsAnchor = firstKnown && anchorGap && page.messages[0]?.id !== firstKnown.id;
      if ((!firstKnown || extendsAnchor) && page.hasMore !== false) {
        if (firstKnown && anchorGap) entry.gaps.delete(firstKnown.id);
        const seen = new Set(gap.seen);
        if (page.nextCursor) seen.add(page.nextCursor);
        entry.gaps.set(page.messages[0]!.id, { cursor: page.nextCursor, seen });
      }
      entry.messages = appendUniqueMobileItemsById(
        appendUniqueMobileItemsById(prefix, page.messages), newer,
      );
      if (prefix.length === 0) setHistoryCursor(entry, page);
      for (const id of entry.gaps.keys()) {
        if (!entry.messages.some(message => message.id === id)) entry.gaps.delete(id);
      }
      // Gap/history reads do not acknowledge new messages or clear send uncertainty.
    } catch (cause) {
      if (current(expected, incarnation, entry)) entry.historyError = errorMessage(cause, "間のメッセージを読み込めませんでした。");
    } finally {
      if (readAbort === read) readAbort = undefined;
      if (current(expected, incarnation, entry)) {
        loadingOlder = false;
        publish();
        scheduleReceive();
      }
    }
  }

  function back() {
    if (disposed) return;
    dismissNotification();
    stopReceive();
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    selected = undefined;
    loading = false;
    loadingOlder = false;
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
    if (!active(authority) || !entry || entry.uncertain || !canSubmitMobileText({
      value: entry.content, disabled: loading || entry.sending, maxLength: 2000,
    })) return;
    const expected = authority;
    const requestSession = session;
    const contact = entry.contact;
    const content = entry.content;
    const revision = entry.draftRevision;
    const abort = new AbortController();
    entry.sendAbort = abort;
    entry.sending = true;
    entry.sendError = "";
    publish();
    let accepted = false;
    try {
      const message = contact.type === "community"
        ? await sendCommunityMessage(requestSession, contact.ap_id, content, abort.signal)
        : await sendUserMessage(requestSession, contact.ap_id, content, abort.signal);
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
      entry.uncertain = isUncertainMessageSend(cause);
      entry.sendError = errorMessage(cause, "メッセージを送れませんでした。");
    } finally {
      if (entry.sendAbort === abort) entry.sendAbort = undefined;
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
    notificationAbort?.abort();
    notificationAbort = undefined;
    notification = undefined;
    stopReceive();
    sessionKey = key;
    authority += 1;
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    for (const entry of conversations.values()) entry.sendAbort?.abort();
    conversations.clear();
    selected = undefined;
    loading = false;
    loadingOlder = false;
    publish();
  }

  function dispose() {
    notificationAbort?.abort();
    notificationAbort = undefined;
    notification = undefined;
    stopReceive();
    disposed = true;
    authority += 1;
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    for (const entry of conversations.values()) entry.sendAbort?.abort();
    conversations.clear();
    selected = undefined;
    loading = false;
    loadingOlder = false;
  }

  return { state, open, openNotification, retryNotification, dismissNotification, loadOlder, loadGap, back, setDraft, send, updateSession, foregroundChanged,
    readVisible: () => { void refreshLatest(false); }, dispose };
}


function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function isBeforeCursor(message: TalkMessage, cursor: string): boolean {
  if (!message.created_at || !Number.isFinite(Date.parse(message.created_at))) return false;
  // Core's keyset uses binary UTF-8 text order, not JavaScript's UTF-16 order.
  const encoder = new TextEncoder();
  const value = encoder.encode(`${message.created_at} ${message.id}`), bound = encoder.encode(cursor);
  for (let index = 0; index < Math.min(value.length, bound.length); index++) {
    if (value[index] !== bound[index]) return value[index]! < bound[index]!;
  }
  return value.length < bound.length;
}
