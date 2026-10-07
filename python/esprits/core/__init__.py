"""
The Hub is all of the behaviour, and it knows nothing about transports.

The MCP server, the HTTP API and the tests all drive this same object, so there
is exactly one implementation of every rule. It is assembled from mixins by
subject — who is here, what the ideas are, whose turn it is to speak — because
one file of seventy-five methods is a file nobody reads, only greps.

NOTE: this package never calls a model and holds no API keys. It is the shared
memory your agents meet in; the thinking happens in the agents, and the way out
to a model is esprits.mcc.
"""

from __future__ import annotations

from ..db import open_db
from ..roles import describe_role, load_roles
from .common import (  # noqa: F401  (re-exported: this is the package's vocabulary)
    FLOOR_HOLD_MS,
    OPEN_TASK_STATUSES,
    PRESENCE_WINDOW_MS,
    STAGES,
    TASK_STATUSES,
    URGENCY,
    Invalid,
    NotFound,
    now,
    parse_mentions,
    slugify,
)
from .floor import FloorMixin
from .ideas import IdeasMixin
from .messages import MessagesMixin
from .presence import PresenceMixin


class Hub(PresenceMixin, IdeasMixin, FloorMixin, MessagesMixin):
    def __init__(self, *, db=None, db_path=None, roles=None):
        self.db = db if db is not None else open_db(db_path)
        self.roles = roles if roles is not None else load_roles()

    def close(self):
        self.db.close()

    def describe_role(self, name):
        return describe_role(self.roles, name)


__all__ = ["Hub", "Invalid", "NotFound", "STAGES", "TASK_STATUSES", "URGENCY"]
