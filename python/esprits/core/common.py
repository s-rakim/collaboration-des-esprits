"""
The vocabulary the room is built out of.

Every rule in this package rests on these: what stages an idea moves through,
what a task can be, how loudly somebody may ask to speak, and how long the room
waits for an agent that has stopped answering. They live in one place because
they are the parts most often read together and most dangerous to let drift.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

STAGES = ["raw", "refining", "proposing", "spec", "building", "review", "done", "parked"]
TASK_STATUSES = ["todo", "claimed", "in_progress", "blocked", "review", "done", "dropped"]
OPEN_TASK_STATUSES = ["todo", "claimed", "in_progress", "blocked", "review"]

#: Speaking urgency. Higher wins the floor. These are the only reasons an agent
#: gets to jump the queue, and they are ordered by how much the room loses by
#: waiting: a blocker stops work, a comment does not.
URGENCY = {"blocker": 5, "answer": 4, "objection": 3, "proposal": 2, "comment": 1}

#: How long a granted floor may be held before it is revoked. An agent that
#: crashes mid-turn must not wedge the room forever.
FLOOR_HOLD_MS = 90_000

#: How long since an agent was last seen before the room stops waiting on it.
#: Only affects who is *owed* a proposal score — an absent agent's existing
#: scores and objections still stand.
PRESENCE_WINDOW_MS = 15 * 60_000


class NotFound(Exception):
    """Asked for something that is not there."""

    code = "NOT_FOUND"


class Invalid(Exception):
    """Asked for something that could not be right."""

    code = "INVALID"


def now() -> str:
    """One spelling of the time, so string comparison orders rows correctly."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


def slugify(text: str | None, fallback: str = "idea") -> str:
    base = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower())
    base = base.strip("-")[:48]
    return base or fallback


_MENTION = re.compile(r"""(?:^|[\s(<\[",'])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})""")


def parse_mentions(body: str) -> list[str]:
    """Pull @mentions out of a body. @all and @human are addresses, not agents."""
    found: list[str] = []
    for match in _MENTION.finditer(str(body)):
        name = re.sub(r"[.\-_]+$", "", match.group(1))
        if name and name not in found:
            found.append(name)
    return found


def ms_since(stamp: str | None) -> float:
    """Milliseconds since an ISO stamp, treating an absent one as long ago."""
    if not stamp:
        return float("inf")
    try:
        parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed).total_seconds() * 1000
