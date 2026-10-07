"""
The build board, and handing work over.

A task carries its own blockers, so several builders can run at once without
coordinating by hand: nobody is ever handed something whose prerequisites are
unfinished. And when nothing is available the board says why, rather than
returning an empty result an agent would read as "the project is finished".

A handoff is the thing that replaces re-explaining. Everything the next agent
would otherwise have to reconstruct from the transcript goes in one record, and
the work goes back on the board rather than silently belonging to somebody who
has stopped.
"""

from __future__ import annotations

import json

from .common import OPEN_TASK_STATUSES, TASK_STATUSES, Invalid, NotFound, now


class BoardMixin:
    # ------------------------------------------------------------ build board

    def create_task(self, *, idea=None, title, detail="", role="any",
                    depends_on=None, by, owner=None):
        depends_on = depends_on or []
        if not title or not str(title).strip():
            raise Invalid("title is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        ts = now()

        with self.db.transaction():
            cur = self.db.run(
                """INSERT INTO tasks (idea_id, title, detail, role, owner, status, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (idea_id, str(title).strip(), detail, role, owner,
                 "claimed" if owner else "todo", agent["name"], ts, ts),
            )
            task_id = int(cur.lastrowid)
            for dep in depends_on:
                if not self.db.get("SELECT id FROM tasks WHERE id = ?", (int(dep),)):
                    raise NotFound(f"cannot depend on missing task #{dep}")
                if int(dep) == task_id:
                    raise Invalid("a task cannot depend on itself")
                self.db.run(
                    "INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)",
                    (task_id, int(dep)),
                )
        return self.get_task(task_id)

    def plan(self, *, idea, tasks, by):
        """Create a batch of tasks at once, resolving intra-batch deps by index."""
        idea_id = self._idea_id(idea)
        if idea_id is None:
            raise Invalid("plan needs an idea")
        if not isinstance(tasks, list) or not tasks:
            raise Invalid("tasks must be a non-empty array")
        agent = self._agent(by)

        created = []
        with self.db.transaction():
            for t in tasks:
                # "dependsOn: [0, 2]" inside a batch refers to positions in this
                # batch, so a planner can lay out an ordered plan in one call.
                deps = []
                for d in t.get("dependsOn") or t.get("depends_on") or []:
                    if isinstance(d, int) and 0 <= d < len(created) and not t.get("absoluteDeps"):
                        deps.append(created[d]["id"])
                    else:
                        deps.append(int(d))
                created.append(self.create_task(
                    idea=idea_id, title=t["title"], detail=t.get("detail", ""),
                    role=t.get("role", "any"), depends_on=deps, by=agent["name"],
                ))
            self.db.run(
                """UPDATE ideas SET stage = 'building', updated_at = ?
                   WHERE id = ? AND stage IN ('spec','proposing','refining')""",
                (now(), idea_id),
            )

        listing = "\n".join(f'- #{t["id"]} [{t["role"]}] {t["title"]}' for t in created)
        self.post(
            idea=idea_id, by=agent["name"], kind="status",
            body=f"@all Planned {len(created)} task(s):\n{listing}"
                 "\n\nBuilders: claim_next() to pick up work.",
        )
        return created

    def get_task(self, id):
        t = self.db.get(
            "SELECT t.*, i.slug AS idea_slug FROM tasks t LEFT JOIN ideas i ON i.id = t.idea_id WHERE t.id = ?",
            (int(id),),
        )
        if not t:
            raise NotFound(f"no task #{id}")
        deps = [
            dict(r)
            for r in self.db.all(
                """SELECT d.depends_on AS id, x.title, x.status FROM task_deps d
                   JOIN tasks x ON x.id = d.depends_on WHERE d.task_id = ?""",
                (t["id"],),
            )
        ]
        blocked_by = [d for d in deps if d["status"] not in ("done", "dropped")]
        return {
            "id": t["id"],
            "idea": t["idea_slug"],
            "title": t["title"],
            "detail": t["detail"],
            "role": t["role"],
            "status": t["status"],
            "owner": t["owner"],
            "result": t["result"] or None,
            "createdBy": t["created_by"],
            "createdAt": t["created_at"],
            "updatedAt": t["updated_at"],
            "dependsOn": deps,
            "blockedBy": blocked_by,
            "runnable": t["status"] == "todo" and not blocked_by,
        }

    def tasks(self, *, idea=None, status=None, owner=None, role=None):
        where, params = [], []
        if idea is not None:
            where.append("t.idea_id = ?")
            params.append(self._idea_id(idea))
        if status:
            listed = status if isinstance(status, list) else [status]
            where.append(f"t.status IN ({','.join('?' * len(listed))})")
            params.extend(listed)
        if owner:
            where.append("t.owner = ?")
            params.append(owner)
        if role:
            where.append("t.role = ?")
            params.append(role)
        rows = self.db.all(
            f"SELECT t.id FROM tasks t {('WHERE ' + ' AND '.join(where)) if where else ''} ORDER BY t.id",
            tuple(params),
        )
        return [self.get_task(r["id"]) for r in rows]

    def claim_next(self, *, by, idea=None, role=None):
        """
        A builder pulls its next piece of work.

        The blocker graph is respected, so an agent is never handed something
        whose prerequisites are unfinished — that is what lets several builders
        run at once without coordinating by hand.
        """
        agent = self._agent(by)
        want_role = role or agent["role"]
        idea_id = self._idea_id(idea) if idea is not None else None

        # A reviewer's queue is work awaiting its gate, not fresh work.
        target = "review" if want_role == "reviewer" else "todo"
        where, params = ["t.status = ?"], [target]
        if idea_id is not None:
            where.append("t.idea_id = ?")
            params.append(idea_id)
        if target == "todo":
            where.append("(t.role = ? OR t.role = 'any')")
            params.append(want_role)
        else:
            # Don't let an agent review its own work.
            where.append("(t.owner IS NULL OR t.owner != ?)")
            params.append(agent["name"])

        candidates = [
            self.get_task(r["id"])
            for r in self.db.all(
                f"SELECT t.id FROM tasks t WHERE {' AND '.join(where)} ORDER BY t.id", tuple(params)
            )
        ]
        ready = next(
            (t for t in candidates if target == "review" or not t["blockedBy"]), None
        )
        if not ready:
            waiting = len(candidates)
            any_open = len(self.tasks(idea=idea, status=OPEN_TASK_STATUSES))
            if waiting:
                why = (f"{waiting} {want_role} task(s) exist but every one is waiting"
                       " on unfinished dependencies")
            elif any_open:
                why = (f'nothing for role "{want_role}" right now; {any_open} open task(s)'
                       " belong to other roles")
            else:
                why = "the board is empty — nothing is planned yet"
            return {"task": None, "why": why, "openTasks": any_open}

        ts = now()
        with self.db.transaction():
            # Guard the claim on the status we read, so two builders racing for
            # the same task cannot both win it.
            cur = self.db.run(
                "UPDATE tasks SET status = 'claimed', owner = ?, updated_at = ? WHERE id = ? AND status = ?",
                (agent["name"], ts, ready["id"], target),
            )
            if not cur.rowcount:
                raise Invalid(
                    f'task #{ready["id"]} was taken by someone else — call claim_next again'
                )
            self.db.run(
                """INSERT INTO task_events (task_id, actor, field, old_value, new_value, created_at)
                   VALUES (?, ?, 'status', ?, 'claimed', ?)""",
                (ready["id"], agent["name"], target, ts),
            )
            self.db.run(
                "UPDATE agents SET status = 'working', status_note = ?, last_seen_at = ? WHERE id = ?",
                (f'#{ready["id"]} {ready["title"]}'[:120], ts, agent["id"]),
            )

        self.post(
            idea=ready["idea"], by=agent["name"], kind="status",
            ref_kind="task", ref_id=ready["id"],
            body=f'Claimed #{ready["id"]} — {ready["title"]}',
        )
        return {
            "task": self.get_task(ready["id"]),
            "brief": self.brief(idea=ready["idea"]) if ready["idea"] else None,
        }

    def update_task(self, *, id, status=None, result=None, detail=None, note="", owner=None, by):
        task = self.get_task(id)
        agent = self._agent(by)
        ts = now()

        if status is not None and status not in TASK_STATUSES:
            raise Invalid(f"status must be one of {', '.join(TASK_STATUSES)}")

        with self.db.transaction():
            if status is not None and status != task["status"]:
                self.db.run(
                    """INSERT INTO task_events (task_id, actor, field, old_value, new_value, note, created_at)
                       VALUES (?, ?, 'status', ?, ?, ?, ?)""",
                    (task["id"], agent["name"], task["status"], status, note, ts),
                )
                self.db.run(
                    "UPDATE tasks SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?",
                    (status, ts if status in ("done", "dropped") else None, ts, task["id"]),
                )
            if result is not None:
                self.db.run(
                    "UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?", (result, ts, task["id"])
                )
            if detail is not None:
                self.db.run(
                    "UPDATE tasks SET detail = ?, updated_at = ? WHERE id = ?", (detail, ts, task["id"])
                )
            if owner is not None:
                self.db.run(
                    """INSERT INTO task_events (task_id, actor, field, old_value, new_value, created_at)
                       VALUES (?, ?, 'owner', ?, ?, ?)""",
                    (task["id"], agent["name"], task["owner"], owner, ts),
                )
                self.db.run(
                    "UPDATE tasks SET owner = ?, updated_at = ? WHERE id = ?", (owner, ts, task["id"])
                )

        updated = self.get_task(task["id"])

        # Finishing a task can unblock others. Say so in the room, because that
        # is the signal other builders are waiting on.
        unblocked = []
        if status == "done":
            for row in self.db.all(
                """SELECT t.id FROM task_deps d JOIN tasks t ON t.id = d.task_id
                   WHERE d.depends_on = ? AND t.status = 'todo'""",
                (task["id"],),
            ):
                candidate = self.get_task(row["id"])
                if not candidate["blockedBy"]:
                    unblocked.append(candidate)
            self.db.run(
                "UPDATE agents SET status = 'idle', status_note = '' WHERE id = ?", (agent["id"],)
            )

        if status is not None:
            body = f'#{task["id"]} {task["title"]}: {task["status"]} → {status}'
            if note:
                body += f"\n{note}"
            if result:
                body += f"\nResult: {result}"
            if unblocked:
                listed = ", ".join(f'#{t["id"]} [{t["role"]}] {t["title"]}' for t in unblocked)
                body += f"\n\nThis unblocks: {listed} — @all"
            self.post(
                idea=task["idea"], by=agent["name"], kind="status",
                ref_kind="task", ref_id=task["id"], body=body,
            )
        return {"task": updated, "unblocked": unblocked}

    # -------------------------------------------------------------- handoffs

    def handoff(self, *, idea=None, task=None, summary, next_steps="", watch_out="",
                artifacts=None, to_role=None, by):
        """Structured context transfer: the thing that replaces re-explaining."""
        artifacts = artifacts or []
        if not summary or not str(summary).strip():
            raise Invalid("summary is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        ts = now()

        cur = self.db.run(
            """INSERT INTO handoffs (idea_id, task_id, from_agent, to_role, summary, next_steps, watch_out, artifacts, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (idea_id, int(task) if task else None, agent["name"], to_role, summary,
             next_steps, watch_out, json.dumps(artifacts), ts),
        )
        handoff_id = int(cur.lastrowid)

        # The work goes back on the board, or it silently belongs to an agent
        # that has stopped.
        if task:
            t = self.get_task(task)
            if t["status"] in ("claimed", "in_progress"):
                self.db.run(
                    "UPDATE tasks SET status = 'todo', owner = NULL, updated_at = ? WHERE id = ?",
                    (ts, t["id"]),
                )
                self.db.run(
                    """INSERT INTO task_events (task_id, actor, field, old_value, new_value, note, created_at)
                       VALUES (?, ?, 'status', ?, 'todo', 'handed off', ?)""",
                    (t["id"], agent["name"], t["status"], ts),
                )
        self.db.run("UPDATE agents SET status = 'idle', status_note = '' WHERE id = ?", (agent["id"],))

        body = (f'{"@" + to_role + " " if to_role else "@all "}Handoff H#{handoff_id}'
                f'{f" on task #{task}" if task else ""}\n\nWhere it stands: {summary}')
        if next_steps:
            body += f"\n\nNext: {next_steps}"
        if watch_out:
            body += f"\n\nWatch out: {watch_out}"
        if artifacts:
            body += f'\n\nTouched: {", ".join(artifacts)}'
        self.post(
            idea=idea, by=agent["name"], kind="handoff",
            ref_kind="task", ref_id=int(task) if task else None, body=body,
        )
        return self.get_handoff(handoff_id)

    def get_handoff(self, id):
        h = self.db.get(
            """SELECT h.*, i.slug AS idea_slug FROM handoffs h
               LEFT JOIN ideas i ON i.id = h.idea_id WHERE h.id = ?""",
            (int(id),),
        )
        if not h:
            raise NotFound(f"no handoff #{id}")
        return {
            "id": h["id"],
            "idea": h["idea_slug"],
            "task": h["task_id"],
            "from": h["from_agent"],
            "toRole": h["to_role"],
            "summary": h["summary"],
            "nextSteps": h["next_steps"] or None,
            "watchOut": h["watch_out"] or None,
            "artifacts": json.loads(h["artifacts"] or "[]"),
            "claimedBy": h["claimed_by"],
            "createdAt": h["created_at"],
        }

    def handoffs(self, *, idea=None, open=True, role=None):
        where, params = [], []
        if idea is not None:
            where.append("h.idea_id = ?")
            params.append(self._idea_id(idea))
        if open:
            where.append("h.claimed_at IS NULL")
        if role:
            where.append("(h.to_role IS NULL OR h.to_role = ?)")
            params.append(role)
        rows = self.db.all(
            f"SELECT h.id FROM handoffs h {('WHERE ' + ' AND '.join(where)) if where else ''} ORDER BY h.id DESC",
            tuple(params),
        )
        return [self.get_handoff(r["id"]) for r in rows]

    def take_handoff(self, *, id, by):
        agent = self._agent(by)
        h = self.get_handoff(id)
        if h["claimedBy"]:
            raise Invalid(f'handoff #{id} was already picked up by {h["claimedBy"]}')
        self.db.run(
            "UPDATE handoffs SET claimed_by = ?, claimed_at = ? WHERE id = ?",
            (agent["name"], now(), h["id"]),
        )
        self.post(
            idea=h["idea"], by=agent["name"], kind="status",
            body=f'Picked up handoff H#{h["id"]} from @{h["from"]}.',
        )
        return {
            "handoff": self.get_handoff(h["id"]),
            "brief": self.brief(idea=h["idea"]) if h["idea"] else None,
        }
