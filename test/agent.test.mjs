import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createModelParticipant } from '../src/participants/agent.js';

/**
 * The participant is exercised with a stubbed provider client: the point of
 * these tests is that a tool call coming back from a model lands in the room as
 * the real thing, whichever provider it came from, and that the failure paths do
 * not lose the reply.
 */
/**
 * Stands in for the Chat Completions client every provider uses.
 *
 * Requests are snapshotted because the loop mutates the same messages array in
 * place — a stored reference would read as the final state of the conversation
 * rather than what each request actually carried.
 */
function scripted(turns) {
  let i = 0;
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push({ ...params, messages: structuredClone(params.messages) });
          return turns[Math.min(i++, turns.length - 1)];
        },
      },
    },
  };
  return { client, calls };
}

/** A provider response: prose, tool calls, or a finish reason that ends the turn. */
const msg = (content, toolCalls = [], finish = 'stop') => ({
  choices: [{
    finish_reason: toolCalls.length ? 'tool_calls' : finish,
    message: {
      content,
      ...(toolCalls.length ? {
        tool_calls: toolCalls.map((t, n) => ({
          id: `call_${n}`, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        })),
      } : {}),
    },
  }],
});



function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  hub.join({ name: 'crit', role: 'critic' });
  return { hub };
}

const SEAT = {
  name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2',
  role: 'architect', effort: 'high', maxTokens: 64000,
};

/**
 * Stands in for seats.resolve(): the live endpoint, model and credential the
 * participant re-reads on every turn.
 */
const resolver = (seat) => () => ({
  ...seat,
  baseURL: seat.baseURL ?? 'https://endpoint.example/v1',
  apiKey: seat.apiKey ?? 'sk-test',
  effortParam: seat.effortParam === undefined ? 'reasoning_effort' : seat.effortParam,
});

const participant = ({ hub }, turns, log = () => {}, seat = SEAT, media = null) => {
  const { client, calls } = scripted(turns);
  const p = createModelParticipant({
    hub, seat, log, resolve: resolver(seat), createClient: () => client, media,
  });
  return { p, calls };
};

test('a reply tool call becomes a real message in the room', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Digest emails', raw: 'email me a summary', by: 'rakim' });
  const { p } = participant(ctx, [msg(null, [{ name: 'reply', input: { body: 'Cheapest path is a nightly cron.' } }])]);

  const r = await p.askDirect({ body: 'how would you build this?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['reply']);

  const said = ctx.hub.db.prepare('SELECT author, body, kind FROM messages WHERE author = ? ORDER BY id DESC').get('gpt');
  assert.equal(said.body, 'Cheapest path is a nightly cron.');
  assert.equal(said.kind, 'message');
});

test('the brief is what gets sent as context, not a bare question', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Context check', raw: 'THE ORIGINAL DUMP', by: 'rakim' });
  ctx.hub.decide({ idea: idea.slug, choice: 'sqlite over postgres', rationale: 'no daemon', by: 'crit' });
  const { p, calls } = participant(ctx, [msg(null, [{ name: 'say_nothing', input: {} }])]);

  await p.askDirect({ body: 'thoughts?', idea: idea.slug, from: 'rakim' });
  const sent = calls[0].messages.find((m) => m.role === 'user').content;
  assert.match(sent, /THE ORIGINAL DUMP/, 'carries the original idea');
  assert.match(sent, /sqlite over postgres/, 'carries the decisions');
  assert.match(sent, /no daemon/, 'carries the reasoning');
  assert.match(sent, /thoughts\?/, 'and the actual question');
});

test('the request uses the seat\u2019s own model and its tool surface', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Params', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [msg(null, [{ name: 'say_nothing', input: {} }])], () => {}, { ...SEAT, effort: 'max' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  const req = calls[0];
  assert.equal(req.model, 'gpt-5.2');
  assert.equal(req.messages[0].role, 'system', 'the charter goes in a system message');
  assert.equal(req.tool_choice, 'auto');
  assert.ok(req.tools.some((t) => t.function.name === 'generate_image'), 'media tools are offered too');
  assert.ok(req.tools.some((t) => t.function.name === 'propose'), 'tools are translated to the function shape');
});

