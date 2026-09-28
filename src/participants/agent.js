import { describeRole } from '../roles.js';
import { chatAdapter } from './chat.js';

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
      name: 'save_artifact',
      description:
        'Write a document, a spec, a file of code or a page into the room as a real artifact, ' +
        'instead of pasting it into the chat where it gets buried. Pass an existing slug to revise ' +
        'one — every version is kept, so revising is safe and the previous text is never lost. ' +
        'Reach for this whenever the output is something somebody would want to open again later.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', description: 'Existing artifact to revise. Omit to create a new one.' },
          title: { type: 'string', description: 'Required when creating.' },
          content: { type: 'string', description: 'The whole document, not a patch.' },
          kind: { type: 'string', enum: ['markdown', 'code', 'html', 'text'] },
          language: { type: 'string', description: 'For code: the language, e.g. javascript.' },
          summary: { type: 'string', description: 'One line on what changed and why.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'read_artifact',
      description: 'Read an artifact in full. The brief lists what exists; this fetches one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string' },
          version: { type: 'integer', description: 'An older version. Omit for the current one.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'read_file',
      description:
        'Read a file somebody attached to this idea. The brief lists what is attached; this returns ' +
        'the text of one. Only text formats can be read — anything else you get as a link.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { filename: { type: 'string', description: 'As shown in the brief.' } },
        required: ['filename'],
      },
    },
    {
      name: 'generate_image',
      description:
        'Make an image and post it to the room. Use it when a picture carries the point better than ' +
        'a paragraph — a mockup, a diagram, a layout, a reference. Describe it fully; the generator ' +
        'sees only this text and nothing of the conversation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'What to draw, in full.' },
          caption: { type: 'string', description: 'One line on why you made it.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_video',
      description:
        'Make a short video and post it to the room. Slow and expensive, so reach for it only when ' +
        'motion is the point and a still would not do.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' },
          caption: { type: 'string' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_audio',
      description:
        'Speak something aloud in the room\'s voice and post it. For the moments where hearing it is ' +
        'the point — a line of narration, a spoken summary, a read-through of a script you are ' +
        'proposing. Write the words exactly as they should be said; nothing is added.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'The words to say, verbatim.' },
          caption: { type: 'string', description: 'One line on why you made it.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'web_search',
      description:
        'Search the web. Use it before asserting anything about the outside world you are not certain ' +
        'of — versions, limits, prices, whether something exists. An unchecked claim about the world ' +
        'is a guess in a confident voice.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      description:
        'Read one page as text. Follow a search result to the source rather than trusting a snippet.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    {
      name: 'check_claim',
      description:
        'Search what the room has already recorded about a claim — decisions, established facts, ' +
        'artifacts and history. Check here BEFORE looking outside: if the room settled it, that is ' +
        'the answer, and contradicting a recorded decision by accident is the worst failure available.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { claim: { type: 'string', description: 'The statement to check, in full.' } },
        required: ['claim'],
      },
    },
    {
      name: 'record_check',
      description:
        'Record that you checked a claim, and what it rests on. A supported or contradicted verdict ' +
        'requires a source — "I verified it" with nothing behind it is the failure you are meant to ' +
        'be catching. Use unverifiable honestly; absence of evidence is not a verdict either way.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['supported', 'unsupported', 'contradicted', 'unverifiable'] },
          source: { type: 'string', description: 'decision#3, fact:runtime, artifact:spec, or a URL.' },
          detail: { type: 'string', description: 'What you actually found.' },
          message: { type: 'integer', description: 'The message the claim came from, if you know it.' },
        },
        required: ['claim', 'verdict'],
      },
    },
    {
      name: 'use_plugin',
      description:
        'Call one of the tools the human has connected. list_plugins shows what exists and what each ' +
        'one expects.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          args: { type: 'object', additionalProperties: true, description: 'Whatever that plugin expects.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_plugins',
      description: 'What connected tools are available, and what each expects.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'use_skill',
      description:
        'Read one of the skills the room has been given and work the way it says. A skill is written ' +
        'instructions — a review checklist, a house style, a procedure — and it is the answer to "how ' +
        'is this done here". Read the relevant one before doing that kind of work, and follow it as ' +
        'written rather than approximating it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', description: 'The skill\'s name, as listed.' } },
        required: ['name'],
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
  // Re-read on every turn rather than captured, so a key or model changed on
  // the setup page takes effect without restarting the seat.
  resolve,
  log = (m) => process.stdout.write(`${m}\n`),
  // Injectable so the tool-dispatch path can be tested without a live key or a
  // network call. Production uses the real SDK client.
  createClient = null,
  // Supplied by the server: { image(prompt), video(prompt) } resolving to a URL.
  // Absent means the room has no such connection, and the tools say so.
  media = null,
  // { search(q), fetchPage(url) } — the web bridge, when one is configured.
  web = null,
  // The user's connected HTTP tools.
  plugins = null,
  // The room's skills. Named in the system prompt so a model knows what it can
  // reach for; read in full only when it asks for one.
  skills = null,
  // The human's standing instructions, read fresh so an edit takes effect on
  // the next turn rather than needing a restart.
  custom = () => ({ houseStyle: '', aboutMe: '' }),
}) {
  const name = seat?.name ?? 'model';
  const role = seat?.role ?? 'generalist';

  const configured = String(seat?.effort ?? 'high').toLowerCase();
  const effort = EFFORTS.includes(configured) ? configured : 'high';
  if (effort !== configured) {
    log(`${name}: "${configured}" is not a valid effort; using ${effort}`);
  }

  let stopped = false;

  /** The seat's live endpoint, model and credential. */
  const live = () => (resolve ? resolve(name) : null);
  const usable = () => {
    const r = live();
    return Boolean(r?.baseURL && r?.model && (r.apiKey || /(^|\/\/)(127\.0\.0\.1|localhost)/.test(r.baseURL)));
  };

  /** What this seat is running right now, for the roster and the system prompt. */
  const currentModel = () => live()?.model ?? seat?.model ?? '(unset)';

  const adapter = () => {
    const r = live();
    if (!r) throw new Error(`${name} has no connection — point it at one on the setup page`);
    if (!r.model) throw new Error(`${name} has no model set`);
    if (!usable()) throw new Error(`${name} has no API key for "${r.connection}" — add one on the setup page`);
    return chatAdapter({
      apiKey: r.apiKey,
      model: r.model,
      maxTokens: seat?.maxTokens ?? 64000,
      effort,
      effortParam: r.effortParam,
      baseURL: r.baseURL,
      createClient,
    });
  };

  function join() {
    return hub.join({
      name, role, kind: 'agent', model: currentModel(),
      capabilities: ['discusses', 'proposes', 'scores', 'plans'],
    });
  }

  const systemPrompt = () => {
    const charter = describeRole(hub.roles, role);
    const { houseStyle, aboutMe } = custom() ?? {};
    return [
      `You are "${name}", the ${role}, in a group chat with a human and several other AI models.`,
      `You are running on ${currentModel()}. The others may be different models from different`,
      `providers, with different strengths, and they will disagree with you.`,
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
      // Named, not pasted: the whole point of use_skill is that a model reads
      // the instructions when it needs them, so twelve skills do not cost twelve
      // pages of prompt on every turn.
      ...(() => {
        const menu = skills?.menu?.({ role }) ?? [];
        if (!menu.length) return [];
        return ['', '## Skills the human has written for this room',
                'Read one with use_skill before doing work it covers, and follow it as written.',
                ...menu.map((k) => `- ${k.name}: ${k.description || k.title}`)];
      })(),
      ...(aboutMe?.trim() ? ['', '## Who you are working for', aboutMe.trim()] : []),
      ...(houseStyle?.trim()
        ? ['', '## Standing instructions from the human', houseStyle.trim(),
           'These outrank your own preferences. They do not outrank a decision already recorded.']
        : []),
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
          // A tool that reports a failure rather than throwing one is still a
          // failure; counting it would make the log claim work that never happened.
          if (!String(out).startsWith('FAILED')) done.push(call.name);
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

      case 'save_artifact': {
        const a = hub.saveArtifact({
          slug: input.slug || null,
          title: input.title,
          content: String(input.content ?? ''),
          kind: input.kind || 'markdown',
          language: input.language || '',
          summary: input.summary || '',
          idea,
          by: name,
        });
        return { text: `saved artifact "${a.slug}" as v${a.version}`, ends: true };
      }

      case 'read_artifact': {
        const a = input.version
          ? hub.artifactVersion({ ref: input.slug, version: input.version })
          : hub.getArtifact(input.slug);
        // Returned as the tool result rather than posted, so reading a document
        // does not dump it into the chat for everyone.
        return { text: `# ${a.title} (v${a.version}, ${a.kind})\n\n${a.content}`, ends: false };
      }

      case 'read_file': {
        const want = String(input.filename ?? '').toLowerCase();
        const match = hub.attachments({ idea }).find((f) => f.filename.toLowerCase() === want)
          ?? hub.attachments({ idea }).find((f) => f.filename.toLowerCase().includes(want));
        if (!match) return { text: `FAILED: no file named "${input.filename}" is attached here`, ends: false };
        const full = hub.getAttachment(match.id);
        if (!full.text) return { text: `FAILED: ${full.filename} is not a text format; it is at ${full.url}`, ends: false };
        return { text: `# ${full.filename}\n\n${full.text.slice(0, 60_000)}`, ends: false };
      }

      case 'web_search': {
        if (!web?.available?.()) return { text: 'FAILED: no web search connection is configured in this room', ends: false };
        const hits = await web.search({ query: String(input.query ?? ''), limit: input.limit ?? 6 });
        if (!hits.length) return { text: 'No results. That is not evidence the thing is false.', ends: false };
        return {
          text: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n'),
          ends: false,
        };
      }

      case 'web_fetch': {
        if (!web) return { text: 'FAILED: the web bridge is not available', ends: false };
        const page = await web.fetchPage({ url: String(input.url ?? '') });
        return {
          text: `# ${page.title}\n${page.url}\n\n${page.text}${page.truncated ? '\n\n[…truncated]' : ''}`,
          ends: false,
        };
      }

      case 'check_claim': {
        const found = hub.lookUp({ claim: String(input.claim ?? ''), idea });
        const lines = [found.note, ''];
        for (const d of found.decisions) lines.push(`${d.ref}: ${d.choice}${d.rationale ? ` — ${d.rationale}` : ''}`);
        for (const f of found.facts) lines.push(`${f.ref} = ${f.value}`);
        for (const a of found.artifacts) lines.push(`${a.ref}: ${a.title}`);
        for (const m of found.said) lines.push(`${m.ref} ${m.author}: ${m.body}`);
        return { text: lines.join('\n'), ends: false };
      }

      case 'record_check': {
        const c = hub.recordCheck({
          messageId: input.message ?? null,
          claim: input.claim, verdict: input.verdict,
          source: input.source ?? '', detail: input.detail ?? '', by: name,
        });
        return { text: `recorded: "${c.claim.slice(0, 60)}" is ${c.verdict}${c.source ? ` (${c.source})` : ''}`, ends: false };
      }

      case 'list_plugins': {
        const list = plugins?.enabled?.() ?? [];
        if (!list.length) return { text: 'No plugins are connected.', ends: false };
        return {
          text: list.map((pl) => `- ${pl.name}: ${pl.description || '(no description)'}\n  expects ${JSON.stringify(pl.params)}`).join('\n'),
          ends: false,
        };
      }

      case 'use_plugin': {
        if (!plugins) return { text: 'FAILED: no plugins are connected', ends: false };
        const out = await plugins.call({ name: String(input.name ?? ''), args: input.args ?? {}, agent: name });
        return { text: String(out).slice(0, 20_000), ends: false };
      }

      case 'use_skill': {
        if (!skills) return { text: 'FAILED: this room has no skills loaded', ends: false };
        let skill;
        try {
          skill = skills.use(String(input.name ?? ''), { by: name });
        } catch (err) {
          return { text: `FAILED: ${err.message}`, ends: false };
        }
        // Handed over as written. The point of a skill is the author's own words;
        // a summary of them is a different instruction.
        const brought = skill.attached.map((f) => `\n\n--- ${f.path} ---\n${f.text.slice(0, 8000)}`).join('');
        return { text: `${skill.title}\n\n${skill.body}${brought}`, ends: false };
      }

      case 'generate_image':
      case 'generate_video':
      case 'generate_audio': {
        const what = tool.slice('generate_'.length);
        if (!media?.[what]) {
          return { text: `FAILED: no ${what} connection is configured in this room`, ends: false };
        }
        const url = await media[what](String(input.prompt ?? ''));
        // Posted as markdown so the feed renders it and the transcript still
        // reads sensibly anywhere that does not. Audio is a link rather than an
        // embed, because `![]()` on a sound file renders as a broken picture.
        const embed = what === 'audio' ? `[audio](${url})` : `![${what}](${url})`;
        await speak(
          `${input.caption?.trim() || input.prompt}\n\n${embed}`,
          { idea, urgency: replyUrgency },
        );
        return { text: `posted a generated ${what}`, ends: true };
      }

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
      log(`${name}: not configured yet; idle until its connection has a model and a key`);
    }
    join();
    const r = live();
    log(`${name} (${role}) joined on ${currentModel()}${r?.connection ? ` via ${r.connection}` : ''}`);

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
    name,
    role,
    get model() { return currentModel(); },
    get connection() { return live()?.connection ?? null; },
  };
}
