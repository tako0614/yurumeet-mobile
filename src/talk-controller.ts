import { talkSessionIdentity } from "./talk-session.ts";
import type { TalkMessagePage, TalkRequest } from "./talk-response.ts";
import type { TalkNotificationRequest } from "./talk-notification.ts";
import { createTalkMessageActions, type TalkMessageActionState } from "./talk-message-actions.ts";
import { createTalkAttachmentDraft, type TalkDraftAttachment } from "./talk-attachments.ts";
import { TalkRecoveryError, type createTalkRecoveryStore, type TalkRecoveryDraft, type TalkRecoveryIntent, type TalkExpiredRecoveryReview } from "./talk-recovery.ts";
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
  uploadTalkAttachment,
  isUncertainMessageSend,
  loadTalkNotificationContact,
  loadTalkRequests,
  loadTalkRequestContact,
  loadTalkRecoveryContact,
  rejectTalkRequest,
  type TalkContact,
  type TalkMessage,
} from "./api.ts";

export interface TalkState {
  readonly retainedContacts: readonly TalkContact[];
  readonly attachments: readonly TalkDraftAttachment[];
  readonly attachmentError: string;
  readonly canAddAttachments: boolean;
  readonly messageAction?: TalkMessageActionState;
  readonly canManageMessages: boolean;
  readonly requests?: {
    readonly visible: boolean;
    readonly items: readonly TalkRequest[];
    readonly loading: boolean;
    readonly opening?: string;
    readonly rejecting: boolean;
    readonly confirmation?: TalkRequest;
    readonly needsRefresh: boolean;
    readonly error: string;
  };
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
  readonly recovery?: {
    readonly ready: boolean; readonly loading: boolean; readonly saving: boolean; readonly error: string;
    readonly drafts: readonly TalkRecoveryDraft[];
    readonly intent?: TalkRecoveryIntent;
    readonly canConfirmReview: boolean;
    readonly canReviewExpired: boolean;
    readonly reviewingExpired: boolean;
    readonly expiredDrafts?: readonly TalkRecoveryDraft[];
  };
}

