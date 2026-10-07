"""
Everything that gets said, and who has read it.

Reading is cursor-based rather than time-based, because an agent that was off
for an hour wants what it missed, not what happened in the last hour. Each
agent keeps a cursor per scope, and a mention-filtered read keeps its own —
sharing one would advance past everything between two mentions and those
messages would never come back.
"""

from __future__ import annotations

import asyncio
import re
import time

from .common import Invalid, NotFound, now, parse_mentions


class MessagesMixin:
    # --------------------------------------------------------------- the chat

    def _system_post(self, idea_id, body):
        self.db.run(
            """INSERT INTO messages (idea_id, author, author_kind, kind, body, created_at)
               VALUES (?, 'esprits', 'system', 'system', ?, ?)""",
            (idea_id, body, now()),
        )

    def post(self, *, idea=None, body, by, kind="message", reply_to=None, ref_kind=None, ref_id=None):
        """Post into an idea's thread, or into the lobby when idea is omitted."""
        if not body or not str(body).strip():
            raise Invalid("body is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)

        # Turn-taking, applied only to free-form talk. The structured calls
        # (propose, weigh_in, decide, claim_next, …) post as a side effect and
        # are never gated: those are actions, not speaking, and blocking them
        # would deadlock the board.
        #
        # The rule is the social one rather than a hard permission: you may
        # speak into silence, but once somebody is waiting for the floor,
        # everybody queues. That way the discipline engages the moment one
        # agent opts in, and a room where nobody uses it is not broken — just
        # informal.
        holds_floor = False
        if agent["kind"] != "human" and kind == "message":
            f = self.floor(by=agent["name"])
            holds_floor = f["yours"]
            if (f["holder"] or f["queue"]) and not f["yours"]:
                who = f'{f["holder"]["agent"]} has the floor' if f["holder"] else "others are waiting"
                queued = f' and {len(f["queue"])} agent(s) are queued' if f["queue"] else ""
                raise Invalid(
                    f"not your turn — {who}{queued}."
                    " Call request_floor(urgency) then wait_for_turn()."
                )

        if reply_to is not None:
            if not self.db.get("SELECT id FROM messages WHERE id = ?", (int(reply_to),)):
                raise NotFound(f"no message #{reply_to} to reply to")

        ts = now()
        mentions = parse_mentions(body)
        with self.db.transaction():
            cur = self.db.run(
                """INSERT INTO messages
                     (idea_id, author, author_id, author_kind, kind, body, reply_to, ref_kind, ref_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    idea_id, agent["name"], agent["id"], agent["kind"], kind, str(body),
                    reply_to, ref_kind, ref_id, ts,
                ),
            )
            message_id = int(cur.lastrowid)
            for m in mentions:
                self.db.run(
                    "INSERT OR IGNORE INTO mentions (message_id, name) VALUES (?, ?)",
                    (message_id, m),
                )
            self.db.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", (ts, agent["id"]))
            if idea_id:
                self.db.run("UPDATE ideas SET updated_at = ? WHERE id = ?", (ts, idea_id))

        # The author has by definition read their own message.
        self._advance_cursor(
            agent["id"], "feed" if idea_id is None else f"idea:{idea_id}", message_id
        )

        # Speaking is what the floor was for, so it is released automatically.
        # An agent that had to remember to yield would eventually forget and
        # stall everyone behind it.
        if agent["kind"] != "human":
            self.db.run("UPDATE agents SET last_spoke_at = ? WHERE id = ?", (ts, agent["id"]))
            if holds_floor:
                self.yield_floor(by=agent["name"], spoke=True)

        return {
            "id": message_id,
            "idea": idea_id,
            "author": agent["name"],
            "kind": kind,
            "mentions": mentions,
            "createdAt": ts,
        }

    def _advance_cursor(self, agent_id, scope, message_id):
        self.db.run(
            """INSERT INTO cursors (agent_id, scope, last_message_id, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(agent_id, scope) DO UPDATE SET
                 last_message_id = MAX(last_message_id, excluded.last_message_id),
                 updated_at = excluded.updated_at""",
            (agent_id, scope, message_id, now()),
        )

    def _message_view(self, m):
        keys = m.keys()
        mentions = [
            r["name"] for r in self.db.all(
                "SELECT name FROM mentions WHERE message_id = ?", (m["id"],)
            )
        ]
        idea = m["idea_slug"] if "idea_slug" in keys else m["idea_id"]
        return {
            "id": m["id"],
            "idea": idea if idea is not None else None,
            "author": m["author"],
            "authorKind": m["author_kind"],
            "kind": m["kind"],
            "body": m["body"],
            "replyTo": m["reply_to"],
            "ref": {"kind": m["ref_kind"], "id": m["ref_id"]} if m["ref_kind"] else None,
            "mentions": mentions or None,
            "createdAt": m["created_at"],
        }

    def read(self, *, by, idea=None, since=None, limit=50, advance=True, mentioning_me=False):
        """
        Read new messages.

        The default is "everything new for me since last time", which is the
        call an agent makes in a loop; advancing the cursor is opt-out so a peek
        can avoid marking things read.
        """
        agent = self._agent(by)
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None
        # A mention-filtered read keeps its own cursor. Sharing one with the
        # unfiltered read would advance past everything between two mentions,
        # and those messages would never be returned again.
        scope = ("feed" if not scoped else f"idea:{idea_id}") + (":mentions" if mentioning_me else "")

        after = since
        if after is None:
            after = self.db.value(
                "SELECT last_message_id FROM cursors WHERE agent_id = ? AND scope = ?",
                (agent["id"], scope),
            ) or 0

        where = ["m.id > ?"]
        params: list = [after]
        if scoped:
            where.append("m.idea_id = ?")
            params.append(idea_id)
        if mentioning_me:
            where.append(
                "EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.name IN (?, 'all'))"
            )
            params.append(agent["name"])

        rows = self.db.all(
            f"""SELECT m.*, i.slug AS idea_slug FROM messages m
                LEFT JOIN ideas i ON i.id = m.idea_id
                WHERE {' AND '.join(where)}
                ORDER BY m.id LIMIT ?""",
            (*params, limit),
        )

        if advance and rows:
            self._advance_cursor(agent["id"], scope, rows[-1]["id"])
        self.touch(agent["name"])

        last_id = self.db.value("SELECT MAX(id) FROM messages") or 0
        cursor = rows[-1]["id"] if rows else after
        return {
            "messages": [self._message_view(m) for m in rows],
            "cursor": cursor,
            "more": cursor < last_id and len(rows) == limit,
        }

    async def wait_for(self, *, by, idea=None, timeout_ms=25000, poll_ms=500,
                       mentioning_me=False, limit=50):
        """
        Block until something new arrives, or the timeout expires.

        This is what makes an agent conversational rather than a poller: its
        loop is wait() → think → post(), and it costs one query every poll while
        idle. SQLite is polled rather than pushed because the writers are
        separate OS processes — there is no in-process event to listen for.
        """
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        while True:
            r = self.read(by=by, idea=idea, limit=limit, advance=True, mentioning_me=mentioning_me)
            if r["messages"]:
                return {**r, "timedOut": False}
            if time.monotonic() >= deadline:
                return {**r, "timedOut": True}
            await asyncio.sleep(poll_ms / 1000)

    def unread(self, *, by, idea=None, mentioning_me=False):
        """How many unread, and how many of those are aimed at me."""
        agent = self._agent(by)
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None
        scope = ("feed" if not scoped else f"idea:{idea_id}") + (":mentions" if mentioning_me else "")
        after = self.db.value(
            "SELECT last_message_id FROM cursors WHERE agent_id = ? AND scope = ?",
            (agent["id"], scope),
        ) or 0

        clause = "AND m.idea_id = ?" if scoped else ""
        params = (after, idea_id) if scoped else (after,)
        total = self.db.value(f"SELECT COUNT(*) FROM messages m WHERE m.id > ? {clause}", params)
        mine = self.db.value(
            f"""SELECT COUNT(*) FROM messages m WHERE m.id > ? {clause}
                AND EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id AND x.name IN (?, 'all'))""",
            (*params, agent["name"]),
        )
        return {"total": total, "mentioningMe": mine, "cursor": after}

    def thread(self, message_id):
        root = self.db.get("SELECT * FROM messages WHERE id = ?", (int(message_id),))
        if not root:
            raise NotFound(f"no message #{message_id}")
        replies = self.db.all("SELECT * FROM messages WHERE reply_to = ? ORDER BY id", (root["id"],))
        return {
            "root": self._message_view(root),
            "replies": [self._message_view(m) for m in replies],
        }

    def search(self, *, query, idea=None, limit=25):
        """FTS5 when available, LIKE when the build lacks it."""
        if not query or not str(query).strip():
            raise Invalid("query is required")
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None

        if self.db.has_fts:
            # Quote each term so user punctuation cannot become FTS syntax.
            safe = " ".join(
                '"' + t.replace('"', '""') + '"' for t in re.split(r"\s+", str(query)) if t
            )
            try:
                rows = self.db.all(
                    f"""SELECT m.*, i.slug AS idea_slug FROM messages_fts f
                        JOIN messages m ON m.id = f.rowid
                        LEFT JOIN ideas i ON i.id = m.idea_id
                        WHERE messages_fts MATCH ? {'AND m.idea_id = ?' if scoped else ''}
                        ORDER BY rank LIMIT ?""",
                    (safe, idea_id, limit) if scoped else (safe, limit),
                )
                return [self._message_view(m) for m in rows]
            except Exception:
                pass  # fall through to LIKE

        rows = self.db.all(
            f"""SELECT m.*, i.slug AS idea_slug FROM messages m
                LEFT JOIN ideas i ON i.id = m.idea_id
                WHERE m.body LIKE ? {'AND m.idea_id = ?' if scoped else ''}
                ORDER BY m.id DESC LIMIT ?""",
            (f"%{query}%", idea_id, limit) if scoped else (f"%{query}%", limit),
        )
        return [self._message_view(m) for m in rows]
