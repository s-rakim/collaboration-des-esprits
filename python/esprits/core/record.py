"""
The things the room writes down rather than says.

A transcript is not memory. Questions, decisions and facts are the parts an
agent arriving tomorrow has to be handed outright, because reading back through
everything to reconstruct them is exactly the work this room exists to avoid.
"""

from __future__ import annotations

from .common import Invalid, NotFound, now


class QuestionsMixin:
    # -------------------------------------------------------- open questions

    def ask(self, *, idea=None, body, by, audience="human", blocking=True, reply_to=None):
        if not body or not str(body).strip():
            raise Invalid("question body is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        ts = now()
        cur = self.db.run(
            """INSERT INTO questions (idea_id, body, asked_by, audience, blocking, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (idea_id, str(body).strip(), agent["name"], audience, 1 if blocking else 0, ts),
        )
        question_id = int(cur.lastrowid)
        tag = "@human " if audience == "human" else ("@all " if audience == "agents" else f"@{audience} ")
        self.post(
            idea=idea,
            by=agent["name"],
            kind="question",
            ref_kind="question",
            ref_id=question_id,
            reply_to=reply_to,
            body=f"{tag}{body}",
        )
        return {
            "id": question_id,
            "idea": idea_id,
            "body": body,
            "audience": audience,
            "blocking": bool(blocking),
            "askedBy": agent["name"],
        }

    def answer(self, *, id, answer, by):
        """
        Answer a question.

        An agent may not answer on the human's behalf — that would let the room
        invent a requirement and then build on it as if it had been confirmed.
        """
        q = self.db.get("SELECT * FROM questions WHERE id = ?", (int(id),))
        if not q:
            raise NotFound(f"no question #{id}")
        if q["answered_at"]:
            raise Invalid(f"question #{id} is already answered")
        agent = self._agent(by)
        if q["audience"] == "human" and agent["kind"] != "human":
            raise Invalid(
                f"question #{id} is addressed to the human — an agent cannot answer it."
                " If you have information that makes it moot, post it and let them close"
                " the question."
            )
        # A question aimed at one agent by name is that agent's to answer.
        # Letting any agent field it defeats the point of tagging somebody: you
        # asked the researcher because you wanted the researcher's answer.
        if (
            q["audience"] not in ("human", "agents")
            and q["audience"] != agent["name"]
            and agent["kind"] != "human"
        ):
            raise Invalid(
                f'question #{id} is addressed to @{q["audience"]}, not you.'
                f' Post your view instead, or let {q["audience"]} answer.'
            )

        ts = now()
        self.db.run(
            "UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?",
            (str(answer), agent["name"], ts, q["id"]),
        )

        # Thread the answer under the question's own message, so the room can
        # see which reply answers which tag rather than matching them by eye.
        asked = self.db.get(
            "SELECT id FROM messages WHERE ref_kind = 'question' AND ref_id = ? ORDER BY id LIMIT 1",
            (q["id"],),
        )
        self.post(
            idea=q["idea_id"],
            by=agent["name"],
            kind="answer",
            ref_kind="question",
            ref_id=q["id"],
            reply_to=asked["id"] if asked else None,
            body=f'Answering Q#{q["id"]} ("{q["body"][:80]}"): {answer}',
        )
        return {"id": q["id"], "answer": answer, "answeredBy": agent["name"], "answeredAt": ts}

    def questions(self, *, idea=None, open=True):
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None
        where, params = [], []
        if scoped:
            where.append("q.idea_id = ?")
            params.append(idea_id)
        if open:
            where.append("q.answered_at IS NULL")
        rows = self.db.all(
            f"""SELECT q.id, i.slug AS idea, q.body, q.asked_by AS askedBy, q.audience,
                       q.blocking, q.answer, q.answered_by AS answeredBy, q.answered_at AS answeredAt,
                       q.created_at AS createdAt
                FROM questions q LEFT JOIN ideas i ON i.id = q.idea_id
                {('WHERE ' + ' AND '.join(where)) if where else ''}
                ORDER BY q.blocking DESC, q.id""",
            tuple(params),
        )
        return [{**dict(q), "blocking": bool(q["blocking"])} for q in rows]


class DecisionsMixin:
    # ------------------------------------------------------------- decisions

    def decide(self, *, idea=None, choice, rationale="", alternatives="", by, supersedes=None):
        """Lock a choice in, with the reasoning, so nobody re-argues it blind."""
        if not choice or not str(choice).strip():
            raise Invalid("choice is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        ts = now()

        with self.db.transaction():
            if supersedes:
                old = self.db.get("SELECT * FROM decisions WHERE id = ?", (int(supersedes),))
                if not old:
                    raise NotFound(f"no decision #{supersedes} to supersede")
                self.db.run("UPDATE decisions SET retired_at = ? WHERE id = ?", (ts, old["id"]))
            cur = self.db.run(
                """INSERT INTO decisions
                     (idea_id, choice, rationale, alternatives, decided_by, supersedes, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (idea_id, str(choice).strip(), rationale, alternatives, agent["name"], supersedes, ts),
            )
            decision_id = int(cur.lastrowid)

        body = f"Decided: {choice}"
        if rationale:
            body += f"\nWhy: {rationale}"
        if supersedes:
            body += f"\nThis replaces decision #{supersedes}."
        self.post(
            idea=idea, by=agent["name"], kind="decision",
            ref_kind="decision", ref_id=decision_id, body=body,
        )
        return {
            "id": decision_id, "choice": choice, "rationale": rationale,
            "decidedBy": agent["name"], "createdAt": ts,
        }

    def decisions(self, *, idea=None, include_retired=False):
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None
        where, params = [], []
        if scoped:
            # Global decisions bind every idea, so an idea's view includes them.
            where.append("(d.idea_id = ? OR d.idea_id IS NULL)")
            params.append(idea_id)
        if not include_retired:
            where.append("d.retired_at IS NULL")
        return [
            dict(r)
            for r in self.db.all(
                f"""SELECT d.id, i.slug AS idea, d.choice, d.rationale, d.alternatives,
                           d.decided_by AS decidedBy, d.supersedes, d.retired_at AS retiredAt,
                           d.created_at AS createdAt
                    FROM decisions d LEFT JOIN ideas i ON i.id = d.idea_id
                    {('WHERE ' + ' AND '.join(where)) if where else ''}
                    ORDER BY d.id""",
                tuple(params),
            )
        ]

    # ------------------------------------------------------- durable facts

    def remember(self, *, idea=None, key, value, source="", by):
        """Upsert by key. Facts are what stops the room re-researching the obvious."""
        if not key or not str(key).strip():
            raise Invalid("key is required")
        agent = self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        ts = now()
        self.db.run(
            """INSERT INTO facts (idea_id, key, value, source, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(IFNULL(idea_id, 0), key) DO UPDATE SET
                 value = excluded.value, source = excluded.source,
                 updated_by = excluded.updated_by, updated_at = excluded.updated_at""",
            (idea_id, str(key).strip(), str(value), source, agent["name"], ts),
        )
        return {
            "key": key,
            "value": value,
            "scope": self.get_idea(idea_id)["slug"] if idea_id else "global",
            "updatedBy": agent["name"],
        }

    def recall(self, *, idea=None, key=None):
        scoped = idea is not None
        idea_id = self._idea_id(idea) if scoped else None
        where, params = [], []
        if scoped:
            where.append("(f.idea_id = ? OR f.idea_id IS NULL)")
            params.append(idea_id)
        if key:
            where.append("f.key = ?")
            params.append(str(key))
        return [
            dict(r)
            for r in self.db.all(
                f"""SELECT f.key, f.value, f.source, i.slug AS idea, f.updated_by AS updatedBy,
                           f.updated_at AS updatedAt
                    FROM facts f LEFT JOIN ideas i ON i.id = f.idea_id
                    {('WHERE ' + ' AND '.join(where)) if where else ''}
                    ORDER BY f.idea_id IS NOT NULL, f.key""",
                tuple(params),
            )
        ]

    def forget(self, *, idea=None, key, by):
        self._agent(by)
        idea_id = None if idea is None or idea == "" else self._idea_id(idea)
        cur = self.db.run(
            "DELETE FROM facts WHERE IFNULL(idea_id, 0) = IFNULL(?, 0) AND key = ?",
            (idea_id, str(key)),
        )
        if not cur.rowcount:
            raise NotFound(f'no fact "{key}" in that scope')
        return {"forgotten": key}
