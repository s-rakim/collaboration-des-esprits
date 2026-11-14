import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hub } from '../src/core.js';
import { createConfig } from '../src/settings.js';
import { createConnections } from '../src/connections.js';
import { createSeats } from '../src/seats.js';
import { createRounds, closesExchange, BOT } from '../src/rounds.js';

/**
 * The rules of the conversation, tested with agents that are scripts.
 *
 * A stand-in agent takes its turn by posting one line, so what is asserted is
 * the thing a person would see: who spoke, in what order, and who did not.
 */
function room({ names = ['ada', 'bo', 'cy'], coordinatorReplies = null } = {}) {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const config = createConfig(hub.db);
  const connections = createConnections(hub.db);
  const seats = createSeats(hub.db, connections);
  const models = new Map();
  const turns = [];
  const state = { now: 1_000_000, script: {} };

  // One key each, added in this order — which is the order they should speak in.
  names.forEach((name, i) => {
    connections.save({ name: `key-${name}`, kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' });
    hub.db.prepare('UPDATE connections SET created_at = ? WHERE name = ?').run(`2026-01-0${i + 1}T00:00:00.000Z`, `key-${name}`);
    seats.save({ name, connection: `key-${name}`, role: 'generalist' });
    hub.join({ name, role: 'generalist', kind: 'agent' });
    models.set(name, {
      usable: true,
      async takeTurn({ trigger, idea, direct }) {
        turns.push({ seat: name, trigger, idea, direct });
        const act = state.script[name];
        if (act === 'fail') throw new Error('the endpoint timed out');
        if (act === 'silent') return { actions: [] };
        const body = typeof act === 'function' ? act(turns.filter((t) => t.seat === name).length) : `${name} here`;
        if (body) hub.post({ idea, by: name, body });
        return { actions: body ? ['reply'] : [] };
      },
    });
  });

  // The coordinator's model, when a seat has been made coordinator.
  const asked = [];
  const createClient = () => ({
    chat: { completions: { create: async (params) => {
      const system = params.messages.find((m) => m.role === 'system').content;
      asked.push(/Decide the order/.test(system) ? 'order' : 'done?');
      const answer = coordinatorReplies?.(system, params.messages.find((m) => m.role === 'user').content) ?? 'WAIT';
      return { choices: [{ finish_reason: 'stop', message: { content: answer } }] };
    } } },
  });

  const rounds = createRounds({
    hub, seats, models, config, createClient,
    idleMs: 90_000, settleMs: 15_000, clock: () => state.now,
  });

  const say = async (body, opts = {}) => {
    const m = hub.post({ idea: opts.idea ?? null, body, by: opts.by ?? 'rakim', kind: opts.kind ?? 'message' });
    // Until it is quiet: what an agent says on its turn can give another one.
    for (let before = -1; before !== turns.length;) {
      before = turns.length;
      await rounds.tick();
      await rounds.settle();
    }
    return m;
  };
  /** Let time pass with nobody speaking. */
  const wait = async (ms) => {
    state.now += ms;
    await rounds.tick();
    await new Promise((r) => setImmediate(r));
    await rounds.tick();
    await rounds.settle();
  };
  const spoke = (from = 0) => turns.slice(from).map((t) => t.seat);
  const lines = () => hub.recent({ limit: 100 }).map((m) => `${m.author}: ${m.body}`);
  return { hub, config, seats, models, rounds, turns, state, say, wait, spoke, lines, asked };
}

test('a message that names nobody is answered by everyone, in the order the keys were added', async () => {
  const r = room();
  await r.say('what should we build?');
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy']);
  // One after another, not at once: each has posted before the next began.
  assert.deepEqual(r.lines().slice(-3), ['ada: ada here', 'bo: bo here', 'cy: cy here']);
});

test('the order follows when the keys were added, not the names or when the seats were made', async () => {
  const r = room({ names: ['zed', 'amy'] });
  // zed's key went in first; amy sorts first by name. The key decides.
  await r.say('hello');
  assert.deepEqual(r.spoke(), ['zed', 'amy']);
});

test('naming an agent means only that agent answers', async () => {
  const r = room();
  await r.say('@bo what do you make of this?');
  assert.deepEqual(r.spoke(), ['bo']);
  assert.equal(r.turns[0].direct, true);
});

test('a mention reaches its agent whatever capitals it was typed with', async () => {
  const r = room();
  await r.say('@BO are you there?');
  assert.deepEqual(r.spoke(), ['bo'], 'this is the bug that read as being ignored');
});

test('once an agent is named, the conversation stays with it until it is over', async () => {
  const r = room();
  await r.say('@bo how would you store this?');
  await r.say('and what about backups?');          // names nobody — still bo's
  await r.say('how often?');
  assert.deepEqual(r.spoke(), ['bo', 'bo', 'bo'], 'nobody else speaks during a one-to-one');
  assert.deepEqual(r.rounds.state(null).oneToOne, { seats: ['bo'], with: 'rakim' });
});

test('the coordinator opens the floor when the person signs off, and the others answer with the exchange in front of them', async () => {
  const r = room();
  await r.say('@bo how would you store this?');
  await r.say('nightly?');
  const before = r.turns.length;
  await r.say('thanks, that\'s all');

  assert.deepEqual(r.spoke(before), ['ada', 'cy'], 'the others, in order — and not bo again');
  assert.equal(r.rounds.state(null).oneToOne, null);
  const opened = r.lines().find((l) => l.startsWith(`${BOT}:`));
  assert.match(opened, /rakim and bo have finished/);
  assert.match(opened, /ada, then cy/);
  assert.match(r.turns[before].trigger, /opened the floor/);
  // What ada is about to read includes the whole exchange.
  const thread = r.hub.recent({ limit: 50 }).map((m) => m.body);
  assert.ok(thread.includes('@bo how would you store this?') && thread.includes('nightly?'));
});

test('a one-to-one that goes quiet is closed by the coordinator, not left holding everyone for ever', async () => {
  const r = room();
  await r.say('@ada sketch the data model');
  await r.wait(30_000);
  assert.deepEqual(r.spoke(), ['ada'], 'thirty seconds of quiet is somebody reading');
  await r.wait(61_000);
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy']);
  assert.match(r.lines().find((l) => l.startsWith(`${BOT}:`)), /nothing more was said/);
});

test('@all ends a one-to-one and brings everyone in', async () => {
  const r = room();
  await r.say('@cy quick question');
  await r.say('@all right, everyone: thoughts?');
  assert.deepEqual(r.spoke(), ['cy', 'ada', 'bo', 'cy']);
  assert.equal(r.rounds.state(null).oneToOne, null);
});

test('naming a different agent moves the one-to-one to it', async () => {
  const r = room();
  await r.say('@ada first you');
  await r.say('@cy now you');
  await r.say('go on');
  assert.deepEqual(r.spoke(), ['ada', 'cy', 'cy']);
});

test('the person can open the floor by hand', async () => {
  const r = room();
  await r.say('@ada first you');
  assert.equal(r.rounds.open(null), true);
  await r.rounds.settle();
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy']);
  assert.match(r.lines().find((l) => l.startsWith(`${BOT}:`)), /opened by hand/);
});

test('agents answer each other by name, and only then', async () => {
  const r = room();
  // ada puts a question to cy, who is still to speak this round and will have
  // ada's message in front of it when it does.
  r.state.script.ada = (n) => (n === 1 ? '@cy does that hold for you?' : 'noted');
  await r.say('how should this work?');
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy'], 'cy answers once, not once for the round and again for the mention');
});

test('an agent named by another agent after the round gets a turn of its own', async () => {
  const r = room();
  r.state.script.cy = (n) => (n === 1 ? '@ada I disagree with your first point' : 'fine');
  await r.say('how should this work?');
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy', 'ada']);
});

test('agents cannot hand a conversation back and forth for ever', async () => {
  const r = room({ names: ['ada', 'bo'] });
  r.state.script.ada = () => '@bo and you?';
  r.state.script.bo = () => '@ada and you?';
  await r.say('@all go');
  await r.rounds.tick(); await r.rounds.settle();
  for (let i = 0; i < 20; i++) { await r.rounds.tick(); await r.rounds.settle(); }
  assert.ok(r.turns.length <= 2 + 6 + 1, `stopped after ${r.turns.length} turns`);
  assert.ok(r.lines().some((l) => /handed this back and forth 6 times without you/.test(l)));
});

test('while two are talking one-to-one, an agent naming another does not pull it in', async () => {
  const r = room();
  r.state.script.ada = () => '@bo should weigh in on this';
  await r.say('@ada what do you think?');
  assert.deepEqual(r.spoke(), ['ada'], 'bo holds until the floor opens');
});

test('an agent that fails says so in the thread, and the next one still speaks', async () => {
  const r = room();
  r.state.script.bo = 'fail';
  await r.say('anyone?');
  assert.deepEqual(r.spoke(), ['ada', 'bo', 'cy']);
  assert.ok(r.lines().some((l) => l === 'esprits: bo could not answer — the endpoint timed out'),
    'a failure only the server log knows about looks exactly like being ignored');
});

test('an agent that reads and stays silent is reported as having read it', async () => {
  const r = room();
  r.state.script.cy = 'silent';
  await r.say('@cy anything to add?');
  assert.ok(r.lines().includes('esprits: cy read that and had nothing to add.'));
});

test('naming a seat that has no working connection says so instead of nothing happening', async () => {
  const r = room();
  r.seats.save({ name: 'dee', role: 'critic' });         // a seat, but no key
  r.hub.join({ name: 'dee', role: 'critic', kind: 'agent' });
  await r.say('@dee what do you think?');
  assert.deepEqual(r.spoke(), []);
  assert.ok(r.lines().some((l) => /dee has a seat but no working connection/.test(l)));
});

test('a message for another person is not answered by the agents', async () => {
  const r = room();
  r.hub.join({ name: 'sam', role: 'human', kind: 'human' });
  await r.say('@sam can you check the invoice?');
  assert.deepEqual(r.spoke(), []);
});

test('the person can set the order themselves', async () => {
  const r = room();
  r.rounds.setOrder({ mode: 'custom', order: ['cy', 'ada'] });
  await r.say('go');
  assert.deepEqual(r.spoke(), ['cy', 'ada', 'bo'], 'the ones placed, then anybody left out — not nobody');
  assert.throws(() => r.rounds.setOrder({ order: ['nobody'] }), /no seat named nobody/);
  r.rounds.setOrder({ mode: 'added' });
  await r.say('again');
  assert.deepEqual(r.spoke(3), ['ada', 'bo', 'cy']);
});

test('the automation, asked to set the order, puts whoever has been quiet longest first', async () => {
  const r = room();
  r.rounds.setOrder({ mode: 'coordinator' });
  const stamp = (name, at) => r.hub.db.prepare('UPDATE agents SET last_spoke_at = ? WHERE name = ?').run(at, name);
  stamp('ada', '2026-03-03T00:00:00Z'); stamp('bo', '2026-03-01T00:00:00Z'); stamp('cy', '2026-03-02T00:00:00Z');
  await r.say('go');
  assert.deepEqual(r.spoke(), ['bo', 'cy', 'ada']);
});

test('a seat made coordinator sets the order with its own model', async () => {
  const r = room({ coordinatorReplies: (system) => (/Decide the order/.test(system) ? 'Order:\n["cy","bo"]' : 'WAIT') });
  r.rounds.setCoordinator('ada');
  r.rounds.setOrder({ mode: 'coordinator' });
  await r.say('review this design');
  assert.deepEqual(r.spoke(), ['cy', 'bo', 'ada'], 'its order, with the one it forgot added at the end');
  assert.deepEqual(r.rounds.coordinator(), { name: 'ada', automation: false, chosen: 'ada', note: null });
});

test('a seat made coordinator judges when a one-to-one is over', async () => {
  let verdict = 'WAIT';
  const r = room({ coordinatorReplies: () => verdict });
  r.rounds.setCoordinator('cy');
  await r.say('@ada how would you store this?');
  // With a model coordinator a sign-off is not a rule; it is asked.
  await r.wait(16_000);
  assert.deepEqual(r.asked, ['done?']);
  assert.deepEqual(r.spoke(), ['ada'], 'it said wait');

  await r.say('one more thing — retention?');
  verdict = 'DONE';
  await r.wait(16_000);
  await r.wait(1);
  assert.deepEqual(r.spoke(), ['ada', 'ada', 'bo', 'cy']);
  assert.match(r.lines().find((l) => l.startsWith('cy: rakim and ada have finished')), /bo, then cy/);
});

test('a coordinator with no working connection is replaced by the automation, and says so', async () => {
  const r = room();
  r.seats.save({ name: 'dee', role: 'coordinator' });
  r.rounds.setCoordinator('dee');
  const c = r.rounds.coordinator();
  assert.equal(c.name, BOT);
  assert.match(c.note, /dee has no working connection/);
  assert.throws(() => r.rounds.setCoordinator('ghost'), /no seat named "ghost"/);
});

test('stopping clears the turns that have not started', async () => {
  const r = room();
  let release;
  r.models.get('ada').takeTurn = () => new Promise((done) => { release = () => done({ actions: [], interrupted: true }); });
  r.hub.post({ body: 'go', by: 'rakim' });
  await r.rounds.tick();
  assert.deepEqual(r.rounds.state(null).queue.map((j) => j.seat), ['bo', 'cy']);
  assert.deepEqual(r.rounds.clear(), ['bo', 'cy']);
  release();
  await r.rounds.settle();
  assert.deepEqual(r.spoke(), []);
});

test('a message already being answered elsewhere is not also given a turn', async () => {
  const r = room();
  const m = r.hub.post({ body: '@ada direct', by: 'rakim', kind: 'question' });
  r.rounds.skip(m.id);
  await r.rounds.tick(); await r.rounds.settle();
  assert.deepEqual(r.spoke(), []);
});

test('each thread keeps its own conversation', async () => {
  const r = room();
  const idea = r.hub.dropIdea({ title: 'Billing', raw: '', by: 'rakim' });
  await r.say('@ada about billing', { idea: idea.slug });
  await r.say('lobby question');
  assert.deepEqual(r.spoke(), ['ada', 'ada', 'bo', 'cy'], 'a one-to-one in one idea does not hold the lobby');
  assert.equal(r.turns[0].idea, 'billing');
  assert.equal(r.turns[1].idea, null);
});

test('only a short sign-off closes an exchange; anything with substance carries it on', () => {
  for (const yes of ['thanks', 'Thanks!', 'ok thanks', 'thank you so much', 'got it', "that's all", 'perfect, thanks', 'done', 'sounds good', 'open the floor']) {
    assert.equal(closesExchange(yes), true, yes);
  }
  for (const no of ['thanks, but what about backups?', 'ok so how does that scale', 'done with the schema, now the API', 'good question', 'what?', '']) {
    assert.equal(closesExchange(no), false, no);
  }
});

test('a reaction is recorded once and shown on the message', () => {
  const r = room();
  const m = r.hub.post({ body: 'ship it?', by: 'rakim' });
  r.hub.react({ message: m.id, by: 'ada', emoji: '👍' });
  r.hub.react({ message: m.id, by: 'ada', emoji: '👍' });
  r.hub.react({ message: m.id, by: 'bo', emoji: '👍' });
  assert.deepEqual(r.hub.recent({ limit: 1 })[0].reactions, [{ emoji: '👍', by: ['ada', 'bo'] }]);
  assert.throws(() => r.hub.react({ message: m.id, by: 'ada', emoji: 'I agree with this' }), /one emoji/);
  assert.throws(() => r.hub.react({ message: 9999, by: 'ada', emoji: '👍' }), /no message #9999/);
  assert.equal(r.hub.reactionsSince(0).length, 2);
});

test('a receipt marks what reached an agent, and never its own words', () => {
  const r = room();
  const a = r.hub.post({ body: 'one', by: 'rakim' });
  const b = r.hub.post({ body: 'two', by: 'ada' });
  assert.deepEqual(r.hub.acknowledge({ by: 'ada', messages: [a.id, b.id] }), { marked: 1 });
  const [first, second] = r.hub.recent({ limit: 2 });
  assert.deepEqual(first.reactions, [{ emoji: '✓', by: ['ada'] }]);
  assert.equal(second.reactions, undefined);
});
