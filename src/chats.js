/**
 * The lobby's chats.
 *
 * The lobby used to be one conversation that only ever grew. Now it is a
 * series of them: a new chat is a clean page — for the person and for the
 * agents, who see only the chat in front of them — and the earlier ones are
 * kept in a list to go back to, rename, or delete.
 *
 * One chat is open at a time, for the whole room: the agents are in the room
 * too, and a conversation they could not see would be one they could not
 * answer. Opening an earlier chat makes it the one everybody is in.
 *
 * Which chat a lobby message belongs to is stamped by the database as the
 * message is written (a trigger, in db.js), so nothing that posts to the
 * lobby has to know chats exist. Ideas are untouched: an idea has its own
 * thread already.
 */

const TITLE_MAX = 60;

export function createChats({ db, onSwitch = () => {} }) {
  const now = () => new Date().toISOString();

  const currentId = () => {
    const row = db.prepare("SELECT v FROM settings WHERE k = 'lobby_chat'").get();
    const id = Number(row?.v);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const setCurrent = (id) => {
    db.prepare(
      `INSERT INTO settings (k, v, updated_at) VALUES ('lobby_chat', ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    ).run(String(id), now());
  };
  const make = (title = '') => Number(db.prepare('INSERT INTO chats (title, created_at) VALUES (?, ?)').run(String(title).slice(0, TITLE_MAX), now()).lastInsertRowid);

  /**
   * Make sure there is a chat to be in. A room from before chats existed has
   * a lobby full of messages that belong to none: they become the first chat,
   * so nothing that was said is lost or orphaned.
   */
  function init() {
    if (!db.prepare('SELECT COUNT(*) AS n FROM chats').get().n) {
      const id = make('');
      db.prepare('UPDATE messages SET chat_id = ? WHERE idea_id IS NULL AND chat_id IS NULL').run(id);
      setCurrent(id);
    }
    if (!currentId() || !db.prepare('SELECT 1 FROM chats WHERE id = ?').get(currentId())) {
      setCurrent(db.prepare('SELECT id FROM chats ORDER BY id DESC LIMIT 1').get().id);
    }
    return currentId();
  }

  /** A chat with no name of its own is called by the first thing a person said in it. */
  const view = (c, current) => {
    const stats = db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE chat_id = ? AND author_kind != 'system'`,
    ).get(c.id);
    let title = c.title;
    if (!title) {
      const first = db.prepare(
        `SELECT body FROM messages WHERE chat_id = ? AND author_kind = 'human' ORDER BY id LIMIT 1`,
      ).get(c.id)?.body ?? '';
      const line = first.replace(/\s+/g, ' ').trim();
      title = line ? (line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line) : 'New chat';
    }
    return { id: c.id, title, named: Boolean(c.title), messages: stats.n, createdAt: c.created_at, lastAt: stats.last ?? c.created_at, current: c.id === current };
  };

  function list() {
    const current = init();
    const chats = db.prepare('SELECT * FROM chats ORDER BY id DESC').all().map((c) => view(c, current));
    // The one that was talked in most recently comes first.
    chats.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : b.id - a.id));
    return { current, chats };
  }

  const exists = (id) => {
    const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(id));
    if (!row) throw new Error('there is no such chat');
    return row;
  };

  /** Start a new chat and move the room into it. An empty one is reused rather than piling up. */
  function start() {
    const current = init();
    const empty = db.prepare(
      `SELECT c.id FROM chats c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.author_kind != 'system') ORDER BY c.id DESC LIMIT 1`,
    ).get();
    const id = empty?.id ?? make('');
    if (id !== current) { setCurrent(id); onSwitch(id); }
    return list();
  }

  function open(id) {
    const row = exists(id);
    if (row.id !== init()) { setCurrent(row.id); onSwitch(row.id); }
    return list();
  }

  function rename(id, title) {
    const row = exists(id);
    db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), row.id);
    return list();
  }

  /**
   * Delete a chat and everything said in it. If it is the one the room is in,
   * the room moves to the most recent other chat — or a new, empty one.
   */
  function remove(id) {
    const row = exists(id);
    const current = init();
    // Replies that point into the chat from outside it would be left pointing at nothing.
    db.prepare('UPDATE messages SET reply_to = NULL WHERE reply_to IN (SELECT id FROM messages WHERE chat_id = ?) AND (chat_id IS NULL OR chat_id != ?)').run(row.id, row.id);
    db.prepare('UPDATE messages SET reply_to = NULL WHERE chat_id = ?').run(row.id);
    const gone = db.prepare('DELETE FROM messages WHERE chat_id = ?').run(row.id).changes;
    db.prepare('DELETE FROM chats WHERE id = ?').run(row.id);
    if (row.id === current) {
      const next = db.prepare('SELECT id FROM chats ORDER BY id DESC LIMIT 1').get()?.id ?? make('');
      setCurrent(next);
      onSwitch(next);
    }
    return { ...list(), removed: gone };
  }

  return { init, list, start, open, rename, remove, current: () => init() };
}
