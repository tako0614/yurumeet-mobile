import { MobileApiError, type MobileSession } from "@takosjp/mobile-kit";
import { loadOwnedTalkMessage, editOwnedTalkMessage, deleteOwnedTalkMessage, loadOwnedGroupTalkMessage, editOwnedGroupTalkMessage, deleteOwnedGroupTalkMessage, type TalkMessage, type TalkContact } from "./api.ts";

export interface TalkMessageActionState {
  readonly id: string;
  readonly kind: "edit" | "delete";
  readonly content: string;
  readonly serverContent: string;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly needsReadback: boolean;
  readonly unavailable: boolean;
  readonly error: string;
  readonly canSave: boolean;
  readonly canCancel: boolean;
}

interface Action {
  id: string;
  actor: string;
  kind: "edit" | "delete";
  content: string;
  serverContent: string;
  revision?: string;
  draftRevision: number;
  loading: boolean;
  pending: boolean;
  needsReadback: boolean;
  unavailable: boolean;
  error: string;
  submitted?: { content: string; draftRevision: number };
}

/** A conversation owns its draft and write even when its view is elsewhere. */
export function createTalkMessageActions(options: {
  session: () => MobileSession;
  contact: Pick<TalkContact, "type" | "ap_id">;
  actor: () => string | undefined;
  active: () => boolean;
  isCurrent: () => boolean;
  message: (id: string) => TalkMessage | undefined;
  pauseReads: () => void;
  adopt: (message: TalkMessage) => void;
  remove: (id: string) => void;
  onChange: () => void;
  onIdle: () => void;
  afterCommit: () => Promise<void>;
}) {
  let action: Action | undefined;
  let readAbort: AbortController | undefined, writeAbort: AbortController | undefined;
  let disposed = false;
  const active = () => !disposed && options.active();
  const owns = (item: Action) => active() && action === item && options.actor() === item.actor;
  function state(): TalkMessageActionState | undefined {
    if (!action) return;
    const item = action;
    return { id: item.id, kind: item.kind, content: item.content, serverContent: item.serverContent,
      loading: item.loading, pending: item.pending, needsReadback: item.needsReadback,
      unavailable: item.unavailable, error: item.error,
      canSave: owns(item) && options.isCurrent() && !item.loading && !item.pending && !item.needsReadback && !item.unavailable && !!item.revision &&
        (item.kind === "delete" || (!!item.content.trim() && item.content.trim().length <= 5000 && item.content.trim() !== item.serverContent)),
      canCancel: !item.pending && !(item.submitted && item.needsReadback) };
  }
  function emit() { if (active()) options.onChange(); }
  function idle() { emit(); options.onIdle(); }

  function abortRead() {
    if (!readAbort) return;
    const read = readAbort; readAbort = undefined; read.abort();
    if (action) { action.loading = false; action.needsReadback = true; action.error = "メッセージの確認を中断しました。再確認してください。"; }
  }

  async function read(initial = false) {
    const item = action;
    if (!item || !owns(item) || !options.isCurrent() || item.pending || readAbort) return;
    options.pauseReads();
    const abort = new AbortController(), session = options.session(), draft = item.draftRevision;
    readAbort = abort;
    item.loading = true; item.error = "";
    const current = () => owns(item) && readAbort === abort && !abort.signal.aborted;
    emit();
    try {
      const found = options.contact.type === "community"
        ? await loadOwnedGroupTalkMessage(session, options.contact.ap_id, item.id, item.actor, abort.signal)
        : await loadOwnedTalkMessage(session, item.id, item.actor, abort.signal);
      if (!current()) return;
      item.needsReadback = false;
      if (!found) {
        options.remove(item.id);
        if (item.kind === "delete") action = undefined;
        else { item.unavailable = true; item.revision = undefined; item.submitted = undefined;
          item.error = "このメッセージは現在利用できません。編集中の本文は残しています。"; }
      } else {
        if (item.kind === "delete" && options.contact.type === "community" && !("conditionalDelete" in found && found.conditionalDelete)) {
          item.needsReadback = true; item.revision = undefined;
          item.error = "このサーバーは安全なグループ削除に対応していません。サーバーの更新が必要です。";
          return;
        }
        options.adopt(found.message);
        item.revision = found.revision; item.serverContent = found.message.content ?? ""; item.unavailable = false;
        if (initial && item.draftRevision === draft) item.content = item.serverContent;
        if (!initial && item.kind === "edit" && item.submitted && item.submitted.content === item.serverContent && item.draftRevision === item.submitted.draftRevision) {
          action = undefined;
        } else {
          if (!initial && item.kind === "edit") item.error = "現在の本文を確認しました。編集内容は残しています。確認してから保存してください。";
          if (!initial && item.kind === "delete") item.error = "メッセージは残っています。現在の本文を確認してから削除してください。";
          item.submitted = undefined;
        }
      }
    } catch {
      if (current()) { item.needsReadback = true; item.error = "メッセージを確認できませんでした。接続とサーバーの対応を確認してから再確認してください。"; }
    } finally {
      if (readAbort === abort) { readAbort = undefined; item.loading = false; idle(); }
    }
  }

  async function begin(kind: Action["kind"], id: string) {
    const actor = options.actor(), message = options.message(id);
    if (!active() || !options.isCurrent() || !actor || message?.sender.ap_id !== actor || action || writeAbort) return;
    action = { id, actor, kind, content: message.content ?? "", serverContent: message.content ?? "", draftRevision: 0,
      loading: false, pending: false, needsReadback: true, unavailable: false, error: "" };
    await read(true);
  }

  function setContent(value: string) {
    if (!action || !owns(action) || action.kind !== "edit" || (!action.revision && action.loading) || action.content === value) return;
    action.content = value; action.draftRevision += 1; emit();
  }

  function cancel() {
    if (!action || !state()?.canCancel) return;
    abortRead(); action = undefined; idle();
  }

  async function submit(kind: Action["kind"]) {
    const item = action;
    if (!item || item.kind !== kind || !state()?.canSave || !item.revision || writeAbort) return;
    options.pauseReads();
    const abort = new AbortController(), session = options.session(), revision = item.revision;
    item.submitted = { content: item.content.trim(), draftRevision: item.draftRevision };
    item.pending = true; item.error = ""; writeAbort = abort; emit();
    try {
      if (kind === "edit") {
        const ack = options.contact.type === "community"
          ? await editOwnedGroupTalkMessage(session, options.contact.ap_id, item.id, item.submitted.content, revision, abort.signal)
          : await editOwnedTalkMessage(session, item.id, item.submitted.content, revision, abort.signal);
        if (!owns(item)) return;
        const original = options.message(item.id);
        if (original) options.adopt({ ...original, content: ack.content });
        item.revision = ack.revision; item.serverContent = ack.content;
        if (item.draftRevision === item.submitted.draftRevision) action = undefined;
        else item.submitted = undefined;
      } else {
        if (options.contact.type === "community") await deleteOwnedGroupTalkMessage(session, options.contact.ap_id, item.id, revision, abort.signal);
        else await deleteOwnedTalkMessage(session, item.id, revision, abort.signal);
        if (!owns(item)) return;
        options.remove(item.id); action = undefined;
      }
      if (owns(item) || active()) void options.afterCommit();
    } catch (cause) {
      if (owns(item)) { item.needsReadback = true;
        const rejected = cause instanceof MobileApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408;
        // A definitive rejection did not acknowledge a write. Keep the text,
        // require a fresh read before saving, but do not trap the editor closed.
        if (rejected) item.submitted = undefined;
        item.error = cause instanceof MobileApiError && cause.status === 409
          ? "別の画面でメッセージが変わりました。現在の1件を確認してから操作してください。"
          : rejected ? "メッセージを変更できませんでした。権限と接続を確認してください。編集内容は残しています。"
          : "変更の結果を確認できませんでした。再送せず、現在の1件を確認してください。"; }
    } finally {
      if (writeAbort === abort) { writeAbort = undefined; item.pending = false; idle(); }
    }
  }

  function dispose() {
    disposed = true; readAbort?.abort(); writeAbort?.abort(); readAbort = undefined; writeAbort = undefined; action = undefined;
  }
  return { state, begin, setContent, cancel, submit, reconcile: () => read(), abortRead, dispose };
}
