import { SEEN } from '../core.js';
import { describeRole } from '../roles.js';
import { chatAdapter, partialString } from './chat.js';
import { pageForModel } from '../browser.js';

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
const QUIET_AFTER_STOP_MS = 6000; // how long a stopped seat stays out of the way

/** How long to queue for the floor before giving up on this turn. */
const FLOOR_WAIT_MS = 30_000;

/** How much of a thread an agent is shown before it speaks, and how long one message may run. */
const THREAD_TAIL = 40;
const LINE_LIMIT = 1800;

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
          reply_to: {
            type: 'integer',
            description: 'The #number of the message you are answering, when it is one in particular — ' +
              'another agent\'s point you are building on or disagreeing with, or the question you were asked.',
          },
        },
        required: ['body'],
      },
    },
    {
      name: 'react',
      description:
        'Acknowledge a message with one emoji instead of words, and end your turn. Use it when you have ' +
        'read something and have nothing to add that has not been said: 👍 agreed, 👀 looking, ❓ unclear. ' +
        'It shows the room you got the message without making it read another paragraph.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'integer', description: 'The #number of the message.' },
          emoji: { type: 'string', description: 'One emoji.' },
        },
        required: ['message_id', 'emoji'],
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
      name: 'run_command',
      description:
        'Run one shell command in the project folder and get its output and exit code. The person ' +
        'in the room uses the same terminal and sees everything you run. Use it to look at the ' +
        'project, run its tests, or check a claim about the code by executing it — not to make ' +
        'changes nobody asked for.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'The command, exactly as you would type it.' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 },
        },
        required: ['command'],
      },
    },
    {
      name: 'browser_search',
      description:
        'Search the web in the shared browser — a real window on the person\'s screen, so they see ' +
        'the results you see — and read the results page.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' } }, required: ['query'],
      },
    },
    {
      name: 'browser_open',
      description: 'Open a web address in the shared browser and read the page.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string' } }, required: ['url'],
      },
    },
    {
      name: 'browser_read',
      description:
        'Read whatever page the shared browser is showing now. The person may have gone somewhere ' +
        'and want you to look at what they found.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'browser_act',
      description:
        'Act on the page the shared browser is showing: click something, or type into a field. Name the thing ' +
        'by the words on it. Only works on sites the person has allowed agents to write to; a refusal says how they can allow it.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['click', 'type'] },
          target: { type: 'string', description: 'The words on the button or link, or the label or placeholder of the field.' },
          text: { type: 'string', description: 'For type: what to put in the field.' },
          submit: { type: 'boolean', description: 'For type: submit the form afterwards.' },
        },
        required: ['action'],
      },
    },
    {
      name: 'use_app',
      description:
        'Use a program on the person\'s computer that they have allowed. Give a file from the project folder to open it in ' +
        'the program; if the program allows it, give args to run it with and get back what it printed.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { app: { type: 'string' }, file: { type: 'string' }, args: { type: 'string' } },
        required: ['app'],
      },
    },
    {
      name: 'open_idea',
      description:
        'Turn what is being discussed in the lobby into an idea of its own, so it can be proposed against, planned ' +
        'and built. Use it when lobby talk has become something to make. It creates the idea with your write-up as ' +
        'its starting text and ends your turn; the person then opens it and hands it over to be built.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'One line: what it is.' },
          summary: { type: 'string', description: 'What has been agreed so far: what is being built, what is not, the plan. This becomes the idea\'s text.' },
        },
        required: ['title', 'summary'],
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
/**
 * A tool call that came back written out as prose — `reply{body:<|"|>hi<|"|>,reply_to:26}`,
 * `reply({"body": "hi"})`, `<tool_call>{"name":"reply",…}` — read for what it meant.
 *
 * Gives { name, body, replyTo } when the text is such a call, with `body`
 * empty when there was nothing in it worth saying (a placeholder like
 * `brief()` is the model quoting its own instructions, not a message).
 * Gives null for ordinary prose, which is the usual case.
 */