test('an invalid effort falls back instead of 400ing on every wake', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Bad effort', raw: '', by: 'rakim' });
  const notes = [];
  const { p, calls } = participant(ctx, [msg(null, [{ name: 'say_nothing', input: {} }])], (m) => notes.push(m), { ...SEAT, effort: 'extremely-high' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  assert.equal(calls[0].reasoning_effort, 'high', 'clamped to a value the provider will accept');
  assert.ok(notes.some((n) => /not a valid effort/.test(n)), 'and says so rather than failing quietly');
});

test('effort is sent only to providers that declare the field', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Effort routing', raw: '', by: 'rakim' });

  const oai = participant(ctx, [msg('ok')], () => {},
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic', effort: 'low' });
  await oai.p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  assert.equal(oai.calls[0].reasoning_effort, 'low');

  // Gemini's compatible endpoint does not take it, and an unknown parameter
  // fails the whole request rather than being ignored.
  const gem = participant(ctx, [msg('ok')], () => {},
    // This endpoint declares no effort field, so nothing should be sent.
    { name: 'gem', connection: 'other-endpoint', model: 'gemini-3-pro', role: 'critic', effort: 'low', effortParam: null });
  await gem.p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  assert.ok(!('reasoning_effort' in gem.calls[0]), 'not sent where it is unsupported');
});

test('a propose tool call creates a scoreable proposal', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Routes', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [
    msg(null, [{ name: 'propose', input: { title: 'Cron + SMTP', approach: 'nightly job', effort: 'S', risks: 'deliverability' } }]),
  ]);

  await p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  const st = ctx.hub.standing({ idea: idea.slug }).contests[0];
  assert.equal(st.ranked.length, 1);
  assert.equal(st.ranked[0].title, 'Cron + SMTP');
  assert.equal(st.ranked[0].author, 'gpt');
});

test('weigh_in scores another agent and the loop continues to a reply', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Scoring', raw: '', by: 'rakim' });
  const theirs = ctx.hub.propose({ idea: idea.slug, title: 'Their route', approach: 'x', by: 'crit' });
  const { p } = participant(ctx, [
    msg(null, [{ name: 'weigh_in', input: { proposal: theirs.id, stance: 'endorse', feasibility: 4, reasoning: 'no new infra' } }]),
    msg(null, [{ name: 'reply', input: { body: 'Scored it — workable.' } }]),
  ]);

  const r = await p.askDirect({ body: 'what do you think of that?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['weigh_in', 'reply']);
  const scored = ctx.hub.getProposal(theirs.id);
  assert.equal(scored.endorsements, 1);
  assert.equal(scored.feasibility, 4);
  assert.ok(scored.assessments.some((a) => a.agent === 'gpt'));
});

test("a rejected action is handed back so it can correct itself, not swallowed", async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Recovery', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [
    // Scoring a proposal that does not exist must fail.
    msg(null, [{ name: 'weigh_in', input: { proposal: 9999, stance: 'endorse', reasoning: 'x' } }]),
    msg(null, [{ name: 'reply', input: { body: 'That proposal is gone; here is my own view instead.' } }]),
  ]);

  const r = await p.askDirect({ body: 'go', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['reply'], 'the failed call is not counted as an action');

  // The failure was returned as a tool_result so the model could react to it.
  const fed = calls[1].messages.at(-1).content;
  assert.match(JSON.stringify(fed), /FAILED.*no proposal/);
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body LIKE ?').get('%my own view%'));
});

test('prose without a tool call is still posted rather than dropped', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Prose', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [
    msg('I think a queue is overkill here.'),
  ]);

  const r = await p.askDirect({ body: 'queue or not?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['reply']);
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('I think a queue is overkill here.'));
});

test('a refusal is reported and nothing is posted', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Refused', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg(null, [], 'content_filter')]);

  const r = await p.askDirect({ body: 'something declined', idea: idea.slug, from: 'rakim' });
  assert.equal(r.refused, true);
  assert.equal(ctx.hub.db.prepare("SELECT COUNT(*) n FROM messages WHERE author = 'gpt'").get().n, 0);
});

test('hitting max_tokens is reported rather than posting a half sentence', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Truncated', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg('I was saying that', [], 'length')]);

  const r = await p.askDirect({ body: 'go on', idea: idea.slug, from: 'rakim' });
  assert.equal(r.truncated, true);
});

test('a runaway tool loop is capped', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Runaway', raw: '', by: 'rakim' });
  // Always answers with a non-terminal action, so only the cap stops it.
  const { p, calls } = participant(ctx, [msg(null, [{ name: 'remember', input: { key: 'k', value: 'v' } }])]);

  const r = await p.askDirect({ body: 'loop', idea: idea.slug, from: 'rakim' });
  assert.equal(r.exhausted, true);
  assert.ok(calls.length <= 6, `expected the cap to hold, got ${calls.length} requests`);
});

test('the participant queues for the floor like any other agent', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Manners', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg(null, [{ name: 'reply', input: { body: 'my turn now' } }])]);

  // crit holds the floor and then releases it while the model is waiting.
  ctx.hub.requestFloor({ by: 'crit', urgency: 'comment', reason: 'holding' });
  const asking = p.askDirect({ body: 'go', idea: idea.slug, from: 'rakim' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ctx.hub.floor().holder.agent, 'crit', 'it did not barge in');

  ctx.hub.yieldFloor({ by: 'crit' });
  const r = await asking;
  assert.deepEqual(r.actions, ['reply']);
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('my turn now'));
  assert.equal(ctx.hub.floor().holder, null, 'and released it after speaking');
});

