"""
Competing ways of doing the work, and how one of them wins.

Several agents proposing under the same topic are alternatives, not noise. The
room scores them and the best-supported one wins on recorded reasoning — which
is the difference between a decision you can re-read and a decision somebody
remembers making.

The ranking is deliberately simple and explainable. An agent should be able to
see why a route is ahead, and a single unanswered blocking objection holds a
route back however popular it is: that guard is the whole process.
"""

from __future__ import annotations

from .common import PRESENCE_WINDOW_MS, Invalid, NotFound, ms_since, now


class ProposalsMixin:
    # --------------------------------------------------- competing proposals

    def propose(self, *, idea, topic="approach", title, approach, effort="",
                risks="", prerequisites="", by):
        idea_id = self._idea_id(idea)
        if idea_id is None:
            raise Invalid("a proposal must belong to an idea")
        if not title or not str(title).strip():
            raise Invalid("title is required")
        if not approach or not str(approach).strip():
            raise Invalid("approach is required")
        agent = self._agent(by)
        ts = now()

        cur = self.db.run(
            """INSERT INTO proposals
                 (idea_id, topic, title, approach, effort, risks, prerequisites, author, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (idea_id, topic, str(title).strip(), approach, effort, risks, prerequisites,
             agent["name"], ts, ts),
        )
        proposal_id = int(cur.lastrowid)

        # Proposing is what the 'proposing' stage is for; nudge the idea into it
        # so the overview shows the room deliberating rather than stalled.
        stage = self.db.value("SELECT stage FROM ideas WHERE id = ?", (idea_id,))
        if stage in ("raw", "refining"):
            self.db.run(
                "UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?",
                ("proposing", ts, idea_id),
            )

        body = f'@all Proposal P#{proposal_id} on "{topic}" — {title}\n\n{approach}'
        if effort:
            body += f"\n\nEffort: {effort}"
        if risks:
            body += f"\nRisks: {risks}"
        if prerequisites:
            body += f"\nNeeds first: {prerequisites}"
        body += f"\n\nScore it with weigh_in(proposal: {proposal_id}, ...)."
        self.post(
            idea=idea, by=agent["name"], kind="proposal",
            ref_kind="proposal", ref_id=proposal_id, body=body,
        )
        return self.get_proposal(proposal_id)

    def get_proposal(self, id):
        p = self.db.get(
            """SELECT p.*, i.slug AS idea_slug FROM proposals p JOIN ideas i ON i.id = p.idea_id
               WHERE p.id = ?""",
            (int(id),),
        )
        if not p:
            raise NotFound(f"no proposal #{id}")
        assessments = [
            {**dict(a), "blocking": bool(a["blocking"])}
            for a in self.db.all(
                """SELECT agent, stance, feasibility, reasoning, blocking,
                          resolved_by AS resolvedBy, resolved_at AS resolvedAt, updated_at AS updatedAt
                   FROM assessments WHERE proposal_id = ? ORDER BY updated_at""",
                (p["id"],),
            )
        ]
        return {
            "id": p["id"],
            "idea": p["idea_slug"],
            "topic": p["topic"],
            "title": p["title"],
            "approach": p["approach"],
            "effort": p["effort"] or None,
            "risks": p["risks"] or None,
            "prerequisites": p["prerequisites"] or None,
            "author": p["author"],
            "status": p["status"],
            "chosenBy": p["chosen_by"],
            "createdAt": p["created_at"],
            "assessments": assessments,
            **self._score(assessments),
        }

    @staticmethod
    def _score(assessments):
        endorse = sum(1 for a in assessments if a["stance"] == "endorse")
        object_ = sum(1 for a in assessments if a["stance"] == "object")
        scores = [a["feasibility"] for a in assessments if isinstance(a["feasibility"], (int, float))]
        feasibility = round(sum(scores) / len(scores), 2) if scores else None
        open_blocking = [a for a in assessments if a["blocking"] and not a["resolvedAt"]]
        return {
            "support": endorse - object_,
            "endorsements": endorse,
            "objections": object_,
            "voters": len(assessments),
            "feasibility": feasibility,
            "blockingObjections": [
                {"agent": a["agent"], "reasoning": a["reasoning"]} for a in open_blocking
            ],
            "choosable": not open_blocking and bool(assessments),
        }

    def weigh_in(self, *, proposal, stance, feasibility=None, reasoning="", blocking=False, by):
        """
        Score somebody else's proposal.

        Upsert by agent, because being argued out of a position and updating
        your score is the mechanism working, not a failure of it.
        """
        p = self.db.get("SELECT * FROM proposals WHERE id = ?", (int(proposal),))
        if not p:
            raise NotFound(f"no proposal #{proposal}")
        if p["status"] != "open":
            raise Invalid(f'proposal #{p["id"]} is {p["status"]}, not open')
        agent = self._agent(by)
        if stance not in ("endorse", "object", "neutral"):
            raise Invalid("stance must be endorse, object or neutral")
        if feasibility is not None:
            if not isinstance(feasibility, int) or isinstance(feasibility, bool) \
                    or feasibility < 1 or feasibility > 5:
                raise Invalid("feasibility must be an integer 1-5")
        if stance == "object" and not str(reasoning).strip():
            # An objection with no argument cannot be answered, so it would
            # stall the room forever. Refuse it rather than let it land.
            raise Invalid("an objection must say what breaks — reasoning is required")
        if blocking and stance != "object":
            raise Invalid("only an objection can be blocking")

        ts = now()
        self.db.run(
            """INSERT INTO assessments
                 (proposal_id, agent, stance, feasibility, reasoning, blocking, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(proposal_id, agent) DO UPDATE SET
                 stance = excluded.stance, feasibility = excluded.feasibility,
                 reasoning = excluded.reasoning, blocking = excluded.blocking,
                 resolved_by = NULL, resolved_at = NULL, updated_at = excluded.updated_at""",
            (p["id"], agent["name"], stance, feasibility, str(reasoning), 1 if blocking else 0, ts),
        )
        self.db.run("UPDATE proposals SET updated_at = ? WHERE id = ?", (ts, p["id"]))

        body = f'On P#{p["id"]} ({p["title"]}): {stance}'
        if feasibility:
            body += f", feasibility {feasibility}/5"
        if blocking:
            body += " — BLOCKING"
        if reasoning:
            body += f"\n{reasoning}"
        self.post(
            idea=p["idea_id"], by=agent["name"], kind="critique",
            ref_kind="proposal", ref_id=p["id"], body=body,
        )
        return self.get_proposal(p["id"])

    def resolve_objection(self, *, proposal, agent, how, by):
        """Answer a blocking objection so the route can be considered again."""
        p = self.db.get("SELECT * FROM proposals WHERE id = ?", (int(proposal),))
        if not p:
            raise NotFound(f"no proposal #{proposal}")
        actor = self._agent(by)
        row = self.db.get(
            "SELECT * FROM assessments WHERE proposal_id = ? AND agent = ?", (p["id"], agent)
        )
        if not row:
            raise NotFound(f'{agent} has not assessed proposal #{p["id"]}')
        if not row["blocking"]:
            raise Invalid(f"{agent}'s assessment is not a blocking objection")
        if row["resolved_at"]:
            raise Invalid(f'already resolved by {row["resolved_by"]}')

        ts = now()
        self.db.run(
            "UPDATE assessments SET resolved_by = ?, resolved_at = ? WHERE proposal_id = ? AND agent = ?",
            (actor["name"], ts, p["id"], agent),
        )
        self.post(
            idea=p["idea_id"], by=actor["name"], kind="critique",
            ref_kind="proposal", ref_id=p["id"],
            body=f'@{agent} your blocking objection on P#{p["id"]} is addressed: {how}'
                 "\nRe-score it if you disagree.",
        )
        return self.get_proposal(p["id"])

    def _present(self, agent_view):
        """Seen recently enough that the room should still wait on them."""
        return ms_since(agent_view.get("lastSeen")) < PRESENCE_WINDOW_MS

    def standing(self, *, idea, topic=None):
        """
        The standing of a contest: every route, ranked, and an explicit
        statement of what is stopping a winner being picked. This is the call
        that turns a pile of opinions into a next action.
        """
        idea_id = self._idea_id(idea)
        rows = self.db.all(
            f"""SELECT id, topic FROM proposals WHERE idea_id = ? {'AND topic = ?' if topic else ''}
                ORDER BY topic, id""",
            (idea_id, topic) if topic else (idea_id,),
        )

        by_topic: dict[str, list] = {}
        for r in rows:
            by_topic.setdefault(r["topic"], []).append(self.get_proposal(r["id"]))

        # Only agents that are actually around can be waited on. An agent that
        # joined once and never returned must not hold a decision open forever.
        roster = [a for a in self.roster() if a["kind"] == "agent" and self._present(a)]

        contests = []
        for t, proposals in by_topic.items():
            chosen = next((p for p in proposals if p["status"] == "chosen"), None)
            open_ = [p for p in proposals if p["status"] == "open"]
            # Most support first, then feasibility, then earliest — so a tie
            # breaks toward whoever did the work of proposing first.
            ranked = sorted(open_, key=lambda p: (-p["support"], -(p["feasibility"] or 0), p["id"]))

            not_yet_scored = []
            for p in open_:
                scored = {a["agent"] for a in p["assessments"]}
                missing = [a["name"] for a in roster if a["name"] != p["author"] and a["name"] not in scored]
                if missing:
                    not_yet_scored.append({"proposal": p["id"], "awaiting": missing})

            first_choosable = next((p for p in ranked if p["choosable"]), None)
            if chosen:
                verdict = f'settled: P#{chosen["id"]} ({chosen["title"]})'
            elif not open_:
                verdict = "nothing on the table — somebody propose()"
            elif not_yet_scored:
                verdict = "still gathering scores — every agent should weigh_in before a route is chosen"
            elif not any(p["choosable"] for p in ranked):
                verdict = "every route has an unanswered blocking objection — resolve one or propose another"
            elif len(ranked) > 1 and ranked[0]["support"] == ranked[1]["support"] and ranked[0]["choosable"]:
                verdict = (
                    f'tied on support between P#{ranked[0]["id"]} and P#{ranked[1]["id"]}'
                    " — argue it out or let the human choose"
                )
            else:
                verdict = f'ready: choose P#{first_choosable["id"] if first_choosable else None}'

            contests.append({
                "topic": t,
                "chosen": (
                    {"id": chosen["id"], "title": chosen["title"], "by": chosen["chosenBy"]}
                    if chosen else None
                ),
                "leader": (
                    {"id": ranked[0]["id"], "title": ranked[0]["title"], "support": ranked[0]["support"]}
                    if ranked else None
                ),
                "ranked": [
                    {
                        "id": p["id"], "title": p["title"], "author": p["author"],
                        "support": p["support"], "feasibility": p["feasibility"],
                        "voters": p["voters"], "choosable": p["choosable"],
                        "blockingObjections": p["blockingObjections"],
                    }
                    for p in ranked
                ],
                "awaitingScores": not_yet_scored,
                "verdict": verdict,
            })
        return {"idea": self.get_idea(idea_id)["slug"], "contests": contests}

    def choose(self, *, proposal, rationale="", by, force=False):
        """
        Pick a route.

        Records a decision automatically — the point of the contest is that the
        outcome becomes binding memory, not just a popular message.
        """
        p = self.get_proposal(proposal)
        agent = self._agent(by)
        if p["status"] != "open":
            raise Invalid(f'proposal #{p["id"]} is already {p["status"]}')

        # The human can overrule the room; an agent may not steamroll a live
        # blocking objection, because that is the one guard on the whole process.
        if not p["choosable"] and not force and agent["kind"] != "human":
            why = (
                "nobody has scored it yet" if p["voters"] == 0
                else "unanswered blocking objection(s) from "
                     + ", ".join(o["agent"] for o in p["blockingObjections"])
            )
            raise Invalid(
                f'cannot choose P#{p["id"]}: {why}. Resolve it, or have the human choose.'
            )

        ts = now()
        with self.db.transaction():
            self.db.run(
                "UPDATE proposals SET status = 'chosen', chosen_by = ?, chosen_at = ?, updated_at = ? WHERE id = ?",
                (agent["name"], ts, ts, p["id"]),
            )
            # Everything else under this topic is now off the table.
            self.db.run(
                """UPDATE proposals SET status = 'rejected', updated_at = ?
                   WHERE idea_id = (SELECT idea_id FROM proposals WHERE id = ?)
                     AND topic = ? AND id != ? AND status = 'open'""",
                (ts, p["id"], p["topic"], p["id"]),
            )

        alternatives = "; ".join(
            f'P#{r["id"]} {r["title"]}'
            for r in self.db.all(
                """SELECT id, title FROM proposals
                   WHERE idea_id = (SELECT idea_id FROM proposals WHERE id = ?)
                     AND topic = ? AND id != ?""",
                (p["id"], p["topic"], p["id"]),
            )
        )
        reason = (f"{rationale}\n\n" if rationale else "")
        reason += f'Chosen over {len(p["assessments"])} assessment(s); support {p["support"]}'
        if p["feasibility"]:
            reason += f', mean feasibility {p["feasibility"]}/5'
        reason += f'.\n\n{p["approach"]}'

        decision = self.decide(
            idea=p["idea"], by=agent["name"],
            choice=f'{p["topic"]}: {p["title"]} (P#{p["id"]})',
            rationale=reason, alternatives=alternatives,
        )
        return {"proposal": self.get_proposal(p["id"]), "decision": decision}

    def withdraw(self, *, proposal, by, why=""):
        p = self.db.get("SELECT * FROM proposals WHERE id = ?", (int(proposal),))
        if not p:
            raise NotFound(f"no proposal #{proposal}")
        agent = self._agent(by)
        if p["author"] != agent["name"] and agent["kind"] != "human":
            raise Invalid(f'only {p["author"]} or the human can withdraw P#{p["id"]}')
        self.db.run(
            "UPDATE proposals SET status = 'withdrawn', updated_at = ? WHERE id = ?",
            (now(), p["id"]),
        )
        self.post(
            idea=p["idea_id"], by=agent["name"], kind="proposal",
            ref_kind="proposal", ref_id=p["id"],
            body=f'Withdrew P#{p["id"]} ({p["title"]})' + (f": {why}" if why else ""),
        )
        return self.get_proposal(p["id"])
