"""
What each agent is for, and how everyone is expected to work together.

A role is a charter plus a queue filter: an agent says "I am the backend
builder", gets told what that means, and the work handed to it is backend work
whose blockers are cleared.

The charters themselves are in roles/builtin.json beside this package, read by
both runtimes. A charter spelled out in two languages is one that drifts: one
room's architect gets told something the other's does not, and nothing anywhere
says which is right.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROLES_FILE = Path(__file__).resolve().parent.parent.parent / "roles" / "builtin.json"

_SHIPPED = json.loads(ROLES_FILE.read_text(encoding="utf-8"))
HOUSE_RULES: list[str] = _SHIPPED["houseRules"]
BUILTIN_ROLES: dict = _SHIPPED["roles"]


def load_roles(file: str | os.PathLike[str] | None = None) -> dict:
    """
    Project-local overrides.

    Drop an esprits.roles.json next to the database to define your own
    builders, or to replace a charter without forking the repo. Shallow-merged
    per role, so you can override just the summary or just the charter and keep
    the rest of the preset.
    """
    path = Path(file or os.environ.get("ESPRITS_ROLES") or "./esprits.roles.json").resolve()
    roles = json.loads(json.dumps(BUILTIN_ROLES))  # a deep copy, cheaply
    if not path.exists():
        return roles

    try:
        custom = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        # A broken override file must not take the room down with it — every
        # agent would lose the room over a stray comma.
        print(f"esprits: ignoring unreadable roles file {path}: {err}", file=sys.stderr)
        return roles

    for name, definition in (custom.get("roles") or custom).items():
        if not isinstance(definition, dict):
            continue
        charter = definition.get("charter")
        if isinstance(charter, list):
            definition = {**definition, "charter": "\n".join(charter)}
        roles[name] = {**roles.get(name, {"stage": "any", "summary": ""}), **definition}
    return roles


def describe_role(roles: dict, name: str) -> dict:
    role = roles.get(name) or {"stage": "any", "summary": "Undeclared role.", "charter": ""}
    return {
        "name": name,
        **role,
        # The role charter says what this agent is for; the house rules say how
        # everyone is expected to work together. Agents get both or neither.
        "houseRules": HOUSE_RULES,
    }