test('a seat with no key says which connection is missing one', async () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const p = createModelParticipant({
    hub,
    seat: { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' },
    resolve: () => ({ connection: 'my-endpoint', baseURL: 'https://endpoint.example/v1', model: 'gpt-5.2', apiKey: null }),
  });
  await assert.rejects(() => p.askDirect({ body: 'hi', from: 'rakim' }), /no API key for "my-endpoint"/);
});

test('a seat with no connection at all says that instead', async () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const p = createModelParticipant({
    hub, seat: { name: 'gpt', role: 'critic' }, resolve: () => null,
  });
  await assert.rejects(() => p.askDirect({ body: 'hi', from: 'rakim' }), /no connection/);
});

test('an agent can generate an image and it lands in the room', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Show me', raw: '', by: 'rakim' });
  const asked = [];
  const { p } = participant(
    ctx,
    [msg(null, [{ name: 'generate_image', input: { prompt: 'a red square', caption: 'like this' } }])],
    () => {}, SEAT,
    { image: async (prompt) => { asked.push(prompt); return '/media/abc.png'; } },
  );

  const r = await p.askDirect({ body: 'draw it', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['generate_image']);
  assert.deepEqual(asked, ['a red square']);

  const posted = ctx.hub.db.prepare("SELECT body FROM messages WHERE author = 'gpt' ORDER BY id DESC").get();
  assert.match(posted.body, /like this/);
  assert.match(posted.body, /!\[image\]\(\/media\/abc\.png\)/, 'posted as markdown the feed can render');
});

test('the generation tools report honestly when no such connection exists', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'No generator', raw: '', by: 'rakim' });
  const { p, calls } = participant(
    ctx,
    [msg(null, [{ name: 'generate_video', input: { prompt: 'a clip' } }]), msg('I cannot make video here.')],
    () => {}, SEAT,
    null, // no media connections at all
  );

  const r = await p.askDirect({ body: 'make a video', idea: idea.slug, from: 'rakim' });
  const fed = JSON.stringify(calls[1].messages.at(-1));
  assert.match(fed, /FAILED: no video connection/);
  // The refused call is not counted as something it did; the recovery is.
  assert.deepEqual(r.actions, ['reply'], 'and it recovers rather than dying');
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body LIKE ?').get('%cannot make video%'));
});

// ------------------------------------------------- several providers, one room

test('an OpenAI-shaped seat drives the same room through the other adapter', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Cross provider', raw: 'settle this', by: 'rakim' });
  const { p, calls } = participant(ctx,
    [msg(null, [{ name: 'propose', input: { title: 'GPT route', approach: 'do it this way' } }]),
     msg('Proposed it.')],
    () => {},
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic', effort: 'high' });

  const r = await p.askDirect({ body: 'how would you do it?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['propose']);

  // It landed as a real proposal, authored by that seat.
  const st = ctx.hub.standing({ idea: idea.slug }).contests[0];
  assert.equal(st.ranked[0].title, 'GPT route');
  assert.equal(st.ranked[0].author, 'gpt');

  // And it was sent in the Chat Completions shape, with tools translated.
  assert.equal(calls[0].model, 'gpt-5.2');
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].tools[0].type, 'function');
  assert.equal(calls[0].tools[0].function.name, 'reply');
});

test('an OpenAI-shaped tool result goes back keyed by call id', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Results', raw: '', by: 'rakim' });
  const theirs = ctx.hub.propose({ idea: idea.slug, title: 'Theirs', approach: 'x', by: 'crit' });
  const { p, calls } = participant(ctx,
    [msg(null, [{ name: 'weigh_in', input: { proposal: theirs.id, stance: 'endorse', feasibility: 4, reasoning: 'fine' } }]),
     msg(null, [{ name: 'reply', input: { body: 'scored it' } }])],
    () => {},
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' });

  await p.askDirect({ body: 'score it', idea: idea.slug, from: 'rakim' });
  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'the result is sent as a tool message');
  assert.equal(toolMsg.tool_call_id, 'call_0');
  assert.equal(ctx.hub.getProposal(theirs.id).endorsements, 1);
});

