/**
 * Who speaks next.
 *
 * Every seat used to watch the room for its own name and answer when it saw
 * it. Three things followed from that, and all three were reported as "the
 * agents ignore me". A message that named nobody was answered by nobody. A
 * name typed with the wrong capital reached nobody. And each agent, woken on
 * its own, saw the line aimed at it and not what the others had said around
 * it — so two of them would answer the same thing past each other.
 *
 * So the order is kept in one place, and it is the order of a conversation:
 *
 *  - Say something to the room and every agent answers, one after another.
 *    Each one is shown the thread first, including what the agents before it
 *    just said, so the third answer can be about the first two.
 *  - Name an agent and only that agent answers. It stays that way — a
 *    one-to-one, with everybody else holding — for as long as the person keeps
 *    talking to it.
 *  - The coordinator decides when that exchange is over, and opens the floor.
 *    Only then do the others speak, with the whole exchange in front of them.
 *
 * The order is the order the keys were added, unless the person sets another
 * or hands the choice to the coordinator. The coordinator is either a seat the
 * person picked, with its own key, or the automation here — plain rules, no
 * model, nothing to pay for.
 */

import { chatAdapter } from './participants/chat.js';

/** The name the automation speaks under when no seat has been made coordinator. */
export const BOT = 'coordinator-bot';

export const ORDER_MODES = ['added', 'custom', 'coordinator'];

/** How many times agents may hand the conversation to each other before a person has to say something. */
const MAX_HOPS = 6;

/** Human messages that are talk. A recorded decision or a status line is not an invitation to reply. */
const SPOKEN = new Set(['message', 'question', 'critique', 'answer']);

/**
 * The automation's rule for "that exchange is over": the person said so.
 *
 * Deliberately narrow. A short message that is only thanks or sign-off closes
 * it; anything with a question in it, or with more to it than that, is the
 * conversation carrying on.
 */