interface Conversation {
  localSend: boolean;
  attachments?: ReturnType<typeof createTalkAttachmentDraft>;
  messageActions?: ReturnType<typeof createTalkMessageActions>;
  contact: TalkContact;
  messages: readonly TalkMessage[];
  content: string;
  draftRevision: number;
  sending: boolean;
  uncertain: boolean;
  sendIntent?: TalkRecoveryIntent;
  restoredIntent?: boolean;
  recoveryRead?: boolean;
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
  actorApId?: string;
  refreshHome: () => Promise<void>;
  onChange?: (state: TalkState) => void;
  isActive?: () => boolean;
  observedMessageIds: () => readonly string[];
  /** Product-owned durable storage; it supplies neither authorization nor a send receipt. */
  recovery?: Pick<ReturnType<typeof createTalkRecoveryStore>, "save"> & Partial<Pick<ReturnType<typeof createTalkRecoveryStore>, "load" | "reviewExpired">>;
  receive?: {
    isForeground: () => boolean;
    canMarkRead?: () => boolean;
    schedule?: (work: () => void, delayMs: number) => () => void;
  };
}) {
  let session = { ...options.session };
  let actorApId = options.actorApId;
  let sessionKey = talkSessionIdentity(session);
  let authority = 0;
  let view = 0;
  let disposed = false;
  // A recovery port belongs to this controller's initial credential epoch.
  // A replacement epoch must construct its own controller/verified port.
  let recoveryRetired = false;
  let recoveryRevision = 0;
  let savedRecoveryRevision = 0;
  let recoveryLoaded = !options.recovery?.load, recoveryError = "", recoverySaving = 0;
  let recoveryContactError = "";
  let recoveryExpired = false, expiredReviewEpoch = 0, expiredReviewReads = 0;
  let expiredReview: TalkExpiredRecoveryReview | undefined;
  let recoveryLoad: Promise<void> | undefined, recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const recovered = new Map<string, TalkRecoveryDraft>();
  let selected: Conversation | undefined;
  let loading = false;
  let loadingOlder = false;
  let readAbort: AbortController | undefined;
  let receiveAbort: AbortController | undefined;
  let cancelReceive: (() => void) | undefined;
  let receiveFailed = false;
  let notificationAbort: AbortController | undefined;
  let notification: { request: TalkNotificationRequest; recipient: string; loading: boolean; error: string } | undefined;
  let requestsVisible = false, returnToRequests = false;
  let requestItems: TalkRequest[] = [], requestError = "", requestNeedsRefresh = true;
  let requestConfirmation: TalkRequest | undefined;
  let requestOpening: string | undefined;
  let requestWork: "list" | "open" | "reject" | undefined;
  let requestAbort: AbortController | undefined;
  const conversations = new Map<string, Conversation>();

  function state(): TalkState {
    return {
      // Home readback can fail after the first send. Keep unfinished local
      // work reachable independently of the server's latest contact list.
      retainedContacts: [...conversations.values()]
        .filter(entry => entry.localSend || entry.content.length > 0 || !!entry.attachments?.state().items.length || !!entry.messageActions?.state())
        .map(entry => ({ ...entry.contact, last_message: entry.contact.last_message ? { ...entry.contact.last_message } : null })),
      attachments: selected?.attachments?.state().items ?? [],
      attachmentError: selected?.attachments?.state().error ?? "",
      canAddAttachments: active(authority) && recoveryLoaded && !!actorApId && !!selected && !loading && !selected.messageActions?.state() && selected.attachments?.state().canAdd === true,
      messageAction: selected?.messageActions?.state(),
      canManageMessages: active(authority) && !!actorApId && !!selected && !loading && !loadingOlder &&
        !selected.sending && !selected.uncertain && !selected.messageActions?.state(),
      requests: requestsVisible || returnToRequests ? {
        visible: requestsVisible, items: [...requestItems], loading: requestWork === "list",
        opening: requestOpening, rejecting: requestWork === "reject", confirmation: requestConfirmation,
        needsRefresh: requestNeedsRefresh, error: requestError,
      } : undefined,
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
      canSend: canSend(selected),
      error: selected?.sendError || selected?.readError || "",
      recovery: options.recovery ? { ready: recoveryLoaded, loading: !recoveryLoaded && !!recoveryLoad, saving: recoverySaving > 0,
        error: recoveryError || recoveryContactError, drafts: [...recovered.values()], intent: selected?.restoredIntent ? selected.sendIntent : undefined,
        canConfirmReview: !!selected?.restoredIntent && selected.recoveryRead === true && !loading && !selected.sending && recoverySaving === 0,
        canReviewExpired: recoveryExpired && !!options.recovery.reviewExpired && !recoveryLoaded && !recoveryLoad && recoverySaving === 0 && expiredReviewReads === 0 && !expiredReview,
        reviewingExpired: expiredReviewReads > 0,
        expiredDrafts: expiredReview?.drafts } : undefined,
    };
  }

  function publish() {
    if (active(authority)) options.onChange?.(state());
  }

  function canSend(entry: Conversation | undefined): boolean {
    const draft = entry?.attachments?.snapshot();
    return active(authority) && !recoveryRetired && recoveryLoaded && !recoveryError && !!entry && !!draft && !loading && !entry.sending && !entry.uncertain && !entry.messageActions?.state() &&
      (canSubmitMobileText({ value: entry.content, maxLength: 2000 }) || (!entry.content.trim() && draft.attachments.length > 0));
  }

  function recoveryDrafts(): TalkRecoveryDraft[] {
    const drafts: TalkRecoveryDraft[] = [...recovered.values()];
    for (const entry of conversations.values()) {
      const attachments = entry.attachments?.recoverySnapshot() ?? [];
      const base = { contact: { type: entry.contact.type, apId: entry.contact.ap_id }, content: entry.content, attachments };
      if (entry.sendIntent) drafts.push({ ...base, sendState: entry.sending && !entry.uncertain ? "pending" : "uncertain", intent: entry.sendIntent });
      else if (entry.content.trim() || attachments.length) drafts.push({ ...base, sendState: "draft" });
    }
    return drafts;
  }

  async function checkpointRecovery(expected: number) {
    if (!options.recovery) return;
    if (!recoveryLoaded) throw new Error("保存済みの下書きの確認が必要です。");
    let revision: number;
    do {
      if (!active(expected)) return;
      revision = recoveryRevision;
      await options.recovery.save(recoveryDrafts());
      if (active(expected)) savedRecoveryRevision = revision;
    } while (active(expected) && recoveryRevision !== revision);
  }

  function restoreRecovery(): Promise<void> {
    if (recoveryLoaded || !options.recovery?.load || recoveryRetired) return Promise.resolve();
    if (recoveryLoad) return recoveryLoad;
    const expected = authority;
    recoveryError = "";
    recoveryExpired = false; expiredReview = undefined; expiredReviewEpoch++;
    recoveryLoad = (async () => {
      try {
        const drafts = await options.recovery!.load!();
        if (!active(expected)) return;
        for (const item of drafts ?? []) {
          const key = JSON.stringify([item.contact.type, item.contact.apId]);
          recovered.set(key, item);
          const entry = conversations.get(key);
          if (entry) adoptSaved(entry, key);
        }
        recoveryLoaded = true;
      } catch (cause) {
        if (active(expected)) {
          recoveryExpired = cause instanceof TalkRecoveryError && cause.code === "expired";
          recoveryError = recoveryExpired ? "保存した下書きの期限が切れています。内容を確認してから復元できます。" :
            "保存済みの下書きを確認できませんでした。再確認するまで保存・送信を待機します。";
        }
      }
      finally { if (active(expected)) { recoveryLoad = undefined; publish(); } }
    })();
    publish();
    return recoveryLoad;
  }

  async function flushRecovery() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    if (!options.recovery || recoveryRetired || !active(authority)) return;
    if (!recoveryLoaded) await restoreRecovery();
    if (!recoveryLoaded || recoveryRetired || !active(authority)) return;
    const expected = authority;
    recoverySaving++; publish();
    try { await checkpointRecovery(expected); if (active(expected)) { recoveryError = ""; recoveryContactError = ""; } }
    catch { if (active(expected)) recoveryError = "下書きの保存を確認できませんでした。保存を再試行してください。"; }
    finally { recoverySaving--; publish(); }
  }

  async function reviewExpiredRecovery() {
    if (!active(authority) || recoveryRetired || !state().recovery?.canReviewExpired) return;
    const expected = authority, epoch = ++expiredReviewEpoch;
    expiredReviewReads++; publish();
    try {
      const review = await options.recovery!.reviewExpired!();
      if (active(expected) && epoch === expiredReviewEpoch) expiredReview = review;
    } catch {
      if (active(expected) && epoch === expiredReviewEpoch) recoveryError = "期限切れの下書きを確認できませんでした。保存データは変更していません。再確認してください。";
    } finally { expiredReviewReads--; publish(); }
  }

  async function restoreExpiredRecovery() {
    const review = expiredReview;
    if (!review || recoverySaving || !active(authority) || recoveryRetired) return;
    const expected = authority, epoch = expiredReviewEpoch;
    recoverySaving++; publish();
    try {
      await review.restore();
      if (!active(expected) || epoch !== expiredReviewEpoch) return;
      expiredReview = undefined;
      await restoreRecovery();
    } catch {
      if (active(expected) && epoch === expiredReviewEpoch) {
        expiredReview = undefined;
        recoveryError = "期限切れの下書きの復元を確認できませんでした。保存済みの下書きを再確認してください。";
      }
    } finally { recoverySaving--; publish(); }
  }

  function cancelExpiredRecoveryReview() {
    if (recoverySaving) return;
    expiredReview = undefined; expiredReviewEpoch++; publish();
  }

  async function confirmRecoveryReview() {
    const entry = selected;
    if (!entry || !state().recovery?.canConfirmReview || recoveryRetired || !active(authority)) return;
    // This records a user's review decision, never a delivery ACK.
    entry.restoredIntent = false; entry.sendIntent = undefined; entry.uncertain = false;
    entry.sendError = ""; recoveryRevision++;
    await flushRecovery();
    publish();
  }

  function changedRecovery() {
    recoveryRevision++;
    if (!options.recovery || !recoveryLoaded || recoveryRetired || recoveryError) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void flushRecovery(); }, 150);
  }

  function adoptSaved(entry: Conversation, key: string) {
    const saved = recovered.get(key);
    if (!saved) return;
    recovered.delete(key);
    if (entry.draftRevision === 0) entry.content = saved.content;
    if (saved.sendState !== "draft") {
      entry.sendIntent = saved.intent; entry.restoredIntent = true; entry.uncertain = true; entry.localSend = true;
    }
    entry.attachments?.restore(saved.attachments);
  }

  async function openRecovered(item: TalkRecoveryDraft) {
    if (!active(authority) || !recoveryLoaded) return;
    const key = JSON.stringify([item.contact.type, item.contact.apId]);
    if (recovered.get(key) !== item) return;
    const expected = authority, incarnation = ++view;
    readAbort?.abort(); const read = new AbortController(); readAbort = read;
    try {
      const contact = await loadTalkRecoveryContact(session, { type: item.contact.type, ap_id: item.contact.apId }, read.signal);
      if (active(expected) && view === incarnation && !read.signal.aborted) { recoveryContactError = ""; await open(contact); }
    } catch { if (active(expected) && view === incarnation) { recoveryContactError = "保存した相手を確認できませんでした。下書きは保持しています。もう一度開いてください。"; publish(); } }
    finally { if (readAbort === read) readAbort = undefined; }
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

  function notificationForeground() {
    return options.receive?.isForeground() !== false;
  }

  function suspendNotification() {
    if (!notificationAbort) return;
    const read = notificationAbort;
    notificationAbort = undefined;
    read.abort();
    if (notification) notification = { ...notification, loading: false,
      error: "通知先の確認を中断しました。画面に戻ってから再確認してください。" };
  }

  async function openNotification(request: TalkNotificationRequest, recipient: string) {
    if (!active(authority) || !notificationForeground() || request.sessionKey !== sessionKey) return;
    stopRequests();
    notificationAbort?.abort();
    const read = new AbortController();
    notificationAbort = read;
    notification = { request, recipient, loading: true, error: "" };
    const expected = authority, incarnation = view;
    const owns = () => active(expected) && notificationForeground() && view === incarnation && notificationAbort === read && !read.signal.aborted;
    publish();
    try {
      const contact = await loadTalkNotificationContact(session, request, recipient, read.signal, owns);
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
      if (notificationAbort === read) {
        if (notificationForeground()) notificationAbort = undefined;
        else { suspendNotification(); publish(); }
      }
    }
  }

  function retryNotification() {
    if (!notification || notification.loading) return Promise.resolve();
    return openNotification(notification.request, notification.recipient);
  }

  function stopRequests() {
    requestAbort?.abort();
    requestAbort = undefined;
    requestWork = undefined;
    requestOpening = undefined;
    requestConfirmation = undefined;
    requestsVisible = false;
    returnToRequests = false;
  }

  async function showRequests() {
    if (!active(authority)) return;
    dismissNotification();
    stopRequests();
    stopReceive();
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    selected = undefined;
    loading = false;
    loadingOlder = false;
    requestsVisible = true;
    await refreshRequests();
  }

  async function refreshRequests() {
    if (!active(authority) || !requestsVisible || requestAbort) return;
    requestConfirmation = undefined;
    requestNeedsRefresh = true;
    requestError = "";
    requestWork = "list";
    const read = new AbortController(), expected = authority, incarnation = view;
    requestAbort = read;
    const owns = () => active(expected) && requestsVisible && view === incarnation && requestAbort === read && !read.signal.aborted;
    publish();
    try {
      const items = await loadTalkRequests(session, read.signal);
      if (!owns()) return;
      requestItems = items;
      requestNeedsRefresh = false;
    } catch {
      if (owns()) requestError = "リクエストを確認できませんでした。一覧を更新して、現在の状態を確認してください。";
    } finally {
      if (requestAbort === read) { requestAbort = undefined; requestWork = undefined; }
      if (active(expected) && requestsVisible && view === incarnation) publish();
    }
  }

  function currentRequest(item: TalkRequest) {
    return active(authority) && requestsVisible && !requestNeedsRefresh && !requestAbort && requestItems.includes(item);
  }

  async function openRequest(item: TalkRequest) {
    if (!currentRequest(item)) return;
    requestConfirmation = undefined;
    requestError = "";
    requestWork = "open";
    requestOpening = item.id;
    const read = new AbortController(), expected = authority, incarnation = view;
    requestAbort = read;
    const owns = () => active(expected) && requestsVisible && view === incarnation && requestAbort === read && !read.signal.aborted;
    publish();
    try {
      const contact = await loadTalkRequestContact(session, item.sender.ap_id, read.signal);
      if (!owns()) return;
      requestAbort = undefined;
      requestWork = undefined;
      requestOpening = undefined;
      await open(contact, true);
    } catch {
      if (owns()) requestError = "この相手のトークを開けませんでした。一覧からもう一度選べます。";
    } finally {
      if (requestAbort === read) { requestAbort = undefined; requestWork = undefined; requestOpening = undefined; publish(); }
    }
  }

  function peerSendUnresolved(item: TalkRequest) {
    const entry = conversations.get(JSON.stringify(["user", item.sender.ap_id]));
    const action = entry?.messageActions?.state();
    return !!entry && (entry.sending || entry.uncertain || !!action?.pending || (!!action?.needsReadback && !action.canCancel));
  }

  function confirmRejectRequest(item: TalkRequest) {
    if (!currentRequest(item)) return;
    if (peerSendUnresolved(item)) {
      requestError = "この相手への送信結果または変更結果が未確認です。先にトークを開いて確認してください。";
    } else {
      requestConfirmation = item;
      requestError = "";
    }
    publish();
  }

  function cancelRejectRequest() { requestConfirmation = undefined; publish(); }

  async function rejectRequest() {
    const item = requestConfirmation;
    if (!item || !currentRequest(item) || peerSendUnresolved(item)) return;
    requestConfirmation = undefined;
    // From dispatch until a successful list read, the outcome is unconfirmed.
    // Closing/canceling the view cannot undo a committed server deletion.
    requestNeedsRefresh = true;
    requestWork = "reject";
    requestError = "";
    const read = new AbortController(), expected = authority, incarnation = view;
    requestAbort = read;
    const requestSession = session;
    const owns = () => active(expected) && requestsVisible && view === incarnation && requestAbort === read && !read.signal.aborted;
    let acknowledged = false;
    publish();
    try {
      await rejectTalkRequest(requestSession, item.sender.ap_id, read.signal);
      if (!owns()) return;
      acknowledged = true;
      // The public API selects the peer's current conversation, not a row ID.
      // A different older conversation for the same sender may remain pending.
      const items = await loadTalkRequests(requestSession, read.signal);
      if (!owns()) return;
      requestItems = items;
      requestNeedsRefresh = false;
      await options.refreshHome();
    } catch (cause) {
      if (owns()) requestError = acknowledged
        ? "拒否しましたが、一覧または件数を確認できませんでした。一覧を更新してください。"
        : cause instanceof MobileApiError && cause.status === 404
          ? "このサーバーは安全なリクエスト拒否に対応していません。サーバーの更新が必要です。"
        : cause instanceof MobileApiError && cause.status === 409
          ? "リクエストの状態が変わりました。一覧を更新してください。先に完了した削除がある場合があります。"
        : "拒否の結果を確認できませんでした。一覧を更新して現在の状態を確認してください。自動で再実行はしません。";
    } finally {
      if (requestAbort === read) { requestAbort = undefined; requestWork = undefined; }
      if (active(expected) && requestsVisible && view === incarnation) publish();
    }
  }

  function canReceive() {
    return !!options.receive && options.receive.isForeground() && active(authority) && !!selected && !selected.messageActions?.state();
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
    if (!notificationForeground()) suspendNotification();
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
        contact, localSend: false, messages: [], content: "", draftRevision: 0, sending: false, uncertain: false,
        readError: "", sendError: "", sendOutcome: 0, confirmed: new Map(),
        hasMore: undefined, nextCursor: null, cursors: new Set(), historyError: "",
        gaps: new Map(),
        pendingRead: false, homePending: false, acknowledged: new Set(),
      };
      conversations.set(key, entry);
      const owned = entry, expected = authority;
      entry.attachments = createTalkAttachmentDraft({
        active: () => !disposed && authority === expected && conversations.get(key) === owned,
        upload: (file, signal) => uploadTalkAttachment(session, file, signal),
        onChange: () => { changedRecovery(); publish(); },
      });
      adoptSaved(owned, key);
      entry.messageActions = createTalkMessageActions({
        contact: { type: owned.contact.type, ap_id: owned.contact.ap_id },
        session: () => session, actor: () => actorApId,
        active: () => active(expected) && conversations.get(key) === owned,
        isCurrent: () => selected === owned && !loading && !loadingOlder && !owned.sending && !owned.uncertain,
        message: id => owned.messages.find(message => message.id === id),
        pauseReads() {
          if (selected !== owned) return;
          dismissNotification(); stopReceive(); view += 1; readAbort?.abort(); readAbort = undefined;
        },
        adopt(message) {
          owned.messages = owned.messages.map(previous => previous.id === message.id ? message : previous);
          if (owned.confirmed.has(message.id)) owned.confirmed.set(message.id, message);
        },
        remove(id) {
          const index = owned.messages.findIndex(message => message.id === id), next = index >= 0 ? owned.messages[index + 1] : undefined;
          const gap = owned.gaps.get(id);
          owned.messages = owned.messages.filter(message => message.id !== id);
          owned.confirmed.delete(id); owned.acknowledged.delete(id); owned.gaps.delete(id);
          if (gap && next && !owned.gaps.has(next.id)) owned.gaps.set(next.id, gap);
          else if (gap && !next) {
            owned.hasMore = undefined;
            owned.historyError = "削除したメッセージの前後に未確認の履歴があります。トークを更新して確認してください。";
          }
        },
        onChange: publish,
        onIdle: () => { if (selected === owned) scheduleReceive(); },
        async afterCommit() {
          try { await options.refreshHome(); }
          catch { if (active(expected)) { owned.readError = "変更は保存しましたが、トーク一覧を更新できませんでした。"; publish(); } }
        },
      });
    }
    entry.contact = contact;
    return entry;
  }

  async function open(contact: TalkContact, fromRequest = false) {
    if (!active(authority)) return;
    const openingEpoch = authority;
    if (!recoveryLoaded) { await restoreRecovery(); if (!active(openingEpoch)) return; }
    selected?.messageActions?.abortRead();
    dismissNotification();
    stopRequests();
    returnToRequests = fromRequest;
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
    if (entry.messageActions?.state()?.pending) {
      loading = false; loadingOlder = false; publish(); return;
    }
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
        if (!entry.restoredIntent && (entry.uncertain || entry.sendIntent)) { entry.uncertain = false; entry.sendIntent = undefined; changedRecovery(); }
      }
      entry.recoveryRead = true;
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
    if (!active(authority) || !entry || entry.messageActions?.state() || loading || loadingOlder ||
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
    if (!active(authority) || !entry || entry.messageActions?.state() || !gap?.cursor || loading || loadingOlder) return;
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
    selected?.messageActions?.abortRead();
    const inbox = returnToRequests;
    stopRequests();
    dismissNotification();
    stopReceive();
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    selected = undefined;
    loading = false;
    loadingOlder = false;
    if (inbox) { requestsVisible = true; void refreshRequests(); }
    publish();
  }

  function setDraft(value: string) {
    if (disposed || !selected || selected.content === value || !recoveryLoaded) return;
    selected.content = value;
    selected.draftRevision += 1;
    changedRecovery();
    publish();
  }

  function captureAttachmentSelection() {
    const entry = selected, expected = authority, incarnation = view;
    return (files: readonly File[]): boolean => {
      if (!entry || !current(expected, incarnation, entry) || !state().canAddAttachments) return false;
      entry.attachments?.add(files); return true;
    };
  }

  function reload() {
    if (selected?.messageActions?.state()?.pending) return Promise.resolve();
    return selected ? open(selected.contact, returnToRequests) : Promise.resolve();
  }

  async function send() {
    const entry = selected;
    if (!entry || !canSend(entry)) { publish(); return; }
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    const draft = entry.attachments?.snapshot();
    if (!draft) { publish(); return; }
    const expected = authority;
    const requestSession = session;
    const contact = entry.contact;
    const content = entry.content;
    const revision = entry.draftRevision;
    if (options.recovery) {
      entry.sendIntent = { attemptId: crypto.randomUUID(), content,
        attachments: (entry.attachments?.recoverySnapshot() ?? []).flatMap(item => item.phase === "ready" ? [item.upload] : []) };
      recoveryRevision++;
    }
    const abort = new AbortController();
    entry.sendAbort = abort;
    // Navigation is local work, independent of message/read ACK retirement.
    // It lasts only as long as this account's in-memory conversation map.
    entry.localSend = true;
    entry.sending = true;
    entry.sendError = "";
    publish();
    let accepted = false;
    let dispatched = false;
    let checkpointConfirmed = !options.recovery;
    try {
      if (options.recovery) {
        await checkpointRecovery(expected);
        if (!active(expected)) return;
        checkpointConfirmed = true;
        if (entry.sendIntent?.attachments.some(upload => Date.parse(upload.expiresAt) <= Date.now())) {
          throw new Error("添付の期限が切れたため送信しませんでした。もう一度準備してください。");
        }
      }
      dispatched = true;
      const message = contact.type === "community"
        ? await sendCommunityMessage(requestSession, contact.ap_id, content, abort.signal, draft.attachments, actorApId)
        : await sendUserMessage(requestSession, contact.ap_id, content, abort.signal, draft.attachments, actorApId);
      if (!active(expected)) return;
      accepted = true;
      entry.sendIntent = undefined;
      recoveryRevision++;
      entry.confirmed.set(message.id, message);
      entry.messages = appendUniqueMobileItemsById(entry.messages, [message]);
      entry.sendOutcome += 1;
      entry.attachments?.commit(draft.ids);
      if (entry.draftRevision === revision) {
        entry.content = "";
        entry.draftRevision += 1;
      }
      publish();
    } catch (cause) {
      if (!active(expected)) return;
      entry.sendOutcome += 1;
      entry.uncertain = dispatched && isUncertainMessageSend(cause);
      if (!entry.uncertain) entry.sendIntent = undefined;
      recoveryRevision++;
      entry.sendError = errorMessage(cause, "メッセージを送れませんでした。");
      if (!checkpointConfirmed) recoveryError = "下書きの保存を確認できませんでした。保存を再試行してください。";
    } finally {
      if (entry.sendAbort === abort) entry.sendAbort = undefined;
      if (active(expected)) {
        if (dispatched && options.recovery) {
          try { await checkpointRecovery(expected); }
          catch {
            if (active(expected)) {
              recoveryError = "下書きの保存を確認できませんでした。保存を再試行してください。";
              entry.sendError = accepted
                ? "送信は確認済みですが、下書きの保存を確認できませんでした。再送せず接続を確認してください。"
                : "送信結果と下書きの保存を確認できませんでした。自動再送は行いません。";
            }
          }
        }
        if (active(expected)) { entry.sending = false; publish(); }
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
    actorApId = undefined;
    retireConversations();
  }

  function updateActor(next: string | undefined) {
    if (disposed || !next || next === actorApId) return;
    const changed = actorApId !== undefined;
    actorApId = next;
    if (changed) retireConversations();
    else publish();
  }

  function retireConversations() {
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    recoveryRetired = !!options.recovery;
    recovered.clear(); recoveryError = ""; recoveryContactError = "";
    recoveryExpired = false; expiredReview = undefined; expiredReviewEpoch++;
    // The old storage port is permanently closed, but new in-memory input is
    // still local work until the caller replaces this controller's epoch.
    recoveryLoaded = true;
    stopRequests();
    requestItems = [];
    requestError = "";
    requestNeedsRefresh = true;
    notificationAbort?.abort();
    notificationAbort = undefined;
    notification = undefined;
    stopReceive();
    authority += 1;
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    for (const entry of conversations.values()) { entry.sendAbort?.abort(); entry.messageActions?.dispose(); entry.attachments?.dispose(); }
    conversations.clear();
    selected = undefined;
    loading = false;
    loadingOlder = false;
    publish();
  }

  function dispose() {
    if (options.recovery && recoveryLoaded && !recoveryError && !recoveryRetired && savedRecoveryRevision !== recoveryRevision) void flushRecovery();
    clearTimeout(recoveryTimer); recoveryTimer = undefined;
    stopRequests();
    requestItems = [];
    notificationAbort?.abort();
    notificationAbort = undefined;
    notification = undefined;
    stopReceive();
    disposed = true;
    expiredReview = undefined; expiredReviewEpoch++;
    authority += 1;
    view += 1;
    readAbort?.abort();
    readAbort = undefined;
    for (const entry of conversations.values()) { entry.sendAbort?.abort(); entry.messageActions?.dispose(); entry.attachments?.dispose(); }
    conversations.clear();
    selected = undefined;
    loading = false;
    loadingOlder = false;
  }

  return { state, open, openNotification, retryNotification, dismissNotification, showRequests, refreshRequests, openRequest,
    confirmRejectRequest, cancelRejectRequest, rejectRequest, loadOlder, loadGap, back, reload, setDraft, send, updateSession, updateActor, foregroundChanged,
    addAttachments: (files: readonly File[]) => { if (state().canAddAttachments) selected?.attachments?.add(files); },
    captureAttachmentSelection,
    retryAttachment: (id: number) => selected?.attachments?.retry(id),
    removeAttachment: (id: number) => selected?.attachments?.remove(id),
    beginMessageEdit: (id: string) => selected?.messageActions?.begin("edit", id) ?? Promise.resolve(),
    beginMessageDelete: (id: string) => selected?.messageActions?.begin("delete", id) ?? Promise.resolve(),
    setMessageEditContent: (value: string) => selected?.messageActions?.setContent(value),
    saveMessageEdit: () => selected?.messageActions?.submit("edit") ?? Promise.resolve(),
    confirmMessageDelete: () => selected?.messageActions?.submit("delete") ?? Promise.resolve(),
    cancelMessageAction: () => selected?.messageActions?.cancel(),
    reconcileMessageAction: () => selected?.messageActions?.reconcile() ?? Promise.resolve(),
    restoreRecovery, flushRecovery, confirmRecoveryReview, openRecovered,
    reviewExpiredRecovery, restoreExpiredRecovery, cancelExpiredRecoveryReview,
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
