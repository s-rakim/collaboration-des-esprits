import { describeRole } from '../roles.js';
import { providerFor } from './providers/index.js';

/**
 * One model's seat in the room, on whichever provider that seat uses.
 *
 * This is the only part of the project that calls a model, and it is a thin
 * agent: it watches the room, waits its turn like everyone else, and acts
 * through the same Hub methods the external agents use — no privileged path.
 *
 * Everything it knows about a project comes from brief(), the same call a cold
 * external agent makes. That is deliberate: if a built-in participant needed
 * more context than the connector hands out, the connector would be the thing
 * that is wrong.
 *
 * Provider differences live entirely in the adapters. This file never mentions
 * a vendor, which is what lets one room hold models from several of them.
 */

const MAX_TURNS = 6; // tool-use round trips per wake, so one reply cannot loop forever

/** How long to queue for the floor before giving up on this turn. */
const FLOOR_WAIT_MS = 30_000;

/** The actions a model may take. Deliberately a subset: talking and deciding, not building. */
function toolDefs() {
  return [
    {
      name: 'reply',
      description:
        'Say something in the room. This is how you answer the human and talk to the other agents. ' +
        'Use it once you have said everything you mean to; it ends your turn.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          body: { type: 'string', description: 'What you want to say. Plain text. @mention an agent to address it.' },
        },
        required: ['body'],
      },
    },
    {
      name: 'propose',
      description:
        'Put an approach on the table for the room to score. Use this when there is more than one sane ' +
        'way to do the work, instead of just asserting one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short name for the route.' },
          approach: { type: 'string', description: 'How it works, concretely enough to argue with.' },
          effort: { type: 'string' },
          risks: { type: 'string' },
          prerequisites: { type: 'string' },
          topic: { type: 'string', description: 'What is being decided. Defaults to "approach".' },
        },
        required: ['title', 'approach'],
      },
    },
    {
      name: 'weigh_in',
      description:
        "Score another agent's open proposal. Feasibility is 1-5 and means buildable now, with what is " +
        'actually available — not elegant. An objection must name the concrete failure case.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposal: { type: 'integer' },
          stance: { type: 'string', enum: ['endorse', 'object', 'neutral'] },
          feasibility: { type: 'integer', minimum: 1, maximum: 5 },
          reasoning: { type: 'string' },
          blocking: { type: 'boolean', description: 'Only for an objection, and only for a real breakage.' },
        },
        required: ['proposal', 'stance', 'reasoning'],
      },
    },
    {
      name: 'ask',
      description:
        'Ask the human something you genuinely cannot proceed without. Do not use this for anything a ' +
        'decision or a fact in the brief already answers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          body: { type: 'string' },
          blocking: { type: 'boolean', description: 'Does this actually stop progress?' },
        },
        required: ['body'],
      },
    },
    {
      name: 'answer',
      description: 'Answer an open question that was addressed to you by name.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'integer' }, answer: { type: 'string' } },
        required: ['id', 'answer'],
      },
    },
    {
      name: 'decide',
      description:
        'Record a binding decision with its reasoning, so no later agent re-argues it blind. Prefer ' +
        'choose() when the decision is between proposals on the table.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          choice: { type: 'string' },
          rationale: { type: 'string' },
          alternatives: { type: 'string' },
        },
        required: ['choice', 'rationale'],
      },
    },
    {
      name: 'choose',
      description: 'Settle a contest by picking a proposal. Refused while an unanswered blocking objection stands.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { proposal: { type: 'integer' }, rationale: { type: 'string' } },
        required: ['proposal', 'rationale'],
      },
    },
    {
      name: 'refine_spec',
      description: 'Write or revise the spec after a route has been chosen. Send the whole spec, not a patch.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { spec: { type: 'string' }, summary: { type: 'string' } },
        required: ['spec'],
      },
    },
    {
      name: 'remember',
      description: 'Store a durable fact every agent should know — a version constraint, an API limit, a convention.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' } },
        required: ['key', 'value'],
      },
    },
    {
      name: 'plan',
      description: 'Cut a settled spec into ordered tasks. dependsOn refers to positions in this same list.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
                role: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'integer' } },
              },
              required: ['title'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'say_nothing',
      description:
        'End your turn without speaking. Use this when the room does not need you — somebody already ' +
        'made your point, or the conversation is not yours. Staying quiet is a valid contribution.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { why: { type: 'string' } },
        required: [],
      },
    },
  ];
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * `seat` is {name, provider, model, role, effort, maxTokens, baseURL}.
 * `getKey()` returns that seat's own credential — each seat has its own, because
 * the seats are on different providers.
 *
 * Several of these run side by side in one process, one per model in the chat.
 * That is what makes the room "you and your different models" rather than you
 * and one assistant.
 */