export function closesExchange(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/[.!…\s]+$/g, '');
  if (!t || t.length > 60 || t.includes('?')) return false;
  return /^(?:ok(?:ay)?[, ]*|alright[, ]*|great[, ]*|perfect[, ]*|cool[, ]*|nice[, ]*)*(?:thanks?(?: you)?(?: a lot| so much)?|thx|ty|cheers|got it|understood|makes sense|that'?s (?:all|it|everything)|that is (?:all|it)|done|we'?re done|all good|good(?: enough)?|sounds good|perfect|great|noted|open the floor|carry on|go ahead|over to (?:the )?(?:others|everyone|you all))(?:[, ]+(?:thanks?(?: you)?|that'?s all|for now|everyone|all))*$/.test(t);
}

const JUDGE = [
  'You are the coordinator of a group chat between one person and several AI agents.',
  'The person has been talking to one agent by name. While they do, the other agents hold.',
  'Decide whether that one-to-one exchange is finished.',
  '',
  'It is finished when the agent has answered what was asked and the person has nothing',
  'pending with it — they acknowledged the answer, or it plainly needs no follow-up.',
  'It is not finished when the agent asked the person something, when the person\'s last',
  'message has not been answered, or when the answer invites an obvious next question.',
  '',
  'Reply with exactly one word: DONE or WAIT.',
].join('\n');

const ORDERER = [
  'You are the coordinator of a group chat between one person and several AI agents.',
  'The person has just said something to the whole room, and the agents will answer one',
  'after another. Decide the order. Put first whoever should frame the answer — the one',
  'whose role fits the message best — and last whoever is best placed to check or',
  'challenge what the others said.',
  '',
  'Reply with a JSON array of the agent names, every name exactly once, and nothing else.',
].join('\n');

export function createRounds({
  hub,
  seats,
  /** name -> participant, for the seats that are running. */
  models,
  config,
  log = () => {},
  createClient = null,
  pollMs = 200,
  /** How long a one-to-one may sit quiet before the coordinator calls it finished. */
  idleMs = Number(process.env.ESPRITS_FLOOR_IDLE_MS ?? 90_000),
  /** How long after the last word a model coordinator is first asked whether it is over. */
  settleMs = Number(process.env.ESPRITS_FLOOR_SETTLE_MS ?? 15_000),
  clock = () => Date.now(),
}) {
  const db = hub.db;
  let cursor = hub.head();
  let timer = null;
  let ticking = false;
  let lastOwedCheck = 0;

  /** Turns waiting, in the order they will be taken. */
  const queue = [];
  let running = null;
  /** thread -> the one-to-one going on in it. */
  const direct = new Map();
  /** thread -> agent-to-agent hand-offs since a person last spoke. */
  const hops = new Map();
  /** Messages this module posted itself, or was told are already handled. */
  const skipped = new Set();
  const owedTried = new Set();
  /** seat:thread -> the newest message that was in front of that seat when it last spoke. */
  const sawUpTo = new Map();
  const settled = [];

  const slugOf = (ideaId) => (ideaId ? db.prepare('SELECT slug FROM ideas WHERE id = ?').get(ideaId)?.slug ?? null : null);
  const keyOf = (idea) => (idea ? db.prepare('SELECT id FROM ideas WHERE slug = ?').get(String(idea))?.id ?? 0 : 0);
  const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

  // ------------------------------------------------------------------ order

  /**
   * The order the keys were added.
   *
   * A seat sits on a connection, and the connection is where the key lives, so
   * "the order I added my keys" is the order of the connections — with the
   * order the seats were added settling two seats that share one.
   */
  function addedOrder() {
    return db.prepare(
      `SELECT p.name FROM participants p LEFT JOIN connections c ON c.name = p.connection
       ORDER BY IFNULL(c.created_at, p.created_at), p.created_at, p.name`,
    ).all().map((r) => r.name);
  }

  const mode = () => (ORDER_MODES.includes(config.get('turn_order_mode')) ? config.get('turn_order_mode') : 'added');

  function customList() {
    try {
      const saved = JSON.parse(config.get('turn_order') || '[]');
      return Array.isArray(saved) ? saved.map(String) : [];
    } catch { return []; }
  }

  /** Every seat, in the standing order: the person's own where they set one, the added order otherwise. */
  function standing() {
    const added = addedOrder();
    if (mode() !== 'custom') return added;
    const mine = customList().filter((n) => added.includes(n));
    // A seat added since the order was set goes on the end, not nowhere.
    return [...mine, ...added.filter((n) => !mine.includes(n))];
  }

  /** The seats that can actually take a turn, in the standing order. */
  const roster = () => standing().filter((n) => models.get(n)?.usable);

  function setOrder({ mode: next, order } = {}) {
    if (next !== undefined) {
      if (!ORDER_MODES.includes(next)) throw new Error(`the order is one of: ${ORDER_MODES.join(', ')}`);
      config.set('turn_order_mode', next === 'added' ? '' : next);
    }
    if (order !== undefined) {
      if (!Array.isArray(order)) throw new Error('the order is a list of seat names');
      const known = addedOrder();
      const unknown = order.map(String).filter((n) => !known.includes(n));
      if (unknown.length) throw new Error(`no seat named ${list(unknown)}`);
      config.set('turn_order', JSON.stringify([...new Set(order.map(String))]));
    }
    return orderView();
  }

  const orderView = () => ({ mode: mode(), order: standing(), added: addedOrder(), speaking: roster() });

  // ------------------------------------------------------------ coordinator

  /** The seat the person made coordinator, if it can make a call; otherwise the automation. */
  function coordinator() {
    const chosen = config.get('coordinator');
    if (chosen && models.get(chosen)?.usable) return { name: chosen, seat: true };
    return { name: BOT, seat: false, missing: chosen || null };
  }

  function setCoordinator(name) {
    const wanted = String(name ?? '').trim();
    if (wanted && wanted !== BOT && !seats.get(wanted)) throw new Error(`no seat named "${wanted}" — add it, with its key, on the setup page`);
    config.set('coordinator', wanted === BOT ? '' : wanted);
    return coordinatorView();
  }

  const coordinatorView = () => {
    const c = coordinator();
    return {
      name: c.name, automation: !c.seat, chosen: config.get('coordinator') || null,
      // Chosen but unable to speak: say so, rather than quietly being the bot.
      note: c.missing ? `${c.missing} has no working connection, so the automation is standing in` : null,
    };
  };

  /** One question to the coordinator's model, with no tools. */
  async function consult(system, prompt) {
    const c = coordinator();
    const r = c.seat ? seats.resolve(c.name) : null;
    if (!r) throw new Error('the coordinator is the automation');
    const adapter = chatAdapter({
      apiKey: r.apiKey, model: r.model, maxTokens: 2000, effort: 'low',
      effortParam: r.effortParam, tokenParam: r.tokenParam, shape: r.shape,
      baseURL: r.baseURL, createClient, timeoutMs: 45_000, maxRetries: 0,
    });
    const step = await adapter.startTurn({ system, tools: [] }).send(prompt);
    return String(step.text ?? '');
  }

  const tail = (idea, limit = 14) =>
    hub.recent({ idea, limit }).filter((m) => m.authorKind !== 'system')
      .map((m) => `${m.author}${m.authorKind === 'human' ? ' (the person)' : ''}: ${m.body.slice(0, 700)}`).join('\n');

  /** The coordinator, speaking in the thread. */
  function announce(idea, body) {
    const c = coordinator();
    try {
      if (!c.seat) hub.join({ name: BOT, role: 'coordinator', kind: 'agent', model: 'automation — rules, no model' });
      const m = hub.post({ idea, by: c.name, kind: 'status', body });
      skipped.add(m.id);
    } catch (err) {
      log(`rounds: the coordinator could not post — ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ queue

  function notice(idea, body) {
    try { hub.notice({ idea, body }); } catch (err) { log(`rounds: ${body} (and it could not be posted: ${err.message})`); }
  }

  /** Put a turn in the queue. One seat has at most one turn waiting per thread; a second reason joins the first. */
  function enqueue({ seat, idea, key, trigger, isDirect = false }) {
    if (!models.get(seat)?.usable) {
      // Only worth saying when somebody asked for this seat by name.
      if (isDirect) notice(idea, `${seat} has a seat but no working connection, so it cannot answer — give it a key on the setup page.`);
      return false;
    }
    const waiting = queue.find((j) => j.seat === seat && j.key === key);
    if (waiting) {
      waiting.triggers.push(trigger);
      waiting.isDirect ||= isDirect;
      return true;
    }
    queue.push({ seat, idea, key, triggers: [trigger], isDirect });
    return true;
  }

  function pump() {
    if (running || !queue.length) {
      if (!running && !queue.length) for (const done of settled.splice(0)) done();
      return;
    }
    const job = queue.shift();
    running = job;
    sawUpTo.set(`${job.seat}:${job.key}`, hub.head());
    const participant = models.get(job.seat);
    (async () => {
      try {
        if (!participant?.usable) throw new Error('it has no working connection any more');
        const r = await participant.takeTurn({ trigger: job.triggers.join('\n\n'), idea: job.idea, direct: job.isDirect });
        if (r.interrupted || r.stopped) return;
        if (r.refused) notice(job.idea, `${job.seat} declined to answer that.`);
        else if (r.truncated) notice(job.idea, `${job.seat} ran out of room before it finished, so nothing was posted — raise its max tokens on the setup page.`);
        else if (!r.actions.length) {
          notice(job.idea, r.exhausted
            ? `${job.seat} used up its turn without getting to an answer.`
            : `${job.seat} read that and had nothing to add.`);
        }
        log(`${job.seat}: ${r.actions.join(', ') || 'no action'}`);
      } catch (err) {
        // In the thread, not only in the server's log: a person looking at the
        // chat cannot tell an agent that failed from one that is ignoring them.
        notice(job.idea, `${job.seat} could not answer — ${err.message}`);
        log(`${job.seat}: ${err.message}`);
        try { hub.yieldFloor({ by: job.seat }); } catch { /* it was not holding it */ }
      } finally {
        running = null;
        const d = direct.get(job.key);
        if (d) d.last = clock();
        pump();
      }
    })();
  }

  // ------------------------------------------------------------- the floor

  /**
   * End a one-to-one and let the others in.
   *
   * They are queued in order behind a line from the coordinator, and each is
   * shown the thread when its turn comes — so what they answer is the whole
   * exchange, not the first message of it.
   */
  function openFloor(key, why = '') {
    const d = direct.get(key);
    if (!d) return false;
    direct.delete(key);
    const others = roster().filter((n) => !d.seats.includes(n));
    const pair = `${d.with} and ${list(d.seats)}`;
    announce(d.idea, others.length
      ? `${pair} have finished${why ? ` (${why})` : ''}. The floor is open — ${others.join(', then ')}: their exchange is above.`
      : `${pair} have finished${why ? ` (${why})` : ''}. The floor is open.`);
    for (const seat of others) {
      enqueue({
        seat, idea: d.idea, key,
        trigger: `${d.with} has been talking one-to-one with ${list(d.seats)} while you held. The coordinator has now `
          + 'opened the floor. Read their exchange above, then add what you have to it — or react to it if it needs nothing from you.',
      });
    }
    pump();
    return true;
  }

  /** The order for one round, when the coordinator is the one choosing it. */
  async function coordinatedOrder(message, names) {
    if (names.length < 2) return names;
    if (coordinator().seat) {
      try {
        const text = await consult(ORDERER, [
          `# The agents\n${names.map((n) => `- ${n}: ${seats.get(n)?.role ?? 'generalist'}`).join('\n')}`,
          `# What the person said\n${String(message).slice(0, 1500)}`,
        ].join('\n\n'));
        const body = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
        const picked = JSON.parse(body).map(String).filter((n) => names.includes(n));
        const order = [...new Set(picked)];
        // Anybody it forgot still gets a turn, after the ones it placed.
        return [...order, ...names.filter((n) => !order.includes(n))];
      } catch (err) {
        log(`rounds: the coordinator could not set the order (${err.message}) — using the automation's`);
      }
    }
    // The automation's rule: whoever has gone longest without speaking goes
    // first, so the same voice does not open every round.
    const spoke = new Map(db.prepare('SELECT name, last_spoke_at FROM agents').all().map((r) => [r.name, r.last_spoke_at ?? '']));
    return [...names].sort((a, b) => String(spoke.get(a) ?? '').localeCompare(String(spoke.get(b) ?? '')) || names.indexOf(a) - names.indexOf(b));
  }

  /** Why nobody can answer, in the words of somebody who can fix it. */
  function whyNobody() {
    const all = seats.all();
    if (!all.length) return 'No agent is in this chat yet. Add a key on the setup page — each chat key becomes an agent here.';
    const reasons = all.map((s) => (!s.connection ? `${s.name} is not on a connection`
      : s.connectionMissing ? `${s.name}'s connection is gone`
      : !s.ready ? `${s.name}'s connection has no key`
      : !s.enabled ? `${s.name} is switched off`
      : !seats.resolve(s.name)?.model ? `${s.name} has no model set`
      : `${s.name} is still starting`));
    return `Nobody can answer yet: ${reasons.join('; ')}. Fix that on the setup page.`;
  }

  let saidNobody = 0;

  async function everyone({ idea, key, trigger, message, except = [] }) {
    let names = roster().filter((n) => !except.includes(n));
    if (!names.length && !except.length && (!saidNobody || clock() - saidNobody > 60_000)) {
      // A room with no one in it must not look like a room that is ignoring you.
      saidNobody = clock();
      notice(idea, whyNobody());
    }
    if (mode() === 'coordinator') names = await coordinatedOrder(message ?? trigger, names);
    for (const seat of names) enqueue({ seat, idea, key, trigger });
    return names;
  }

  // -------------------------------------------------------------- messages

  async function onMessage(m) {
    if (skipped.delete(m.id)) return;
    if (m.author_kind === 'system' || m.kind === 'system') return;

    const key = m.idea_id ?? 0;
    const idea = slugOf(m.idea_id);
    const mentions = db.prepare('SELECT name FROM mentions WHERE message_id = ?').all(m.id).map((r) => r.name);
    const toAll = mentions.includes('all');
    const body = String(m.body).toLowerCase();
    const named = addedOrder()
      .filter((n) => mentions.includes(n) && n !== m.author)
      .sort((a, b) => body.indexOf(`@${a.toLowerCase()}`) - body.indexOf(`@${b.toLowerCase()}`));

    // An answer is addressed to whoever asked, whether or not it names them.
    if (m.kind === 'answer' && m.ref_kind === 'question' && !named.length && !toAll) {
      const asker = db.prepare('SELECT asked_by FROM questions WHERE id = ?').get(m.ref_id)?.asked_by;
      if (asker && asker !== m.author && addedOrder().includes(asker)) { named.push(asker); mentions.push(asker); }
    }

    if (m.author_kind === 'human') {
      if (!SPOKEN.has(m.kind)) return;
      hops.set(key, 0);
      const said = `${m.author} said (#${m.id}):\n\n${m.body}`;

      if (toAll) {
        // Addressing everyone is the person ending any one-to-one themselves.
        direct.delete(key);
        await everyone({ idea, key, trigger: said, message: m.body });
        return;
      }
      if (named.length) {
        direct.set(key, { seats: named, with: m.author, idea, last: clock(), asked: false, judging: false });
        for (const seat of named) {
          enqueue({ seat, idea, key, isDirect: true, trigger: `${m.author} addressed you by name (#${m.id}):\n\n${m.body}` });
        }
        return;
      }
      // Aimed at somebody who is not one of the seats — another person, or an
      // agent that connected from outside. Not ours to answer.
      if (mentions.length) return;

      const d = direct.get(key);
      if (d) {
        if (!coordinator().seat && closesExchange(m.body)) { openFloor(key); return; }
        d.last = clock(); d.asked = false; d.with = m.author;
        for (const seat of d.seats) {
          enqueue({ seat, idea, key, isDirect: true, trigger: `${m.author} is still talking to you (#${m.id}):\n\n${m.body}` });
        }
        return;
      }
      await everyone({ idea, key, trigger: said, message: m.body });
      return;
    }

    // An agent — one of the seats, or one that connected from outside. Agents
    // answer each other by naming each other, and only then.
    const targets = (toAll ? roster() : named).filter((n) => n !== m.author);
    if (!targets.length) return;
    // During a one-to-one the others are holding; they get the floor, and this
    // message with it, when it opens.
    if (direct.has(key)) return;
    for (const seat of targets) {
      // It has spoken since this was said, with this in front of it. Being
      // named in something you have already answered is not a new turn.
      if ((sawUpTo.get(`${seat}:${key}`) ?? 0) >= m.id) continue;
      const used = hops.get(key) ?? 0;
      if (used >= MAX_HOPS) {
        if (used === MAX_HOPS) {
          hops.set(key, used + 1);
          notice(idea, `The agents have handed this back and forth ${MAX_HOPS} times without you. They will wait for you to say something before going on.`);
        }
        return;
      }
      if (enqueue({ seat, idea, key, trigger: `${m.author} addressed you (#${m.id}):\n\n${m.body}` })) hops.set(key, used + 1);
    }
  }

  /** Is the one-to-one in this thread over? Asked of each, each tick. */
  function watch(key, d) {
    if (running?.key === key || queue.some((j) => j.key === key)) { d.last = clock(); return; }
    const quiet = clock() - d.last;
    if (quiet >= idleMs) { openFloor(key, 'nothing more was said'); return; }
    if (!coordinator().seat || d.asked || d.judging || quiet < settleMs) return;

    d.judging = true;
    consult(JUDGE, `The person is ${d.with}. The agent they named is ${list(d.seats)}.\n\n# The conversation\n${tail(d.idea)}`)
      .then((text) => {
        if (direct.get(key) !== d) return;
        d.asked = true;
        if (/\bDONE\b/i.test(text) && !/\bWAIT\b/i.test(text)) openFloor(key);
      })
      .catch((err) => {
        // It could not be asked. The quiet rule still applies, so the others
        // are held a little longer rather than for ever.
        d.asked = true;
        log(`rounds: the coordinator could not be asked whether the exchange is over (${err.message})`);
      })
      .finally(() => { d.judging = false; });
  }

  /** A proposal nobody can choose until everyone has scored it: give the seat that owes a score a turn. */
  function owed() {
    if (running || queue.length || clock() - lastOwedCheck < 5000) return;
    lastOwedCheck = clock();
    for (const seat of roster()) {
      const p = (hub.catchUp({ name: seat })?.proposalsAwaitingMyScore ?? []).find((x) => !owedTried.has(`${seat}:${x.id}`));
      if (!p) continue;
      const key = keyOf(p.idea);
      if (direct.has(key)) continue;
      owedTried.add(`${seat}:${p.id}`);
      enqueue({
        seat, idea: p.idea, key,
        trigger: `Proposal P#${p.id} "${p.title}" by ${p.author} is open and you have not scored it. The room cannot choose a route until you do.`,
      });
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const fresh = db.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id LIMIT 200').all(cursor);
      for (const m of fresh) {
        cursor = m.id;
        try { await onMessage(m); } catch (err) { log(`rounds: message #${m.id} — ${err.message}`); }
      }
      for (const [key, d] of direct) watch(key, d);
      try { owed(); } catch (err) { log(`rounds: ${err.message}`); }
      pump();
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((err) => log(`rounds: ${err.message}`)); }, pollMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
    tick,
    /** Resolves when nothing is running and nothing is waiting. */
    settle() {
      if (!running && !queue.length) return Promise.resolve();
      return new Promise((done) => settled.push(done));
    },

    /** This message is already being answered some other way; do not also schedule it. */
    skip(id) { if (Number(id) > cursor) skipped.add(Number(id)); },

    /** Drop every turn that has not started. What is running is stopped by its own seat. */
    clear() { const dropped = queue.splice(0).map((j) => j.seat); return dropped; },

    /** Give every agent a turn on something that is not a message — a new idea. */
    async invite({ idea = null, trigger }) {
      const key = keyOf(idea);
      direct.delete(key);
      const names = await everyone({ idea, key, trigger });
      pump();
      return names;
    },

    /** The person ends a one-to-one themselves. */
    open(idea = null) { return openFloor(keyOf(idea), 'opened by hand'); },

    order: orderView,
    setOrder,
    coordinator: coordinatorView,
    setCoordinator,

    /** The turn being taken this second: who, where, and what they have written so far. */
    live() {
      if (!running) return null;
      const doing = models.get(running.seat)?.live;
      return {
        seat: running.seat, idea: running.idea,
        since: doing?.since ?? null, phase: doing?.phase ?? 'thinking',
        tool: doing?.tool ?? null, text: doing?.text ?? '',
        next: queue.filter((j) => j.key === running.key).map((j) => j.seat),
      };
    },

    state(idea = undefined) {
      const key = idea === undefined ? null : keyOf(idea);
      const d = key === null ? null : direct.get(key);
      return {
        running: running ? { seat: running.seat, idea: running.idea } : null,
        queue: queue.map((j) => ({ seat: j.seat, idea: j.idea })),
        oneToOne: d ? { seats: d.seats, with: d.with } : null,
        ...orderView(),
        coordinator: coordinatorView(),
      };
    },
  };
}
