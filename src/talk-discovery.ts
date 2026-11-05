import type { MobileSession } from "@takosjp/mobile-kit";
import { loadTalkRequestContact, searchTalkPeople } from "./api.ts";
import type { TalkContact, TalkPerson } from "./talk-response.ts";
import { talkSessionIdentity } from "./talk-session.ts";

export interface TalkDiscoveryState {
  visible: boolean;
  query: string;
  people: readonly TalkPerson[];
  searched: boolean;
  loading: boolean;
  opening: string | undefined;
  hasMore: boolean;
  error: string;
}

/** Search is a read, never a follow or a message. Resolve a chosen person again
 * through the authenticated contact endpoint before entering the normal chat. */
export function createTalkDiscoveryController(options: {
  session: MobileSession;
  actorApId?: string;
  isActive?: () => boolean;
  onChange?: (state: TalkDiscoveryState) => void;
  onOpen: (contact: TalkContact) => void;
}) {
  let session = { ...options.session }, actor = options.actorApId;
  let key = talkSessionIdentity(session), revision = 0, disposed = false;
  let visible = false, query = "", submitted = "", people: TalkPerson[] = [];
  let searched = false, hasMore = false, error = "", nextOffset = 0;
  let pending: AbortController | undefined, opening: string | undefined;
  const state = (): TalkDiscoveryState => ({ visible, query, people: people.map(person => ({ ...person })),
    searched, loading: !!pending && !opening, opening, hasMore, error });
  const publish = () => { if (!disposed) options.onChange?.(state()); };
  const active = () => !disposed && visible && !!actor && options.isActive?.() !== false;
  function stop() { revision++; pending?.abort(); pending = undefined; opening = undefined; }
  function close() {
    if (disposed || (!visible && !pending)) return;
    stop(); visible = false; publish();
  }
  function show() {
    if (disposed || !actor || options.isActive?.() === false) return;
    visible = true; publish();
  }
  function setQuery(value: string) {
    if (!active() || query === value) return;
    stop(); query = value; people = []; searched = false; hasMore = false; error = ""; nextOffset = 0; publish();
  }
  async function search(more = false) {
    if (!active() || pending || (more && (!hasMore || query !== submitted))) return;
    const offset = more ? nextOffset : 0, expected = ++revision;
    const selected = session, self = actor, abort = new AbortController();
    pending = abort; error = "";
    if (!more) { people = []; searched = false; hasMore = false; }
    publish();
    try {
      const page = await searchTalkPeople(selected, query, offset, abort.signal);
      if (!active() || expected !== revision || abort.signal.aborted) return;
      const found = new Map((more ? people : []).map(person => [person.ap_id, person]));
      for (const person of page.people) if (person.ap_id !== self) found.set(person.ap_id, person);
      people = [...found.values()]; hasMore = page.hasMore; searched = true;
      submitted = query; nextOffset = offset + 20;
    } catch (cause) {
      if (active() && expected === revision && !abort.signal.aborted) {
        error = cause instanceof Error ? cause.message : "相手を検索できませんでした。もう一度検索してください。";
      }
    } finally {
      if (pending === abort) { pending = undefined; publish(); }
    }
  }
  async function openPerson(apId: string) {
    if (!active() || pending || !people.some(person => person.ap_id === apId) || apId === actor) return;
    const expected = ++revision, selected = session, abort = new AbortController();
    pending = abort; opening = apId; error = ""; publish();
    try {
      const contact = await loadTalkRequestContact(selected, apId, abort.signal);
      if (!active() || expected !== revision || abort.signal.aborted) return;
      pending = undefined; opening = undefined; visible = false; publish();
      options.onOpen(contact);
    } catch (cause) {
      if (active() && expected === revision && !abort.signal.aborted) {
        error = cause instanceof Error ? cause.message : "相手のトークを開けませんでした。もう一度確認してください。";
      }
    } finally {
      if (pending === abort) { pending = undefined; opening = undefined; publish(); }
    }
  }
  function updateSession(next: MobileSession, nextActor?: string) {
    if (disposed) return;
    const nextKey = talkSessionIdentity(next);
    session = { ...next };
    if (nextKey === key && actor === nextActor) return;
    stop(); key = nextKey; actor = nextActor; visible = false; query = "";
    people = []; submitted = ""; nextOffset = 0; searched = false; hasMore = false; error = ""; publish();
  }
  return { state, show, close, setQuery, search, more: () => search(true), openPerson, updateSession,
    suspend: () => { if (pending) { stop(); error = "確認を中断しました。もう一度操作してください。"; publish(); } },
    dispose: () => { stop(); disposed = true; people = []; query = ""; submitted = ""; } };
}
