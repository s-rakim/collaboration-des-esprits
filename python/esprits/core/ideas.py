"""
Ideas, and the stages they move through.

The model is organised around the idea rather than around chat: an idea carries
its own discussion, its open questions, its locked decisions and its build
tasks. The stages are guarded on purpose — the whole value of splitting
"refine" from "build" is that it cannot be skipped by accident.
"""

from __future__ import annotations

from .common import STAGES, Invalid, NotFound, now, slugify


class IdeasMixin:
    # ------------------------------------------------------------------- ideas

    def drop_idea(self, *, title, raw="", by=None, stage="raw"):
        """Drop a raw idea. This is the human's main entry point."""
        if not title or not str(title).strip():
            raise Invalid("title is required")
        author = self._agent(by)["name"] if by else "unknown"
        if stage not in STAGES:
            raise Invalid(f"stage must be one of {', '.join(STAGES)}")

        # Slugs are stable handles agents can pass around; collisions get -2, -3.
        base = slugify(title)
        slug = base
        n = 2
        while self.db.get("SELECT 1 FROM ideas WHERE slug = ?", (slug,)):
            slug = f"{base}-{n}"
            n += 1

        ts = now()
        cur = self.db.run(
            """INSERT INTO ideas (slug, title, raw, stage, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (slug, str(title).strip(), raw, stage, author, ts, ts),
        )
        idea_id = int(cur.lastrowid)
        self._system_post(idea_id, f"{author} dropped a new idea: {title}")
        return self.get_idea(idea_id)

    def _idea_row(self, ref):
        """Accept either the numeric id or the slug everywhere an idea is named."""
        if ref is None or ref == "":
            return None
        if isinstance(ref, int) or str(ref).isdigit():
            row = self.db.get("SELECT * FROM ideas WHERE id = ?", (int(ref),))
        else:
            row = self.db.get("SELECT * FROM ideas WHERE slug = ?", (str(ref),))
        if not row:
            raise NotFound(f'no idea "{ref}"')
        return row

    def _idea_id(self, ref):
        row = self._idea_row(ref)
        return row["id"] if row else None

    def get_idea(self, ref):
        i = self._idea_row(ref)
        return {
            "id": i["id"],
            "slug": i["slug"],
            "title": i["title"],
            "raw": i["raw"],
            "spec": i["spec"],
            "specRev": i["spec_rev"],
            "stage": i["stage"],
            "createdBy": i["created_by"],
            "createdAt": i["created_at"],
            "updatedAt": i["updated_at"],
        }

    def list_ideas(self, *, stage=None, limit=50):
        if stage:
            rows = self.db.all(
                "SELECT * FROM ideas WHERE stage = ? ORDER BY updated_at DESC LIMIT ?",
                (stage, limit),
            )
        else:
            rows = self.db.all("SELECT * FROM ideas ORDER BY updated_at DESC LIMIT ?", (limit,))

        out = []
        for i in rows:
            counts = self.db.get(
                """SELECT
                     (SELECT COUNT(*) FROM questions WHERE idea_id = ? AND answered_at IS NULL) AS openQuestions,
                     (SELECT COUNT(*) FROM proposals WHERE idea_id = ? AND status = 'open')     AS openProposals,
                     (SELECT COUNT(*) FROM tasks WHERE idea_id = ? AND status NOT IN ('done','dropped')) AS openTasks,
                     (SELECT COUNT(*) FROM tasks WHERE idea_id = ? AND status = 'done')         AS doneTasks,
                     (SELECT COUNT(*) FROM messages WHERE idea_id = ?)                          AS messages""",
                (i["id"],) * 5,
            )
            project = None
            if i["project_id"]:
                row = self.db.get("SELECT slug FROM projects WHERE id = ?", (i["project_id"],))
                project = row["slug"] if row else None
            out.append({**self.get_idea(i["id"]), "project": project, **dict(counts)})
        return out

    def advance(self, *, ref, stage, by, force=False):
        """
        Move an idea along its lifecycle.

        Guarded, because the whole value of the refine-then-build split is that
        it cannot be skipped by accident: you cannot start building over
        unanswered blocking questions or an empty spec.
        """
        idea = self._idea_row(ref)
        actor = self._agent(by)["name"]
        if stage not in STAGES:
            raise Invalid(f"stage must be one of {', '.join(STAGES)}")

        blockers = []
        if not force and stage in ("building", "review", "done"):
            if not (idea["spec"] or "").strip():
                blockers.append("the spec is still empty — refine it first")
            open_blocking = self.db.value(
                """SELECT COUNT(*) FROM questions
                   WHERE idea_id = ? AND answered_at IS NULL AND blocking = 1""",
                (idea["id"],),
            )
            if open_blocking:
                blockers.append(f"{open_blocking} blocking question(s) still unanswered")
        if not force and stage == "done":
            open_tasks = self.db.value(
                "SELECT COUNT(*) FROM tasks WHERE idea_id = ? AND status NOT IN ('done','dropped')",
                (idea["id"],),
            )
            if open_tasks:
                blockers.append(f"{open_tasks} task(s) are not finished")
        if blockers:
            raise Invalid(
                f'cannot move "{idea["slug"]}" to {stage}: {"; ".join(blockers)}.'
                " Pass force to override."
            )

        self.db.run(
            "UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?", (stage, now(), idea["id"])
        )
        self._system_post(idea["id"], f'{actor} moved this from {idea["stage"]} to {stage}.')
        return self.get_idea(idea["id"])

    def refine(self, *, ref, spec, summary="", by):
        """Refine the spec. Every revision is kept; the raw dump is never touched."""
        idea = self._idea_row(ref)
        author = self._agent(by)["name"]
        if not spec or not str(spec).strip():
            raise Invalid("spec text is required")

        rev = idea["spec_rev"] + 1
        ts = now()
        with self.db.transaction():
            self.db.run(
                "UPDATE ideas SET spec = ?, spec_rev = ?, updated_at = ?, stage = ? WHERE id = ?",
                (spec, rev, ts, "refining" if idea["stage"] == "raw" else idea["stage"], idea["id"]),
            )
            self.db.run(
                """INSERT INTO spec_revisions (idea_id, rev, spec, summary, author, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (idea["id"], rev, spec, summary, author, ts),
            )

        self._system_post(
            idea["id"], f"{author} revised the spec (rev {rev})" + (f": {summary}" if summary else "")
        )
        return {**self.get_idea(idea["id"]), "rev": rev}

    def spec_history(self, ref):
        idea = self._idea_row(ref)
        return [
            dict(r)
            for r in self.db.all(
                """SELECT rev, summary, author, created_at AS createdAt, LENGTH(spec) AS chars
                   FROM spec_revisions WHERE idea_id = ? ORDER BY rev DESC""",
                (idea["id"],),
            )
        ]
