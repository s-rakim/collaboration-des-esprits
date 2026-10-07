"""
Who is in the room.

Identity here is a name, and the name is load-bearing: it is how one agent
addresses another, so it has to survive a reconnect and it has to be
@mentionable. Everything in this file exists to keep those two true.
"""

from __future__ import annotations

import json
import re

from .common import Invalid, NotFound, new_id, now


class PresenceMixin:
    # ------------------------------------------------------------------ agents

    def join(self, *, name, role="generalist", kind="agent", model="", capabilities=None):
        """
        Identify an agent.

        Idempotent by name: the same agent reconnecting keeps its id, history and
        read cursors, which is what makes a resumed session continuous rather
        than a new participant every time.
        """
        capabilities = capabilities or []
        if not name or not str(name).strip():
            raise Invalid("name is required")

        # Typing your own handle with the @ on it is the natural thing to do,
        # and storing it that way makes every mention of you read "@@name" and
        # match nothing. Take it off rather than refusing a reasonable thing to
        # type.
        name = re.sub(r"^@+", "", str(name).strip())
        if not name:
            raise Invalid("name is required")
        if re.search(r"\s", name):
            raise Invalid("name cannot contain spaces (it is used for @mentions)")
        # A name nobody can @mention is a name that cannot be addressed, which
        # defeats the point of having one in a room that works by addressing
        # people.
        if not re.fullmatch(r"[A-Za-z0-9][\w.-]*", name):
            raise Invalid(
                "a name has to start with a letter or number, and hold only letters,"
                " numbers, dots, dashes or underscores"
            )

        existing = self.db.get("SELECT * FROM agents WHERE name = ?", (name,))
        ts = now()
        if existing:
            self.db.run(
                """UPDATE agents SET role = ?, kind = ?, model = ?, capabilities = ?, last_seen_at = ?,
                          status = CASE WHEN status = 'away' THEN 'idle' ELSE status END
                   WHERE id = ?""",
                (role, kind, model, json.dumps(capabilities), ts, existing["id"]),
            )
        else:
            self.db.run(
                """INSERT INTO agents (id, name, role, kind, model, capabilities, joined_at, last_seen_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_id(), name, role, kind, model, json.dumps(capabilities), ts, ts),
            )
            self._system_post(None, f"{name} joined as {role}.")

        agent = self.db.get("SELECT * FROM agents WHERE name = ?", (name,))
        return {
            "agent": self._agent_view(agent),
            "role": self.describe_role(role),
            "rejoined": bool(existing),
            "waiting": self.catch_up(name=name),
        }

    def _agent(self, name):
        row = self.db.get("SELECT * FROM agents WHERE name = ?", (str(name or "").strip(),))
        if not row:
            raise NotFound(f'no agent named "{name}" — call join first')
        return row

    @staticmethod
    def _agent_view(a):
        return {
            "name": a["name"],
            "role": a["role"],
            "kind": a["kind"],
            "model": a["model"] or None,
            "status": a["status"],
            "statusNote": a["status_note"] or None,
            "capabilities": json.loads(a["capabilities"] or "[]"),
            "lastSeen": a["last_seen_at"],
        }

    def touch(self, name):
        self.db.run("UPDATE agents SET last_seen_at = ? WHERE name = ?", (now(), name))

    def set_status(self, *, name, status, note=""):
        agent = self._agent(name)
        if status not in ("idle", "working", "blocked", "away"):
            raise Invalid("status must be idle, working, blocked or away")
        self.db.run(
            "UPDATE agents SET status = ?, status_note = ?, last_seen_at = ? WHERE id = ?",
            (status, note, now(), agent["id"]),
        )
        return self._agent_view(self.db.get("SELECT * FROM agents WHERE id = ?", (agent["id"],)))

    def roster(self):
        out = []
        for a in self.db.all("SELECT * FROM agents ORDER BY kind DESC, name"):
            view = self._agent_view(a)
            view["workingOn"] = [
                dict(r)
                for r in self.db.all(
                    """SELECT id, title, status FROM tasks
                       WHERE owner = ? AND status IN ('claimed','in_progress','blocked','review')
                       ORDER BY updated_at DESC""",
                    (a["name"],),
                )
            ]
            out.append(view)
        return out
