"""
Whose turn it is to speak.

Six agents answering the same message at once is not a conversation, it is a
pile. The floor is what turns one into the other: an agent asks, waits, and
speaks. The human never waits — they are not competing with the agents for the
room's attention, they own it.
"""

from __future__ import annotations

import asyncio
import time

from .common import FLOOR_HOLD_MS, URGENCY, Invalid, ms_since, now


class FloorMixin:
    # ---------------------------------------------------------- speaking floor

    def request_floor(self, *, by, urgency="comment", reason="", idea=None):
        """
        Ask for the floor.

        Idempotent per agent: asking again updates your urgency and reason
        rather than queueing you twice.
        """
        agent = self._agent(by)
        if agent["kind"] == "human":
            return {
                "holder": None,
                "position": 0,
                "yours": True,
                "note": "humans never wait for the floor",
            }

        level = urgency if isinstance(urgency, int) else URGENCY.get(urgency)
        if not level:
            raise Invalid(f"urgency must be one of {', '.join(URGENCY)}")

        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        existing = self.db.get("SELECT * FROM floor_queue WHERE agent_name = ?", (agent["name"],))
        if existing and existing["granted_at"]:
            # Already holding it; just let them get on with it.
            return self.floor(by=agent["name"])

        self.db.run(
            """INSERT INTO floor_queue (agent_name, urgency, reason, idea_id, requested_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(agent_name) DO UPDATE SET
                 urgency = excluded.urgency, reason = excluded.reason, idea_id = excluded.idea_id""",
            (agent["name"], level, str(reason), idea_id, now()),
        )

        self._grant_floor()
        return self.floor(by=agent["name"])

    def _grant_floor(self):
        """
        Hand the floor to whoever deserves it next, if it is vacant.

        Order: urgency, then who has been waiting longest, then who spoke least
        recently. That last term is what stops a chatty agent monopolising a
        shared urgency level.
        """
        ts = now()

        # Reclaim a floor held past the limit — the holder has presumably died.
        holder = self.db.get("SELECT * FROM floor_queue WHERE granted_at IS NOT NULL")
        if holder:
            if ms_since(holder["granted_at"]) < FLOOR_HOLD_MS:
                return dict(holder)
            self.db.run("DELETE FROM floor_queue WHERE agent_name = ?", (holder["agent_name"],))
            self._system_post(
                holder["idea_id"],
                f'{holder["agent_name"]} held the floor without speaking and lost it.',
            )

        nxt = self.db.get(
            """SELECT q.* FROM floor_queue q
               LEFT JOIN agents a ON a.name = q.agent_name
               WHERE q.granted_at IS NULL
               ORDER BY q.urgency DESC, q.requested_at, IFNULL(a.last_spoke_at, '') LIMIT 1"""
        )
        if not nxt:
            return None

        self.db.run(
            "UPDATE floor_queue SET granted_at = ? WHERE agent_name = ?", (ts, nxt["agent_name"])
        )
        return {**dict(nxt), "granted_at": ts}

    def floor(self, *, by=None):
        """Who is speaking, who is waiting, and why."""
        self._grant_floor()
        rows = self.db.all(
            """SELECT q.*, i.slug AS idea_slug FROM floor_queue q
               LEFT JOIN ideas i ON i.id = q.idea_id
               ORDER BY q.granted_at IS NULL, q.urgency DESC, q.requested_at"""
        )
        names = {v: k for k, v in URGENCY.items()}

        def view(r):
            return {
                "agent": r["agent_name"],
                "urgency": names.get(r["urgency"], r["urgency"]),
                "reason": r["reason"] or None,
                "idea": r["idea_slug"],
                "requestedAt": r["requested_at"],
                "holding": bool(r["granted_at"]),
            }

        holder = next((r for r in rows if r["granted_at"]), None)
        waiting = [r for r in rows if not r["granted_at"]]
        position = 0
        if by:
            for n, r in enumerate(waiting, start=1):
                if r["agent_name"] == by:
                    position = n
                    break
        return {
            "holder": view(holder) if holder else None,
            "queue": [view(r) for r in waiting],
            "yours": bool(by and holder and holder["agent_name"] == by),
            "position": position,
        }

    def yield_floor(self, *, by, spoke=False):
        """Give up the floor. Called for you when you post while holding it."""
        agent = self._agent(by)
        row = self.db.get("SELECT * FROM floor_queue WHERE agent_name = ?", (agent["name"],))
        self.db.run("DELETE FROM floor_queue WHERE agent_name = ?", (agent["name"],))
        if spoke:
            self.db.run("UPDATE agents SET last_spoke_at = ? WHERE id = ?", (now(), agent["id"]))
        nxt = self._grant_floor()
        return {
            "yielded": bool(row),
            "nextSpeaker": nxt["agent_name"] if nxt else None,
            "floor": self.floor(by=agent["name"]),
        }

    async def wait_for_turn(self, *, by, timeout_ms=25000, poll_ms=300):
        """
        Block until it is your turn.

        An agent's loop is request_floor → wait_for_turn → post, which is what
        makes the room read as a conversation rather than six agents talking
        over each other.
        """
        agent = self._agent(by)
        if agent["kind"] == "human":
            return {"yours": True, "holder": None, "queue": []}
        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        while True:
            f = self.floor(by=agent["name"])
            if f["yours"]:
                return {**f, "timedOut": False}
            if not self.db.get(
                "SELECT 1 FROM floor_queue WHERE agent_name = ?", (agent["name"],)
            ):
                # Not queued at all — waiting would block forever.
                raise Invalid("you are not in the queue — call request_floor first")
            if time.monotonic() >= deadline:
                return {**f, "timedOut": True}
            await asyncio.sleep(poll_ms / 1000)