export function leakedCall(text) {
  const raw = String(text ?? '').trim();
  // The quote tokens some models emit in place of quotation marks.
  const t = raw.replace(/<\|"\|>/g, '"').replace(/<\/?tool_call>|<\|tool_call(?:_begin|_end)?\|>|<\|python_tag\|>/g, '').trim();
  const NAMES = 'reply|react|say_nothing|ask|open_idea|more_tools|propose|weigh_in|answer|decide|choose|remember|run_command|browser_\\w+|web_\\w+|use_\\w+';
  let name = t.match(new RegExp(`^(?:functions?[.:])?(${NAMES})\\s*[({]`))?.[1]
    ?? t.match(new RegExp(`^\\{\\s*"(?:name|tool|function)"\\s*:\\s*"(${NAMES})"`))?.[1];
  if (!name) return null;
  // Only when the whole message is the call: prose that merely mentions reply(...) is prose.
  if (!/[})\]]\s*;?$/.test(t) || t.length > 6000) return null;
  const body = t.match(/["']?(?:body|text|message|content)["']?\s*[:=]\s*"((?:[^"\\]|\\.)*)"/s)?.[1]
    ?? t.match(/["']?(?:body|text|message|content)["']?\s*[:=]\s*'((?:[^'\\]|\\.)*)'/s)?.[1] ?? '';
  const replyTo = Number(t.match(/["']?reply_?to["']?\s*[:=]\s*"?(\d+)/i)?.[1]) || null;
  let said = body.replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
  // A bare call or a placeholder is not a message.
  if (/^[\w.]+\(\s*\)$/.test(said) || /^<[^>]*>$/.test(said) || said === '...' || said === '…') said = '';
  return { name, body: said, replyTo };
}

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
  // The project's shared terminal and browser. The person uses the same ones,
  // so everything done through them is on the record under this seat's name.
  terminal = null,
  browser = null,
  permissions = null,
}) {
  const name = seat?.name ?? 'model';
  const role = seat?.role ?? 'generalist';

  const configured = String(seat?.effort ?? 'high').toLowerCase();
  const effort = EFFORTS.includes(configured) ? configured : 'high';
  if (effort !== configured) {
    log(`${name}: "${configured}" is not a valid effort; using ${effort}`);
  }

  let stopped = false;
  /**
   * The turn in flight, if any.
   *
   * Held so that "stop" can reach it. A flag alone only takes effect between
   * round trips, and the wait somebody actually wants to end is the one in the
   * middle of a request — a model thinking for thirty seconds is exactly when
   * you realise you asked the wrong thing.
   */
  let inFlight = null;
  let interrupted = false;
  /**
   * What this seat is doing this second, for anybody watching: thinking,
   * writing (with the words so far), or using a tool. A turn that shows
   * nothing until it is finished looks the same as a turn that is stuck.
   */
  let doing = null;
  const watch = (d) => {
    if (!doing) return;
    doing.firstAt ??= Date.now();
    if (d.tool === 'reply') { doing.phase = 'writing'; doing.text = partialString(d.args, 'body'); doing.tool = null; }
    else if (d.tool) { doing.phase = 'working'; doing.tool = d.tool; doing.text = ''; }
    else if (d.text) { doing.phase = 'writing'; doing.text = d.text; doing.tool = null; }
    else if (d.thinking) doing.phase = 'thinking';
  };
  /** Set when somebody presses stop; the loop holds off until it passes. */
  let quietUntil = 0;

  /**
   * Stop this seat's current turn.
   *
   * Not the same as stop(): the seat stays in the room and answers the next
   * thing said to it. This only ends the turn it is in the middle of.
   */
  function interrupt() {
    interrupted = true;
    try { inFlight?.abort(); } catch { /* already finished */ }
    inFlight = null;
    // And stay out of the way for a moment. Without this the watch loop picks
    // up the next thing immediately and the seat is thinking again before the
    // button has finished animating, which reads as the stop having done
    // nothing at all.
    quietUntil = Date.now() + QUIET_AFTER_STOP_MS;
  }

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
      tokenParam: r.tokenParam,
      shape: r.shape,
      baseURL: r.baseURL,
      createClient,
      onDelta: watch,
    });
  };

  function join() {
    return hub.join({
      name, role, kind: 'agent', model: currentModel(),
      capabilities: ['discusses', 'proposes', 'scores', 'plans'],
    });
  }

  /**
   * The tools for one turn: only the ones that can work here, now.
   *
   * Every tool offered is a few hundred tokens the model reads before it says
   * a word, on every turn. Most of them usually cannot be used at all — there
   * is no idea to propose against in the lobby, no search connection, no
   * plugin, nothing to run a command in — and offering a tool that can only
   * answer "not configured" is slower and worse than not offering it.
   */
  function toolsFor(ideaSlug) {
    const off = new Set();
    if (!ideaSlug) for (const n of ['propose', 'weigh_in', 'choose', 'refine_spec', 'plan']) off.add(n);
    // Opening an idea is how you get out of the lobby; inside one there is nothing to open.
    else off.add('open_idea');
    if (!web) off.add('web_fetch');
    if (!web?.available?.()) off.add('web_search');
    if (!(plugins?.enabled?.() ?? []).length) { off.add('use_plugin'); off.add('list_plugins'); }
    if (!(skills?.menu?.({ role }) ?? []).length) off.add('use_skill');
    for (const kind of ['image', 'video', 'audio']) {
      if (!media?.[kind] || media.available?.(kind) === false) off.add(`generate_${kind}`);
    }
    let canRun = false;
    try { canRun = Boolean(terminal?.folder().ok && terminal.agentsAllowed()); } catch { /* no terminal */ }
    if (!canRun) off.add('run_command');
    let canBrowse = false;
    try { canBrowse = Boolean(browser && browser.status?.().installed !== false); } catch { /* no browser */ }
    if (!canBrowse || !browser.actOn) off.add('browser_act');
    if (!canBrowse) for (const n of ['browser_search', 'browser_open', 'browser_read']) off.add(n);
    // A program is only worth offering when the person has listed one.
    if (!(permissions?.appsFor?.() ?? []).length) off.add('use_app');
    return toolDefs().filter((t) => !off.has(t.name));
  }

  /**
   * The tools a turn starts with, and the rest in named groups.
   *
   * Every tool's description and schema is sent with every request, and a
   * model reads all of it before it writes a word — thirty tools is thousands
   * of tokens in front of "hello". Most turns are talk. So a turn starts with
   * the handful that talk needs, and one more that fetches a group of the
   * others when the work calls for it: a round trip for the turns that use
   * tools, and a fast first word for the ones that do not.
   */
  const GROUPS = {
    board: { what: 'proposals, objections, decisions, the spec and the plan', tools: ['propose', 'weigh_in', 'answer', 'decide', 'choose', 'refine_spec', 'remember', 'plan'] },
    pc: { what: 'run commands on the Agents\' PC, and use programs the person allowed', tools: ['run_command', 'use_app'] },
    web: { what: 'search, fetch and read the web, use the shared browser, check claims', tools: ['web_search', 'web_fetch', 'browser_search', 'browser_open', 'browser_read', 'browser_act', 'check_claim', 'record_check'] },
    files: { what: 'save and read artifacts and files', tools: ['save_artifact', 'read_artifact', 'read_file'] },
    make: { what: 'generate images, video and audio', tools: ['generate_image', 'generate_video', 'generate_audio'] },
    extend: { what: 'plugins and skills', tools: ['use_plugin', 'list_plugins', 'use_skill'] },
  };
  const CORE = new Set(['reply', 'react', 'ask', 'open_idea', 'say_nothing']);

  function leanTools(ideaSlug, loaded = new Set()) {
    const all = toolsFor(ideaSlug);
    const have = new Set(all.map((t) => t.name));
    // Inside an idea the board is the work, so it is there from the start.
    const open = new Set(ideaSlug ? ['board', ...loaded] : loaded);
    const wanted = new Set(CORE);
    for (const g of open) for (const n of GROUPS[g]?.tools ?? []) wanted.add(n);
    const rest = Object.entries(GROUPS).filter(([g, def]) => !open.has(g) && def.tools.some((n) => have.has(n)));
    const tools = all.filter((t) => wanted.has(t.name));
    if (rest.length) {
      tools.push({
        name: 'more_tools',
        description: `Get more tools for this turn. Call it first when the turn needs them, then use them. Groups: ${rest.map(([g, def]) => `${g} — ${def.what}`).join('; ')}.`,
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { group: { type: 'string', enum: rest.map(([g]) => g) } },
          required: ['group'],
        },
      });
    }
    return tools;
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
      `- The agents answer one after another, in the order they joined. Everything said so far is in`,
      `  front of you with a #number on each message, including what the agents before you just said.`,
      `  Read it before you speak: build on it or disagree with it by name, and pass reply_to with the`,
      `  #number when you are answering one message in particular.`,
      `- If somebody already made your point, do not restate it: react to their message instead. A room`,
      `  where every agent repeats the same observation is worse than a quiet one, and a reaction still`,
      `  shows you read it.`,
      `- When the human addresses you by name, they want your answer. Reply; do not stay silent.`,
      `- The lobby is for talk. Proposals, plans and builds belong to an idea. When lobby talk has become`,
      `  something to make, call open_idea with what was agreed, rather than writing the plan out as a`,
      `  chat message that nothing can act on.`,
      `- You cannot start a build, and neither can any agent. A build starts when the human hands an idea`,
      `  over; the coordinator then cuts it into threads. Never say you are "starting a thread" or doing`,
      `  work the room has not started — say what should be handed over, and wait.`,
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
      'You start each turn with only the tools for talking. Anything else — running commands, the web and the browser, files,',
      'images, the board, plugins — is one call away: more_tools with the group you need, then use what it gives you.',
      'Do not say you cannot do something before looking there.',
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
  /**
   * One turn, with the seat marked as mid-turn for as long as it lasts.
   *
   * The flag has to be cleared on every way out — an answer, a refusal, a
   * thrown provider error, a stop — or the seat looks busy forever and the
   * stop button never goes away.
   */
  async function think(args) {
    // "waiting" until the provider sends its first byte. It is a different
    // thing from thinking, and most of a long wait is usually this one.
    doing = { since: Date.now(), phase: 'waiting', text: '', tool: null, model: currentModel(), firstAt: null };
    const mine = doing;
    try {
      const result = await runTurn(args);
      // How long it took, and how long before anything came back: the two
      // numbers that say whether a slow turn was the provider or the answer.
      return { ...result, ms: Date.now() - mine.since, firstMs: mine.firstAt ? mine.firstAt - mine.since : null };
    } finally {
      inFlight = null;
      doing = null;
    }
  }

  async function runTurn({ trigger, ideaSlug, replyUrgency = 'comment' }) {
    // The brief carries what is settled; the thread below carries what was
    // said. The brief's own tail is left out so the conversation is in the
    // context once, in full, rather than twice with one copy cut short.
    const brief = ideaSlug ? hub.brief({ idea: ideaSlug, messages: 0, by: name }) : null;
    const said = hub.recent({ idea: ideaSlug ?? null, limit: THREAD_TAIL });
    // Read first, so the count of things waiting does not include the very
    // messages printed underneath it.
    markRead(ideaSlug);
    const catchUp = hub.catchUp({ name });

    const context = [
      brief ? brief.digest : '(No idea selected — this is the lobby, the room\'s general chat.)',
      '',
      '---',
      '',
      `## The conversation in this thread (oldest first — you are "${name}")`,
      said.length ? said.map(threadLine).join('\n') : '(nothing has been said here yet)',
      '',
      '## What is waiting on you',
      ...catchUp.nudges.map((n) => `- ${n}`),
      '',
      '## What just happened',
      trigger,
    ].join('\n');

    // The receipt goes down when the messages go in front of the model: the
    // tick on the page means "this was in its context", whatever it says next.
    try { hub.acknowledge({ by: name, messages: said.map((m) => m.id) }); } catch { /* a receipt must not cost the turn */ }

    const loaded = new Set();
    const turn = adapter().startTurn({ system: systemPrompt(), tools: leanTools(ideaSlug, loaded) });
    inFlight = turn;
    interrupted = false;
    const done = [];

    // Requests are counted rather than loop iterations: the first one happens
    // before the loop, so iterating MAX_TURNS times would spend MAX_TURNS + 1.
    let requests = 1;
    let step;
    try {
      step = await turn.send(context);
    } catch (err) {
      if (err.interrupted) return { actions: done, interrupted: true };
      throw err;
    }

    for (;;) {
      if (interrupted) return { actions: done, interrupted: true };
      if (step.stopReason === 'refusal') return { actions: done, refused: true };
      if (step.stopReason === 'max_tokens') return { actions: done, truncated: true };

      if (!step.toolCalls.length) {
        // It answered in prose without calling reply. Post that rather than
        // dropping it on the floor.
        if (step.text) {
          // Some models write the tool call out as text instead of making it.
          // That text is machinery, not something to say: what it meant to say
          // is recovered and said, and the wrapping never reaches the room.
          const leak = leakedCall(step.text);
          if (leak?.name === 'reply' && leak.body) {
            await speak(leak.body, { idea: ideaSlug, urgency: replyUrgency, ...(leak.replyTo ? { replyTo: leak.replyTo } : {}) });
            done.push('reply');
          } else if (leak) {
            log(`${name}: wrote a ${leak.name} call out as text with nothing sayable in it — not posted`);
            return { actions: done, garbled: true };
          } else {
            await speak(step.text, { idea: ideaSlug, urgency: replyUrgency });
            done.push('reply');
          }
        }
        return { actions: done };
      }

      const results = [];
      let finished = false;
      let fetched = false;
      for (const call of step.toolCalls) {
        let out;
        if (call.name === 'more_tools') {
          // Not work, and not a turn spent: it is the model reaching for its toolbox.
          const group = String(call.input?.group ?? '');
          if (GROUPS[group]) {
            loaded.add(group);
            const now = leanTools(ideaSlug, loaded);
            turn.setTools?.(now);
            fetched = true;
            out = `You now have: ${now.map((t) => t.name).filter((n) => GROUPS[group].tools.includes(n)).join(', ') || 'nothing more — none of that group is set up in this room'}. Use them now.`;
          } else out = `FAILED: there is no group called ${group}`;
          results.push({ id: call.id, name: call.name, output: out });
          continue;
        }
        try {
          if (doing && call.name !== 'reply') { doing.phase = 'working'; doing.tool = call.name; doing.text = ''; }
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
      if (interrupted) return { actions: done, interrupted: true };
      // Fetching tools does not count against the turn's allowance of round trips.
      if (fetched && !done.length) requests--;
      if (requests >= MAX_TURNS) return { actions: done, exhausted: true };
      try {
        step = await turn.toolResults(results);
      } catch (err) {
        if (err.interrupted) return { actions: done, interrupted: true };
        throw err;
      }
      requests++;
    }
  }

  /** One message of the thread, as the model reads it. */
  function threadLine(m) {
    const who = m.author === name ? `${m.author} (you)` : m.authorKind === 'human' ? `${m.author} (the human)` : m.author;
    const kind = m.kind !== 'message' ? ` [${m.kind}]` : '';
    const to = m.replyTo ? ` replying to #${m.replyTo}` : '';
    const marks = (m.reactions ?? []).filter((r) => r.emoji !== SEEN)
      .map((r) => `${r.emoji} ${r.by.join(', ')}`).join(' · ');
    const body = m.body.length > LINE_LIMIT ? `${m.body.slice(0, LINE_LIMIT)}… (cut)` : m.body;
    return `#${m.id} ${who}${kind}${to}: ${body}${marks ? `\n    reactions: ${marks}` : ''}`;
  }

  /** Everything up to now counts as read, in this thread and among the mentions. */
  function markRead(ideaSlug) {
    try {
      hub.read({ by: name, limit: 500 });
      hub.read({ by: name, mentioningMe: true, limit: 500 });
      if (ideaSlug) hub.read({ by: name, idea: ideaSlug, limit: 500 });
    } catch { /* being behind on reading is not a reason to stay silent */ }
  }

  /**
   * Post as this participant, queueing for the floor like any other agent.
   *
   * It waits rather than failing fast: another agent holding the floor for a
   * few seconds is completely normal, and dropping the reply over that would
   * make direct questions fail on timing alone.
   */
  async function speak(body, { urgency = 'comment', idea, replyTo = null } = {}) {
    hub.requestFloor({ by: name, urgency, reason: 'replying', idea: idea ?? null });
    const f = await hub.waitForTurn({ by: name, timeoutMs: FLOOR_WAIT_MS });
    if (!f.yours) {
      // Leave the queue so a long wait does not hold up everyone behind us.
      hub.yieldFloor({ by: name });
      throw new Error(`${f.holder?.agent ?? 'another agent'} still has the floor after waiting`);
    }
    try {
      return hub.post({ idea: idea ?? null, body, by: name, kind: 'message', replyTo });
    } catch (err) {
      // A #number that does not exist is the model's slip, not a reason to
      // lose what it wrote. The floor is still ours: say it unthreaded.
      if (replyTo === null || !/to reply to/.test(err.message)) throw err;
      return hub.post({ idea: idea ?? null, body, by: name, kind: 'message' });
    }
  }

  /** Map a tool call onto the Hub. `ends` marks the calls that finish a turn. */
  async function act(tool, input, { ideaSlug, replyUrgency = 'comment' }) {
    const idea = ideaSlug ?? null;
    switch (tool) {
      case 'reply':
        // A reply to something aimed at this participant is an answer, which
        // outranks general chatter in the queue.
        await speak(String(input.body ?? '').trim(), {
          idea, urgency: replyUrgency,
          replyTo: Number.isInteger(Number(input.reply_to)) && Number(input.reply_to) > 0 ? Number(input.reply_to) : null,
        });
        return { text: 'posted', ends: true };

      case 'react': {
        const r = hub.react({ message: input.message_id, by: name, emoji: input.emoji });
        return { text: `reacted ${r.emoji} to #${r.message}`, ends: true };
      }

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

      case 'run_command': {
        if (!terminal) return { text: 'FAILED: this room has no terminal', ends: false };
        try {
          const r = await terminal.run({
            command: input.command, by: name, kind: 'agent',
            ...(input.timeout_seconds ? { timeoutMs: Number(input.timeout_seconds) * 1000 } : {}),
          });
          const head = `exit ${r.exitCode}${r.timedOut ? ' (stopped: it ran too long)' : ''}`;
          return { text: `${head}\n${r.output || '(no output)'}`.slice(0, 12_000), ends: false };
        } catch (err) {
          return { text: `FAILED: ${err.message}`, ends: false };
        }
      }

      case 'browser_search':
      case 'browser_open':
      case 'browser_read': {
        if (!browser) return { text: 'FAILED: this room has no browser', ends: false };
        try {
          const page = tool === 'browser_search' ? await browser.search({ query: input.query, by: name, kind: 'agent' })
            : tool === 'browser_open' ? await browser.open({ url: input.url, by: name, kind: 'agent' })
            : await browser.read();
          return { text: pageForModel(page), ends: false };
        } catch (err) {
          return { text: `FAILED: ${err.message}`, ends: false };
        }
      }

      case 'browser_act': {
        if (!browser?.actOn) return { text: 'FAILED: this room has no browser to act on', ends: false };
        try {
          const r = await browser.actOn({ action: input.action, target: input.target, text: input.text, submit: input.submit });
          return { text: `${r.did}\n\n${pageForModel(r.page)}`, ends: false };
        } catch (err) {
          return { text: `FAILED: ${err.message}`, ends: false };
        }
      }

      case 'use_app': {
        if (!permissions) return { text: 'FAILED: no programs are available here', ends: false };
        try {
          const r = await permissions.useApp({ name: input.app, file: input.file, args: input.args, by: name });
          return { text: r.output.slice(0, 12_000), ends: false };
        } catch (err) {
          return { text: `FAILED: ${err.message}`, ends: false };
        }
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

      case 'open_idea': {
        if (idea) return { text: 'FAILED: this is already an idea — work in it', ends: false };
        const made = hub.dropIdea({ title: String(input.title ?? '').trim(), raw: String(input.summary ?? '').trim(), by: name });
        // Said in the lobby, where the conversation was, so nobody has to notice a new line in the rail.
        await speak(
          `I have opened this as an idea: **${made.title}**. It is in the list on the left — open it to carry on there, `
          + 'and use "Hand over to build" when it is what you want built.',
          { idea: null, urgency: replyUrgency },
        );
        return { text: `opened the idea "${made.slug}"`, ends: true };
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
   * Take a seat in the room.
   *
   * It used to watch for its own name here and answer whenever it saw it. That
   * made every seat its own scheduler: nobody answered a message that named
   * nobody, two seats named together answered over each other, and none of
   * them could tell that a conversation was somebody else's. Who speaks, and
   * in what order, is now decided in one place — the rounds — and a seat
   * speaks when it is given a turn.
   */
  async function run() {
    join();
    const r = live();
    log(usable()
      ? `${name} (${role}) joined on ${currentModel()}${r?.connection ? ` via ${r.connection}` : ''}`
      : `${name}: not configured yet; it has a seat but no connection with a model and a key`);
  }

  /**
   * One turn, given by whoever is keeping order.
   *
   * `direct` is true when the human named this seat: then the reply is an
   * answer somebody is waiting on, and it goes ahead of general chatter.
   */
  async function takeTurn({ trigger, idea = null, direct = false }) {
    if (stopped) return { actions: [], stopped: true };
    if (Date.now() < quietUntil) await sleep(quietUntil - Date.now());
    join();
    return think({ trigger, ideaSlug: idea, replyUrgency: direct ? 'answer' : 'comment' });
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
    stop: () => { stopped = true; interrupt(); },
    /** End whatever this seat is doing now, without taking it out of the room. */
    interrupt,
    get busy() { return Boolean(inFlight) && !inFlight.aborted; },
    /** What it is doing right now, or null when it is doing nothing. */
    get live() { return doing ? { ...doing } : null; },
    askDirect,
    takeTurn,
    get usable() { return usable(); },
    join,
    name,
    role,
    get model() { return currentModel(); },
    get connection() { return live()?.connection ?? null; },
  };
}
