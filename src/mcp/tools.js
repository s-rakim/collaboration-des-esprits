import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSE_RULES } from '../roles.js';

/**
 * The connector surface. Every tool is a thin shell over a Hub method — the
 * rules live in core.js so the HTTP API and the tests cannot drift from what
 * agents see.
 *
 * Identity: MCP has no per-call notion of who is calling, so each agent either
 * runs its own stdio process pinned to a name (ESPRITS_AGENT), or passes `as`
 * on each call when several agents share one HTTP server.
 */

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Render a message list compactly — an agent reads this better than raw JSON. */
function renderMessages(messages) {
  if (!messages.length) return 'No new messages.';
  return messages
    .map((m) => {
      const tag = m.kind === 'message' ? '' : ` [${m.kind}]`;
      const where = m.idea ? ` (${m.idea})` : ' (lobby)';
      const ref = m.ref ? ` →${m.ref.kind}#${m.ref.id}` : '';
      return `#${m.id} ${m.author}${tag}${where}${ref}\n${m.body}`;
    })
    .join('\n\n');
}

export function buildServer({ hub, identity = null }) {
  const server = new McpServer(
    { name: 'collaboration-des-esprits', version: '0.1.0' },
    {
      instructions:
        `A shared room where several AI agents collaborate on the human's ideas. It is shared ` +
        `memory, not a chat log: everything settled here is retrievable by any agent, so nobody ` +
        `has to be re-briefed.\n\n` +
        `Start by calling catch_up. Before contributing to an idea, call brief(idea) — it returns ` +
        `the original dump, the current spec, every binding decision with its reasoning, the open ` +
        `questions and the board, in one call.\n\n` +
        `How work moves: the human drops an idea → agents propose() competing approaches → every ` +
        `agent scores each one with weigh_in() → the room converges and choose()s a route, which ` +
        `becomes a binding decision → a planner cuts it into tasks → builders claim_next() work ` +
        `whose blockers are cleared.\n\nHouse rules:\n` +
        HOUSE_RULES.map((r) => `- ${r}`).join('\n'),
    },
  );

  /** Resolve who is calling, preferring the explicit argument. */
  const who = (as) => {
    const name = as ?? identity?.name;
    if (!name) {
      throw new Error(
        'no identity: pass `as` with your agent name, or start this server with ESPRITS_AGENT set',
      );
    }
    return name;
  };

  // `as` is optional on a pinned stdio server and required on a shared one.
  const AS = z.string().optional().describe('Your agent name. Optional if this server is pinned to one agent.');
  const IDEA = z.union([z.string(), z.number()]).describe('Idea slug or numeric id.');

  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        // Hand the agent the reason, not a stack trace: these errors are
        // written to be actionable ("resolve it, or have the human choose").
        return fail(`${err.code ? `${err.code}: ` : ''}${err.message}`);
      }
    });

  // ------------------------------------------------------------- identity

  tool(
    'join',
    {
      title: 'Join the room',
      description:
        'Announce yourself and get your role charter plus whatever is waiting on you. Idempotent: ' +
        'rejoining under the same name keeps your history and read position. Call this first.',
      inputSchema: {
        name: z.string().describe('Your handle. No spaces — other agents @mention you by it.'),
        role: z
          .string()
          .default('generalist')
          .describe('architect, critic, researcher, planner, backend, frontend, reviewer, generalist, or one of your own.'),
        kind: z.enum(['agent', 'human']).default('agent'),
        model: z.string().default('').describe('Optional: which model you are, for the roster.'),
        capabilities: z.array(z.string()).default([]).describe('Optional: what you can actually do (e.g. "runs tests", "edits repo").'),
      },
    },
    async (a) => {
      const r = hub.join(a);
      return text(
        `You are ${r.agent.name} (${r.agent.role})${r.rejoined ? ' — welcome back' : ''}.\n\n` +
          `## Your charter\n${r.role.summary}\n${r.role.charter}\n\n` +
          `## House rules\n${r.role.houseRules.map((x) => `- ${x}`).join('\n')}\n\n` +
          `## Waiting on you\n${r.waiting.nudges.map((n) => `- ${n}`).join('\n')}`,
      );
    },
  );

  tool(
    'catch_up',
    {
      title: 'What should I do next',
      description:
        'Your personal to-do across every idea: messages aimed at you, proposals waiting on your ' +
        'score, questions you owe an answer to, handoffs matching your role, and what you can claim.',
      inputSchema: { as: AS },
    },
    async (a) => {
      const c = hub.catchUp({ name: who(a.as) });
      if (!c) return fail('you have not joined yet — call join first');
      const L = [`You are ${c.me.name} (${c.me.role}, ${c.me.status}).`, ''];
      L.push('## Next actions', ...c.nudges.map((n) => `- ${n}`), '');
      if (c.myTasks.length) {
        L.push('## Tasks you own', ...c.myTasks.map((t) => `- #${t.id} ${t.title} (${t.status})${t.idea ? ` — ${t.idea}` : ''}`), '');
      }
      if (c.claimableTasks.length) {
        L.push('## Claimable', ...c.claimableTasks.map((t) => `- #${t.id} [${t.role}] ${t.title}${t.idea ? ` — ${t.idea}` : ''}`), '');
      }
      if (c.proposalsAwaitingMyScore.length) {
        L.push('## Proposals awaiting your score', ...c.proposalsAwaitingMyScore.map((p) => `- P#${p.id} "${p.title}" by ${p.author} on ${p.idea} (${p.topic})`), '');
      }
      if (c.questionsForMe.length) {
        L.push('## Questions for you', ...c.questionsForMe.map((q) => `- Q#${q.id} ${q.body}${q.idea ? ` (${q.idea})` : ''}`), '');
      }
      if (c.handoffsForMe.length) {
        L.push('## Handoffs you could pick up', ...c.handoffsForMe.map((h) => `- H#${h.id} from ${h.from}: ${h.summary}`), '');
      }
      if (c.ideasNeedingAttention.length) {
        L.push('## Ideas needing attention');
        for (const i of c.ideasNeedingAttention) L.push(`- ${i.idea} (${i.stage}): ${i.reasons.join('; ')}`);
      }
      return text(L.join('\n'));
    },
  );

  tool(
    'whos_here',
    { title: 'Roster', description: 'Every agent in the room, their role, status and current work.', inputSchema: {} },
    async () =>
      text(
        hub
          .roster()
          .map(
            (a) =>
              `- ${a.name} — ${a.role} (${a.kind}, ${a.status})` +
              (a.statusNote ? `: ${a.statusNote}` : '') +
              (a.workingOn.length ? ` · on ${a.workingOn.map((t) => `#${t.id} ${t.title}`).join(', ')}` : '') +
              ` · last seen ${a.lastSeen}`,
          )
          .join('\n') || 'Nobody has joined yet.',
      ),
  );

  tool(
    'set_status',
    {
      title: 'Set your status',
      description: 'Tell the room whether you are idle, working, blocked or away, and on what.',
      inputSchema: { as: AS, status: z.enum(['idle', 'working', 'blocked', 'away']), note: z.string().default('') },
    },
    async (a) => text(hub.setStatus({ name: who(a.as), status: a.status, note: a.note })),
  );

  // ---------------------------------------------------------------- context

  tool(
    'brief',
    {
      title: 'Load the full context on an idea',
      description:
        'THE call that replaces being re-briefed. Returns the original idea as dropped, the current ' +
        'spec, every binding decision with its reasoning, established facts, open questions, where ' +
        'the proposals stand, the board, unclaimed handoffs and the tail of the conversation. ' +
        'Call this before your first contribution to any idea, and do not re-open anything it ' +
        'lists as decided unless you have new information.',
      inputSchema: { as: AS, idea: IDEA, messages: z.number().int().min(0).max(200).default(25).describe('How much recent conversation to include.') },
    },
    async (a) => text(hub.brief({ idea: a.idea, messages: a.messages, by: a.as ?? identity?.name ?? null }).digest),
  );

  tool(
    'overview',
    {
      title: 'Project overview',
      description: 'Every idea, its stage, and an explicit list of what is stuck and why. The dashboard call.',
      inputSchema: {},
    },
    async () => {
      const o = hub.overview();
      const L = [
        '# Project overview',
        '',
        Object.entries(o.byStage).map(([k, v]) => `${v} ${k}`).join(' · ') || 'No ideas yet.',
        '',
        `${o.totals.openProposals} open proposal(s) · ${o.totals.openQuestions} open question(s) · ` +
          `${o.totals.decisions} decision(s) · ${o.totals.openTasks} open task(s), ${o.totals.doneTasks} done · ` +
          `${o.totals.facts} fact(s)`,
        '',
      ];
      if (o.ideas.length) {
        L.push('## Ideas');
        for (const i of o.ideas) {
          L.push(`- **${i.slug}** (${i.stage}) ${i.title} — ${i.openTasks} open task(s), ${i.openQuestions} open question(s), ${i.openProposals} open proposal(s)`);
        }
        L.push('');
      }
      if (o.needsAttention.length) {
        L.push('## Needs attention');
        for (const i of o.needsAttention) L.push(`- **${i.idea}** (${i.stage}): ${i.reasons.join('; ')}`);
        L.push('');
      }
      L.push('## Room', ...o.roster.map((a) => `- ${a.name} — ${a.role} (${a.status})`));
      return text(L.join('\n'));
    },
  );

  // ------------------------------------------------------------------ ideas

  tool(
    'drop_idea',
    {
      title: 'Drop a new idea',
      description: 'Put a raw idea on the table. The raw text is kept verbatim forever; refinement lands in the spec.',
      inputSchema: { as: AS, title: z.string(), raw: z.string().default('').describe('The dump — as messy as you like.') },
    },
    async (a) => {
      const i = hub.dropIdea({ title: a.title, raw: a.raw, by: who(a.as) });
      return text(`Idea "${i.slug}" created (#${i.id}, stage ${i.stage}). Agents: brief(idea: "${i.slug}") then propose() an approach.`);
    },
  );

  tool(
    'list_ideas',
    {
      title: 'List ideas',
      description: 'Every idea with its stage and open counts.',
      inputSchema: { stage: z.string().optional().describe('raw, refining, proposing, spec, building, review, done, parked'), limit: z.number().int().min(1).max(200).default(50) },
    },
    async (a) =>
      text(
        hub
          .listIdeas(a)
          .map((i) => `- **${i.slug}** (${i.stage}) ${i.title} — ${i.openProposals} open proposal(s), ${i.openQuestions} open question(s), ${i.openTasks}/${i.openTasks + i.doneTasks} task(s) open`)
          .join('\n') || 'No ideas yet.',
      ),
  );

  tool(
    'refine_spec',
    {
      title: 'Write or revise the spec',
      description:
        'Replace the spec with a new revision. Every revision is kept. Do this after a route has been ' +
        'chosen, not instead of proposing one — the spec records what was agreed, it is not a way to ' +
        'skip the agreement.',
      inputSchema: { as: AS, idea: IDEA, spec: z.string().describe('The full spec text, not a patch.'), summary: z.string().default('').describe('One line on what changed.') },
    },
    async (a) => {
      const r = hub.refine({ ref: a.idea, spec: a.spec, summary: a.summary, by: who(a.as) });
      return text(`Spec for "${r.slug}" is now rev ${r.rev}.`);
    },
  );

  tool(
    'advance_stage',
    {
      title: 'Move an idea along',
      description:
        'Move an idea to raw, refining, proposing, spec, building, review, done or parked. Refuses to ' +
        'reach building over an empty spec or unanswered blocking questions unless you force it.',
      inputSchema: { as: AS, idea: IDEA, stage: z.enum(['raw', 'refining', 'proposing', 'spec', 'building', 'review', 'done', 'parked']), force: z.boolean().default(false) },
    },
    async (a) => text(`"${hub.advance({ ref: a.idea, stage: a.stage, by: who(a.as), force: a.force }).slug}" is now ${a.stage}.`),
  );

  // ------------------------------------------------------------------- chat

  tool(
    'post',
    {
      title: 'Say something',
      description:
        'Post to an idea thread, or to the lobby when no idea is given. @mention an agent by name to ' +
        'address it, or @all for everyone. Use the right kind so the room stays searchable — but ' +
        'remember chat is not memory: anything a future agent needs belongs in decide(), remember() ' +
        'or handoff().',
      inputSchema: {
        as: AS,
        body: z.string(),
        idea: IDEA.optional().describe('Omit to post in the lobby.'),
        kind: z.enum(['message', 'critique', 'proposal', 'question', 'answer', 'status', 'handoff']).default('message'),
        reply_to: z.number().int().optional().describe('Message id you are replying to.'),
      },
    },
    async (a) => {
      const m = hub.post({ idea: a.idea ?? null, body: a.body, by: who(a.as), kind: a.kind, replyTo: a.reply_to ?? null });
      return text(`Posted #${m.id}${m.mentions.length ? ` (mentioned: ${m.mentions.join(', ')})` : ''}.`);
    },
  );

  tool(
    'read',
    {
      title: 'Read new messages',
      description:
        'Messages you have not seen, from your own read position. Your cursor advances, so calling ' +
        'this in a loop gives you each message once.',
      inputSchema: {
        as: AS,
        idea: IDEA.optional().describe('Omit for the whole room.'),
        mentioning_me: z.boolean().default(false).describe('Only messages that @mention you or @all.'),
        limit: z.number().int().min(1).max(200).default(50),
        since: z.number().int().optional().describe('Read from this message id instead of your cursor.'),
        peek: z.boolean().default(false).describe('Do not advance your cursor.'),
      },
    },
    async (a) => {
      const r = hub.read({
        by: who(a.as),
        idea: a.idea,
        since: a.since ?? null,
        limit: a.limit,
        advance: !a.peek,
        mentioningMe: a.mentioning_me,
      });
      return text(renderMessages(r.messages) + `\n\n---\ncursor ${r.cursor}${r.more ? ' · more waiting, call read again' : ''}`);
    },
  );

  tool(
    'wait',
    {
      title: 'Wait for someone to say something',
      description:
        'Block until a new message arrives or the timeout expires, then return it. This is how you ' +
        'hold a conversation instead of polling: loop on wait(), respond to what comes back, and ' +
        'wait again. Returns immediately if something is already unread. A timeout is normal and ' +
        'means the room is quiet — just call it again.',
      inputSchema: {
        as: AS,
        idea: IDEA.optional().describe('Only wait on one idea.'),
        mentioning_me: z.boolean().default(false).describe('Only wake for messages that @mention you or @all.'),
        timeout_seconds: z.number().int().min(1).max(60).default(25).describe('Keep this under your client request timeout.'),
      },
    },
    async (a) => {
      const r = await hub.waitFor({
        by: who(a.as),
        idea: a.idea,
        mentioningMe: a.mentioning_me,
        timeoutMs: a.timeout_seconds * 1000,
      });
      if (r.timedOut) return text(`(quiet for ${a.timeout_seconds}s — nothing new. Call wait again.)`);
      return text(renderMessages(r.messages) + `\n\n---\ncursor ${r.cursor}`);
    },
  );

  tool(
    'search',
    {
      title: 'Search the history',
      description: 'Full-text search over everything ever said. Use this before asking a question somebody may already have answered.',
      inputSchema: { query: z.string(), idea: IDEA.optional(), limit: z.number().int().min(1).max(100).default(25) },
    },
    async (a) => text(renderMessages(hub.search(a))),
  );

  // -------------------------------------------------- questions & decisions

  tool(
    'ask',
    {
      title: 'Ask a blocking question',
      description:
        'Raise something you genuinely cannot proceed without. Default audience is the human, and no ' +
        'agent may answer on their behalf. Search first — if it is already settled, this just adds noise.',
      inputSchema: {
        as: AS,
        body: z.string(),
        idea: IDEA.optional(),
        audience: z.string().default('human').describe('"human", "agents", or a specific agent name.'),
        blocking: z.boolean().default(true).describe('Does this actually stop progress? Blocking questions hold an idea out of building.'),
      },
    },
    async (a) => {
      const q = hub.ask({ idea: a.idea ?? null, body: a.body, by: who(a.as), audience: a.audience, blocking: a.blocking });
      return text(`Asked Q#${q.id} (${q.audience}${q.blocking ? ', blocking' : ''}).`);
    },
  );

  tool(
    'answer',
    {
      title: 'Answer a question',
      description: 'Close an open question. Questions addressed to the human can only be answered by the human.',
      inputSchema: { as: AS, id: z.number().int(), answer: z.string() },
    },
    async (a) => text(`Q#${hub.answer({ id: a.id, answer: a.answer, by: who(a.as) }).id} answered.`),
  );

  tool(
    'list_questions',
    { title: 'Open questions', description: 'What the room is still waiting to find out.', inputSchema: { idea: IDEA.optional(), open: z.boolean().default(true) } },
    async (a) =>
      text(
        hub
          .questions(a)
          .map((q) => `- Q#${q.id} (${q.audience}${q.blocking ? ', blocking' : ''}) ${q.body} — ${q.askedBy}${q.answer ? `\n  → ${q.answer} (${q.answeredBy})` : ''}`)
          .join('\n') || 'No questions.',
      ),
  );

  tool(
    'decide',
    {
      title: 'Record a decision',
      description:
        'Lock a choice in with its reasoning, so no later agent re-argues it blind. Prefer choose() ' +
        'when the decision is between proposals. Pass supersedes to reverse an earlier decision — the ' +
        'old one is retired, not deleted.',
      inputSchema: {
        as: AS,
        choice: z.string().describe('What was decided, in one line.'),
        rationale: z.string().default('').describe('Why. This is the part that stops it being re-litigated.'),
        alternatives: z.string().default('').describe('What was rejected, and briefly why.'),
        idea: IDEA.optional().describe('Omit for a decision that binds every idea.'),
        supersedes: z.number().int().optional(),
      },
    },
    async (a) => text(`Decision #${hub.decide({ ...a, by: who(a.as), idea: a.idea ?? null }).id} recorded.`),
  );

  tool(
    'list_decisions',
    { title: 'Decisions', description: 'Binding decisions and their reasoning. Read before arguing.', inputSchema: { idea: IDEA.optional(), include_retired: z.boolean().default(false) } },
    async (a) =>
      text(
        hub
          .decisions({ idea: a.idea, includeRetired: a.include_retired })
          .map((d) => `- #${d.id}${d.retiredAt ? ' (RETIRED)' : ''} ${d.choice} — ${d.decidedBy}${d.rationale ? `\n  ${d.rationale.replace(/\n/g, '\n  ')}` : ''}${d.alternatives ? `\n  Rejected: ${d.alternatives}` : ''}`)
          .join('\n') || 'No decisions yet.',
      ),
  );

  tool(
    'remember',
    {
      title: 'Record a durable fact',
      description:
        'Store something every agent should know — a version constraint, an API limit, a convention. ' +
        'Omit idea to make it global. This is how the room stops researching the same thing twice.',
      inputSchema: { as: AS, key: z.string(), value: z.string(), source: z.string().default('').describe('Where this came from, if it matters.'), idea: IDEA.optional() },
    },
    async (a) => {
      const f = hub.remember({ ...a, by: who(a.as), idea: a.idea ?? null });
      return text(`Remembered ${f.key} (${f.scope}).`);
    },
  );

  tool(
    'recall',
    { title: 'Recall facts', description: 'Established facts, global plus any scoped to the idea.', inputSchema: { idea: IDEA.optional(), key: z.string().optional() } },
    async (a) =>
      text(
        hub
          .recall(a)
          .map((f) => `- ${f.key}: ${f.value}${f.source ? ` (${f.source})` : ''} · ${f.idea ?? 'global'}`)
          .join('\n') || 'Nothing recorded yet.',
      ),
  );

  // ---------------------------------------------------- competing proposals

  tool(
    'propose',
    {
      title: 'Propose a way to do the work',
      description:
        'Put an approach on the table. Several agents proposing under the same topic are competing ' +
        'alternatives, and that is the intent: the room scores them and the best-supported route wins ' +
        'on recorded reasoning. Do not start building a non-obvious approach without proposing it. ' +
        'Be honest about effort and risks — everyone else is about to check them.',
      inputSchema: {
        as: AS,
        idea: IDEA,
        title: z.string().describe('Short name for this route, e.g. "SQLite WAL, no daemon".'),
        approach: z.string().describe('How it works, concretely enough to be argued with.'),
        topic: z.string().default('approach').describe('What is being decided. Proposals sharing a topic compete; a new topic is a new question.'),
        effort: z.string().default('').describe('Your honest estimate.'),
        risks: z.string().default('').describe('What could go wrong, stated plainly.'),
        prerequisites: z.string().default('').describe('What must exist first.'),
      },
    },
    async (a) => {
      const p = hub.propose({ ...a, by: who(a.as) });
      return text(`Proposal P#${p.id} on "${p.topic}" is open for scoring. Other agents: weigh_in(proposal: ${p.id}).`);
    },
  );

  tool(
    'weigh_in',
    {
      title: 'Score somebody else’s proposal',
      description:
        'Assess an open proposal: endorse, object or neutral, with a feasibility score 1-5 and the ' +
        'reason for it. Feasibility means "can be built now, with what is actually available" — not ' +
        'how elegant it is. An objection must name what breaks. Mark it blocking only if choosing ' +
        'this route would genuinely break something, because a blocking objection holds the route ' +
        'until it is answered. Re-calling this replaces your earlier score, which is how you change ' +
        'your mind once somebody answers you.',
      inputSchema: {
        as: AS,
        proposal: z.number().int(),
        stance: z.enum(['endorse', 'object', 'neutral']),
        feasibility: z.number().int().min(1).max(5).optional().describe('1 = will not work, 5 = clearly workable now.'),
        reasoning: z.string().default('').describe('Required for an objection. Give the concrete failure case.'),
        blocking: z.boolean().default(false).describe('Only for an objection, and only for a real breakage.'),
      },
    },
    async (a) => {
      const p = hub.weighIn({ ...a, by: who(a.as) });
      return text(
        `Scored P#${p.id}: support ${p.support}, mean feasibility ${p.feasibility ?? 'n/a'}, ${p.voters} voter(s).` +
          (p.choosable ? ' It is choosable.' : ` Held by blocking objection(s) from ${p.blockingObjections.map((o) => o.agent).join(', ') || 'nobody yet'}.`),
      );
    },
  );

  tool(
    'standing',
    {
      title: 'Where the proposals stand',
      description:
        'Every route ranked, plus an explicit verdict on what is stopping a winner being picked — ' +
        'missing scores, an unanswered blocking objection, or a tie. Call this to find out what the ' +
        'room needs from you.',
      inputSchema: { idea: IDEA, topic: z.string().optional() },
    },
    async (a) => {
      const s = hub.standing(a);
      if (!s.contests.length) return text(`Nothing proposed on "${s.idea}" yet. Somebody propose() an approach.`);
      const L = [];
      for (const c of s.contests) {
        L.push(`## ${c.topic}`, `_${c.verdict}_`, '');
        for (const r of c.ranked) {
          L.push(
            `- P#${r.id} **${r.title}** by ${r.author} — support ${r.support}, feasibility ${r.feasibility ?? 'unscored'}, ${r.voters} voter(s)${r.choosable ? '' : ' · HELD'}`,
          );
          for (const o of r.blockingObjections) L.push(`  - blocking, ${o.agent}: ${o.reasoning}`);
        }
        if (c.chosen) L.push(`- chosen: P#${c.chosen.id} ${c.chosen.title} (by ${c.chosen.by})`);
        for (const aw of c.awaitingScores) L.push(`- P#${aw.proposal} still needs scores from: ${aw.awaiting.join(', ')}`);
        L.push('');
      }
      return text(L.join('\n'));
    },
  );

  tool(
    'resolve_objection',
    {
      title: 'Answer a blocking objection',
      description:
        'Say how a blocking objection is addressed, which frees the route to be chosen. The objector ' +
        'is told, and can re-score if it still disagrees. Do not use this to wave an objection away.',
      inputSchema: { as: AS, proposal: z.number().int(), agent: z.string().describe('The objecting agent.'), how: z.string().describe('How the concern is actually handled.') },
    },
    async (a) => {
      const p = hub.resolveObjection({ ...a, by: who(a.as) });
      return text(`Marked ${a.agent}'s objection on P#${p.id} as addressed. Choosable: ${p.choosable}.`);
    },
  );

  tool(
    'choose',
    {
      title: 'Pick a route',
      description:
        'Settle a contest. The winning approach is recorded as a binding decision and the other routes ' +
        'are closed. Refuses while an unanswered blocking objection stands, or before anybody has ' +
        'scored it — the human can override both.',
      inputSchema: { as: AS, proposal: z.number().int(), rationale: z.string().default('').describe('Why this one.'), force: z.boolean().default(false) },
    },
    async (a) => {
      const r = hub.choose({ ...a, by: who(a.as) });
      return text(
        `Chose P#${r.proposal.id} "${r.proposal.title}". Recorded as decision #${r.decision.id}; other routes on "${r.proposal.topic}" are closed.\n` +
          `Next: refine_spec() to write up what was agreed, then plan() it into tasks.`,
      );
    },
  );

  tool(
    'withdraw_proposal',
    {
      title: 'Withdraw your proposal',
      description: 'Take your own route off the table — the honest move when somebody has convinced you.',
      inputSchema: { as: AS, proposal: z.number().int(), why: z.string().default('') },
    },
    async (a) => text(`Withdrew P#${hub.withdraw({ ...a, by: who(a.as) }).id}.`),
  );

  // ------------------------------------------------------------ build board

  tool(
    'plan',
    {
      title: 'Cut the spec into tasks',
      description:
        'Create an ordered batch of tasks. Each needs one role and one outcome. dependsOn takes ' +
        'positions in this same batch (0 = the first task here), so a whole ordered plan goes in one ' +
        'call; builders then self-order off the dependency graph without coordinating.',
      inputSchema: {
        as: AS,
        idea: IDEA,
        tasks: z
          .array(
            z.object({
              title: z.string(),
              detail: z.string().default(''),
              role: z.string().default('any').describe('Which builder this is for: backend, frontend, reviewer, any, ...'),
              dependsOn: z.array(z.number().int()).default([]).describe('Positions in this batch that must finish first.'),
            }),
          )
          .min(1),
      },
    },
    async (a) => {
      const created = hub.plan({ idea: a.idea, tasks: a.tasks, by: who(a.as) });
      return text(`Planned ${created.length} task(s):\n` + created.map((t) => `- #${t.id} [${t.role}] ${t.title}${t.blockedBy.length ? ` (waits on ${t.blockedBy.map((b) => `#${b.id}`).join(', ')})` : ''}`).join('\n'));
    },
  );

  tool(
    'claim_next',
    {
      title: 'Claim your next task',
      description:
        'Take the next task for your role whose blockers are all cleared, and receive the full brief ' +
        'with it. Claiming is atomic, so two builders cannot take the same task. When nothing is ' +
        'available it tells you why rather than looking finished. Reviewers get work awaiting review, ' +
        'never their own.',
      inputSchema: { as: AS, idea: IDEA.optional().describe('Restrict to one idea.'), role: z.string().optional().describe('Claim as a different role than you joined with.') },
    },
    async (a) => {
      const r = hub.claimNext({ by: who(a.as), idea: a.idea, role: a.role });
      if (!r.task) return text(`Nothing to claim: ${r.why}`);
      const t = r.task;
      return text(
        `# Claimed #${t.id} — ${t.title}\n\nRole: ${t.role}${t.idea ? ` · Idea: ${t.idea}` : ''}\n\n` +
          `${t.detail || '_No extra detail on the task._'}\n\n` +
          `When you stop, either update_task(status: "review"|"done", result: ...) or handoff() so the ` +
          `next agent is not left guessing.\n\n---\n\n${r.brief ? r.brief.digest : ''}`,
      );
    },
  );

  tool(
    'update_task',
    {
      title: 'Update a task',
      description:
        'Move a task along and record what you did. Setting it done announces whatever it unblocks, ' +
        'which is the signal other builders wait on. Put how to verify your work in result.',
      inputSchema: {
        as: AS,
        id: z.number().int(),
        status: z.enum(['todo', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'dropped']).optional(),
        result: z.string().optional().describe('What changed and how to check it.'),
        detail: z.string().optional(),
        note: z.string().default('').describe('Why the status changed.'),
      },
    },
    async (a) => {
      const r = hub.updateTask({ ...a, by: who(a.as) });
      return text(
        `#${r.task.id} is now ${r.task.status}.` +
          (r.unblocked.length ? ` This unblocks ${r.unblocked.map((t) => `#${t.id} [${t.role}] ${t.title}`).join(', ')}.` : ''),
      );
    },
  );

  tool(
    'list_tasks',
    {
      title: 'The board',
      description: 'Tasks, filterable by idea, status, owner or role.',
      inputSchema: { idea: IDEA.optional(), status: z.union([z.string(), z.array(z.string())]).optional(), owner: z.string().optional(), role: z.string().optional() },
    },
    async (a) =>
      text(
        hub
          .tasks(a)
          .map(
            (t) =>
              `- #${t.id} [${t.role}] ${t.title} — ${t.status}${t.owner ? ` (${t.owner})` : ''}` +
              (t.blockedBy.length ? ` · waits on ${t.blockedBy.map((b) => `#${b.id}`).join(', ')}` : t.runnable ? ' · CLAIMABLE' : ''),
          )
          .join('\n') || 'The board is empty.',
      ),
  );

  // --------------------------------------------------------------- handoffs

  tool(
    'handoff',
    {
      title: 'Hand your work over',
      description:
        'Write a structured context transfer before you stop mid-task: where it stands, what is next, ' +
        'and what will bite the next agent. The task goes back on the board so it is not stranded ' +
        'under your name. This is the thing that replaces re-explaining a half-finished job.',
      inputSchema: {
        as: AS,
        summary: z.string().describe('Where it actually stands right now.'),
        idea: IDEA.optional(),
        task: z.number().int().optional(),
        next_steps: z.string().default('').describe('The next concrete actions.'),
        watch_out: z.string().default('').describe('Traps, half-done edits, anything surprising.'),
        artifacts: z.array(z.string()).default([]).describe('Files or links you touched.'),
        to_role: z.string().optional().describe('Which role should pick this up.'),
      },
    },
    async (a) => {
      const h = hub.handoff({
        idea: a.idea ?? null, task: a.task ?? null, summary: a.summary, nextSteps: a.next_steps,
        watchOut: a.watch_out, artifacts: a.artifacts, toRole: a.to_role ?? null, by: who(a.as),
      });
      return text(`Handoff H#${h.id} posted${h.task ? ` and task #${h.task} is back on the board` : ''}.`);
    },
  );

  tool(
    'take_handoff',
    {
      title: 'Pick up a handoff',
      description: 'Claim an unclaimed handoff and get it together with the full brief for its idea.',
      inputSchema: { as: AS, id: z.number().int() },
    },
    async (a) => {
      const r = hub.takeHandoff({ id: a.id, by: who(a.as) });
      const h = r.handoff;
      return text(
        `# Handoff H#${h.id} from ${h.from}\n\n**Where it stands:** ${h.summary}\n` +
          (h.nextSteps ? `\n**Next:** ${h.nextSteps}\n` : '') +
          (h.watchOut ? `\n**Watch out:** ${h.watchOut}\n` : '') +
          (h.artifacts.length ? `\n**Touched:** ${h.artifacts.join(', ')}\n` : '') +
          (h.task ? `\nTask #${h.task} is on the board — claim_next() or update_task() it.\n` : '') +
          `\n---\n\n${r.brief ? r.brief.digest : ''}`,
      );
    },
  );

  tool(
    'list_handoffs',
    { title: 'Open handoffs', description: 'Unclaimed context transfers waiting for somebody to pick up.', inputSchema: { idea: IDEA.optional(), role: z.string().optional(), open: z.boolean().default(true) } },
    async (a) =>
      text(
        hub
          .handoffs(a)
          .map((h) => `- H#${h.id} from ${h.from}${h.toRole ? ` → ${h.toRole}` : ''}${h.idea ? ` on ${h.idea}` : ''}: ${h.summary}${h.claimedBy ? ` (taken by ${h.claimedBy})` : ''}`)
          .join('\n') || 'No open handoffs.',
      ),
  );
  // ------------------------------------------------------------------ prompts

  /**
   * The operating loop, as a prompt the client can load into its agent. Without
   * something like this an agent joins and then sits there: it has the tools
   * but no reason to keep listening.
   */
  server.registerPrompt(
    'participate',
    {
      title: 'Work in the room',
      description: 'The loop to run as a participant: listen, contribute, propose, score, build.',
      argsSchema: {
        as: z.string().optional().describe('Your agent name.'),
        role: z.string().optional().describe('Your role, if different from how you joined.'),
      },
    },
    (args) => {
      const name = args?.as ?? identity?.name ?? '<your name>';
      const role = args?.role ?? identity?.role ?? '<your role>';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `You are "${name}", the ${role}, in a room with a human and several other AI agents.`,
                `The human drops ideas; the room refines them into something buildable and then builds it.`,
                '',
                'Run this loop and keep running it. Do not stop after one pass.',
                '',
                '1. join(name, role) once, then catch_up() to see what is waiting on you.',
                '2. brief(idea) before your first contribution to any idea. It contains the original',
                '   dump, the spec, every decision with its reasoning, and the open questions.',
                '   Never re-open something it lists as decided unless you have new information.',
                '3. Then loop: wait() → act → wait() again.',
                '',
                'What to do when you wake:',
                '- The human dropped an idea, or asked something → answer in the thread. Talk to them',
                '  like a colleague, not a form. They are reading this on their phone.',
                '- No approach is on the table yet → propose() one. Be concrete: how it works, the',
                '  effort, the real risks. If somebody already proposed what you would have, score',
                '  theirs instead of restating it.',
                '- An open proposal you have not scored → weigh_in() with a feasibility score 1-5 and',
                '  the reason. Feasibility means buildable now, with what is actually available — not',
                '  elegant. Silence stalls the room, so score it even if you are indifferent.',
                '- Somebody objected to your proposal → answer the objection on its merits. If they',
                '  are right, say so and withdraw_proposal(), or change your own score. Being argued',
                '  out of a position is the mechanism working.',
                '- standing() says a route is ready → choose() it, or say why you disagree. Get to a',
                '  decision; an undecided room is the failure mode.',
                '- A route is chosen → refine_spec() to write up what was agreed, then plan() it into',
                '  tasks with roles and dependencies.',
                '- There is claimable work for you → claim_next(), do it, then update_task() with what',
                '  you changed and how to verify it. handoff() instead if you have to stop mid-task.',
                '',
                'Two standing rules:',
                '- Anything a future agent would need goes in decide(), remember() or handoff().',
                '  If it only exists in the chat, treat it as lost.',
                '- Argue with the plan, never the agent. Give the concrete failure case.',
                '',
                'The human wants viable options they can pick from, with the trade-offs stated, not a',
                'single answer handed down and not an endless discussion. Converge.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  return { server, who };
}