test('malformed tool arguments do not take the turn down', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Garbage in', raw: '', by: 'rakim' });
  const { client, calls } = (() => {
    let i = 0;
    const calls = [];
    const turns = [
      // Arguments that are not valid JSON, which a provider can emit when
      // output is truncated.
      { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_x', type: 'function', function: { name: 'reply', arguments: '{"body": "half a sen' } },
      ] } }] },
      msg('Second try: here is my view.'),
    ];
    const client = { chat: { completions: { create: async (p) => { calls.push(p); return turns[Math.min(i++, 1)]; } } } };
    return { client, calls };
  })();

  const seat = { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' };
  const p = createModelParticipant({
    hub: ctx.hub,
    seat,
    resolve: () => ({ ...seat, baseURL: 'https://endpoint.example/v1', apiKey: 'sk-test' }),
    createClient: () => client,
  });

  // reply with a malformed body posts nothing and is reported back, then the
  // model gets another go.
  const r = await p.askDirect({ body: 'go', idea: idea.slug, from: 'rakim' });
  assert.ok(calls.length >= 2, 'it recovered rather than throwing');
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body LIKE ?').get('%here is my view%'));
});

test('a content filter reads as a refusal, not an empty success', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Filtered', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg(null, [], 'content_filter')], () => {},
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' });

  const r = await p.askDirect({ body: 'x', idea: idea.slug, from: 'rakim' });
  assert.equal(r.refused, true);
});

test('a truncated OpenAI response is reported rather than posted half-finished', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Cut off', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg('I was saying that', [], 'length')], () => {},
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' });

  const r = await p.askDirect({ body: 'go on', idea: idea.slug, from: 'rakim' });
  assert.equal(r.truncated, true);
});

test('models from different providers argue with each other in one room', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Mixed room', raw: 'pick an approach', by: 'rakim' });

  const gem = participant(ctx, [msg(null, [{ name: 'propose', input: { title: 'Gemini route', approach: 'a' } }])], () => {},
    { name: 'gem', connection: 'other-endpoint', model: 'gemini-3-pro', role: 'architect', effort: 'high' });
  const gpt = participant(ctx,
    [msg(null, [{ name: 'weigh_in', input: { proposal: 1, stance: 'object', feasibility: 2, reasoning: 'breaks on retries', blocking: true } }]),
     msg('Objected.')],
    { name: 'gpt', connection: 'my-endpoint', model: 'gpt-5.2', role: 'critic' });

  await gem.p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  await gpt.p.askDirect({ body: 'is that sound?', idea: idea.slug, from: 'rakim' });

  const proposal = ctx.hub.getProposal(1);
  assert.equal(proposal.author, 'gem');
  assert.equal(proposal.choosable, false, 'the other provider blocked it');
  assert.deepEqual(proposal.blockingObjections.map((o) => o.agent), ['gpt']);

  // Each went to its own provider with its own model.
  assert.equal(gem.calls[0].model, 'gemini-3-pro');
  assert.equal(gpt.calls[0].model, 'gpt-5.2');
});

test('several models sit in one room under their own names and models', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Two minds', raw: 'settle this', by: 'rakim' });

  const big = participant(ctx, [msg(null, [{ name: 'propose', input: { title: 'Route A', approach: 'do it this way' } }])],
    () => {}, { name: 'big', connection: 'my-endpoint', model: 'gpt-5.2', role: 'architect', effort: 'high' });
  const small = participant(ctx, [msg(null, [{ name: 'weigh_in', input: { proposal: 1, stance: 'object', feasibility: 2, reasoning: 'falls over on empty input', blocking: true } }])],
    () => {}, { name: 'small', connection: 'my-endpoint', model: 'gpt-5-mini', role: 'critic', effort: 'medium' });

  await big.p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  await small.p.askDirect({ body: 'is that sound?', idea: idea.slug, from: 'rakim' });

  // Each seat is its own participant in the roster.
  const roster = ctx.hub.roster().map((a) => `${a.name}:${a.model}`);
  assert.ok(roster.includes('big:gpt-5.2'));
  assert.ok(roster.includes('small:gpt-5-mini'));

  // And they genuinely disagree: one proposed, the other blocked it.
  const p = ctx.hub.getProposal(1);
  assert.equal(p.author, 'big');
  assert.equal(p.choosable, false);
  assert.deepEqual(p.blockingObjections.map((o) => o.agent), ['small']);

  // Each sent its own model.
  assert.equal(big.calls[0].model, 'gpt-5.2');
  assert.equal(small.calls[0].model, 'gpt-5-mini');
});

test('a model is told which model it is and that the others differ', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Identity', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [msg(null, [{ name: 'say_nothing', input: {} }])], () => {},
    { name: 'mini', connection: 'my-endpoint', model: 'gpt-5-mini', role: 'researcher', effort: 'low' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  const system = calls[0].messages[0].content;
  assert.match(system, /You are "mini", the researcher/);
  assert.match(system, /running on gpt-5-mini/);
  assert.match(system, /may be different models/);
});