export function createModelParticipant({
  hub,
  seat,
  getKey,
  log = (m) => process.stdout.write(`${m}\n`),
  // Injectable so the tool-dispatch path can be tested without a live key or a
  // network call. Production uses each provider's real SDK client.
  createClient = null,
}) {
  const name = seat?.name ?? 'model';
  const role = seat?.role ?? 'generalist';
  const model = seat?.model ?? 'gpt-5.2';
  const providerId = seat?.provider ?? 'openai';
  const provider = providerFor(providerId);
  const maxTokens = Number.isFinite(seat?.maxTokens) ? seat.maxTokens : 64000;
  const baseURL = seat?.baseURL || provider.baseURL || undefined;

  // A typo would otherwise surface as an opaque 400 on every wake. Fall back to
  // the documented default instead.
  const configured = String(seat?.effort ?? 'high').toLowerCase();
  const effort = EFFORTS.includes(configured) ? configured : 'high';
  if (effort !== configured) {
    log(`${name}: "${configured}" is not a valid effort; using ${effort}`);
  }

  let stopped = false;

  const apiKey = () => (getKey ? getKey(name) : null);
  const usable = () => Boolean(apiKey()) || Boolean(provider.keyOptional);

  /**
   * Built per turn so a key changed on the setup page takes effect without a
   * restart, and so each seat holds its own client rather than a shared one.
   */
  const adapter = () => {
    if (!usable()) {
      throw new Error(`no API key for ${name} (${provider.label}) — add one on the setup page`);
    }
    return provider.adapter({
      apiKey: apiKey(), model, maxTokens, effort,
      effortParam: provider.effortParam, baseURL, createClient,
    });
  };

  function join() {
    return hub.join({
      name, role, kind: 'agent', model,
      capabilities: ['discusses', 'proposes', 'scores', 'plans'],
    });
  }

  const systemPrompt = () => {
    const charter = describeRole(hub.roles, role);
    return [
      `You are "${name}", the ${role}, in a group chat with a human and several other AI models.`,
      `You are running on ${model}. The others may be different models with different strengths, and`,
      `they will disagree with you.`,
      `The human drops half-formed ideas; the room refines them into something buildable and then builds it.`,
      '',
      `## Your charter`,
      charter.summary,
      charter.charter,
      '',
      `## House rules`,
      ...charter.houseRules.map((r) => `- ${r}`),
      '',
      `## How to behave here`,
      `- You are one voice among several, not the assistant. Other agents will disagree with you, and`,
      `  being argued out of a position is the mechanism working, not a loss.`,
      `- The human reads this on their phone. Be brief and concrete. No preamble, no restating the`,
      `  question back, no bulleted summary of what you are about to say.`,
      `- Everything in the brief is already settled. Do not re-open it, and do not ask about anything it`,
      `  already answers.`,
      `- When there is more than one sane approach, propose one rather than asserting it. When somebody`,
      `  else has an open proposal, score it — an unscored proposal cannot be chosen, so silence blocks`,
      `  the room.`,
      `- If somebody already made your point, say_nothing. A room where every agent restates the same`,
      `  observation is worse than a quiet one.`,
      '',
      `Take exactly one action per turn and then stop. End with reply or say_nothing.`,
    ].join('\n');
  };

  /**
   * Run the tool loop for one wake. Returns what it did, for the log.
   *
   * The adapter owns the provider conversation, so this loop is the same whether
   * the seat is on OpenAI, Gemini, OpenRouter or something local.
   */
  async function think({ trigger, ideaSlug, replyUrgency = 'comment' }) {
    const brief = ideaSlug ? hub.brief({ idea: ideaSlug, messages: 30, by: name }) : null;
    const catchUp = hub.catchUp({ name });

    const context = [
      brief ? brief.digest : '(No idea selected — this is the lobby.)',
      '',
      '---',
      '',
      '## What is waiting on you',
      ...catchUp.nudges.map((n) => `- ${n}`),
      '',
      '## What just happened',
      trigger,
    ].join('\n');

    const turn = adapter().startTurn({ system: systemPrompt(), tools: toolDefs() });
    const done = [];

    // Requests are counted rather than loop iterations: the first one happens
    // before the loop, so iterating MAX_TURNS times would spend MAX_TURNS + 1.
    let requests = 1;
    let step = await turn.send(context);

    for (;;) {
      if (step.stopReason === 'refusal') return { actions: done, refused: true };
      if (step.stopReason === 'max_tokens') return { actions: done, truncated: true };

      if (!step.toolCalls.length) {
        // It answered in prose without calling reply. Post that rather than
        // dropping it on the floor.
        if (step.text) {
          await speak(step.text, { idea: ideaSlug, urgency: replyUrgency });
          done.push('reply');
        }
        return { actions: done };
      }

      const results = [];
      let finished = false;
      for (const call of step.toolCalls) {
        let out;
        try {
          const r = await act(call.name, call.input ?? {}, { ideaSlug, replyUrgency });
          out = r.text;
          if (r.ends) finished = true;
          done.push(call.name);
        } catch (err) {
          // Hand the failure back so it can correct itself — the Hub's errors
          // are written to be actionable ("resolve it, or have the human choose").
          out = `FAILED: ${err.message}`;
        }
        results.push({ id: call.id, name: call.name, output: out });
      }

      if (finished) return { actions: done };
      if (requests >= MAX_TURNS) return { actions: done, exhausted: true };
      step = await turn.toolResults(results);
      requests++;
    }
  }

  /**
   * Post as this participant, queueing for the floor like any other agent.
   *
   * It waits rather than failing fast: another agent holding the floor for a
   * few seconds is completely normal, and dropping the reply over that would
   * make direct questions fail on timing alone.
   */
  async function speak(body, { urgency = 'comment', idea } = {}) {
    hub.requestFloor({ by: name, urgency, reason: 'replying', idea: idea ?? null });
    const f = await hub.waitForTurn({ by: name, timeoutMs: FLOOR_WAIT_MS });
    if (!f.yours) {
      // Leave the queue so a long wait does not hold up everyone behind us.
      hub.yieldFloor({ by: name });
      throw new Error(`${f.holder?.agent ?? 'another agent'} still has the floor after waiting`);
    }
    return hub.post({ idea: idea ?? null, body, by: name, kind: 'message' });
  }

  /** Map a tool call onto the Hub. `ends` marks the calls that finish a turn. */
  async function act(tool, input, { ideaSlug, replyUrgency = 'comment' }) {
    const idea = ideaSlug ?? null;
    switch (tool) {
      case 'reply':
        // A reply to something aimed at this participant is an answer, which
        // outranks general chatter in the queue.
        await speak(String(input.body ?? '').trim(), { idea, urgency: replyUrgency });
        return { text: 'posted', ends: true };

      case 'say_nothing':
        return { text: 'stayed quiet', ends: true };

      case 'propose': {
        if (!idea) return { text: 'FAILED: a proposal needs an idea; this is the lobby', ends: false };
        const p = hub.propose({
          idea, by: name, title: input.title, approach: input.approach,
          topic: input.topic || 'approach', effort: input.effort ?? '',
          risks: input.risks ?? '', prerequisites: input.prerequisites ?? '',
        });
        return { text: `proposed P#${p.id}`, ends: true };
      }

      case 'weigh_in': {
        const p = hub.weighIn({
          proposal: input.proposal, stance: input.stance, feasibility: input.feasibility ?? null,
          reasoning: input.reasoning ?? '', blocking: Boolean(input.blocking), by: name,
        });
        return { text: `scored P#${p.id}; support ${p.support}, choosable ${p.choosable}`, ends: false };
      }

      case 'ask': {
        const q = hub.ask({ idea, body: input.body, by: name, audience: 'human', blocking: input.blocking !== false });
        return { text: `asked Q#${q.id}`, ends: true };
      }

      case 'answer': {
        const a = hub.answer({ id: input.id, answer: input.answer, by: name });
        return { text: `answered Q#${a.id}`, ends: true };
      }

      case 'decide': {
        const d = hub.decide({
          idea, choice: input.choice, rationale: input.rationale ?? '',
          alternatives: input.alternatives ?? '', by: name,
        });
        return { text: `recorded decision #${d.id}`, ends: false };
      }

      case 'choose': {
        const r = hub.choose({ proposal: input.proposal, rationale: input.rationale ?? '', by: name });
        return { text: `chose P#${r.proposal.id}, decision #${r.decision.id}`, ends: false };
      }

      case 'refine_spec': {
        if (!idea) return { text: 'FAILED: no idea selected', ends: false };
        const r = hub.refine({ ref: idea, spec: input.spec, summary: input.summary ?? '', by: name });
        return { text: `spec is now rev ${r.rev}`, ends: false };
      }

      case 'remember': {
        const f = hub.remember({ idea, key: input.key, value: input.value, source: input.source ?? '', by: name });
        return { text: `remembered ${f.key}`, ends: false };
      }

      case 'plan': {
        if (!idea) return { text: 'FAILED: no idea selected', ends: false };
        const created = hub.plan({ idea, tasks: input.tasks, by: name });
        return { text: `planned ${created.length} task(s)`, ends: false };
      }

      default:
        return { text: `FAILED: unknown tool ${tool}`, ends: false };
    }
  }

  /**
   * The watch loop. Wakes on anything addressed to this participant, plus
   * proposals it owes a score, then takes exactly one action.
   */
  async function run() {
    if (!usable()) {
      log(`${name}: no API key yet; idle until one is added on the setup page`);
    }
    join();
    log(`${name} (${role}) joined on ${model} via ${provider.label}`);

    let backoff = 5000;
    while (!stopped) {
      try {
        if (!usable()) {
          await sleep(3000);
          continue;
        }

        const woke = await hub.waitFor({ by: name, mentioningMe: true, timeoutMs: 20000 });
        const owed = hub.catchUp({ name }).proposalsAwaitingMyScore;

        let trigger = null;
        let ideaSlug = null;
        if (woke.messages.length) {
          const relevant = woke.messages.filter((m) => m.author !== name);
          if (relevant.length) {
            trigger = relevant.map((m) => `${m.author} (${m.kind}): ${m.body}`).join('\n\n');
            ideaSlug = relevant.findLast((m) => m.idea)?.idea ?? null;
          }
        } else if (owed.length) {
          const p = owed[0];
          trigger = `Proposal P#${p.id} "${p.title}" by ${p.author} is open and you have not scored it. The room cannot choose a route until you do.`;
          ideaSlug = p.idea;
        }

        if (!trigger) continue;

        const result = await think({
          trigger,
          ideaSlug,
          // Woken by a mention means somebody is waiting on us; an owed
          // proposal score is ordinary business.
          replyUrgency: woke.messages.length ? 'answer' : 'comment',
        });
        if (result.refused) log(`${name}: declined by safety classifiers; skipping this wake`);
        else if (result.truncated) log(`${name}: response hit max_tokens`);
        else log(`${name}: ${result.actions.join(', ') || 'no action'}`);
        backoff = 5000;
      } catch (err) {
        if (stopped) break;
        log(`${name}: ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
        // Always drop the floor on the way out; holding it through a backoff
        // would stall every other agent for as long as the error persists.
        try { hub.yieldFloor({ by: name }); } catch { /* not queued */ }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 120000);
      }
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * One-shot: used by the chat page's direct-ask path, where the
   * human wants an answer now rather than whenever the watch loop gets to it.
   */
  async function askDirect({ body, idea = null, from }) {
    join();
    const trigger = `${from} asked you directly:\n\n${body}`;
    return think({ trigger, ideaSlug: idea, replyUrgency: 'answer' });
  }

  return {
    run,
    stop: () => { stopped = true; },
    askDirect,
    join,
    name, role, model, provider: providerId,
  };
}
