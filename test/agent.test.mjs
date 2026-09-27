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
/** Stands in for the Anthropic SDK client the adapter builds. */
function scripted(turns) {
  let i = 0;
  const calls = [];
  const client = {
    apiKey: 'sk-test',
    beta: {
      messages: {
        stream(params) {
          // Snapshot: the loop mutates the same messages array in place, so a
          // stored reference would read as the final state of the conversation
          // rather than what this request actually carried.
          calls.push({ ...params, messages: structuredClone(params.messages) });
          const turn = turns[Math.min(i++, turns.length - 1)];
          return { finalMessage: async () => turn };
        },
      },
    },
  };
  return { client, calls };
}

/** Stands in for the OpenAI-compatible client, which every other provider uses. */
function scriptedOpenai(turns) {
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

const oaiMsg = (content, toolCalls = [], finish = 'stop') => ({
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

const msg = (content, stop_reason = 'tool_use') => ({ content, stop_reason, model: 'claude-opus-5' });
const use = (name, input) => ({ type: 'tool_use', id: `tu_${name}`, name, input });

function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  hub.join({ name: 'crit', role: 'critic' });
  return { hub };
}

const SEAT = {
  name: 'claude', provider: 'anthropic', model: 'claude-opus-5',
  role: 'architect', effort: 'high', maxTokens: 64000,
};

const participant = ({ hub }, turns, log = () => {}, seat = SEAT) => {
  const { client, calls } = scripted(turns);
  const p = createModelParticipant({
    hub, seat, log, getKey: () => 'sk-test', createClient: () => client,
  });
  return { p, calls };
};

const openaiParticipant = ({ hub }, turns, seat) => {
  const { client, calls } = scriptedOpenai(turns);
  const p = createModelParticipant({
    hub, seat, log: () => {}, getKey: () => 'sk-test', createClient: () => client,
  });
  return { p, calls };
};

test('a reply tool call becomes a real message in the room', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Digest emails', raw: 'email me a summary', by: 'rakim' });
  const { p } = participant(ctx, [msg([use('reply', { body: 'Cheapest path is a nightly cron.' })])]);

  const r = await p.askDirect({ body: 'how would you build this?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['reply']);

  const said = ctx.hub.db.prepare('SELECT author, body, kind FROM messages WHERE author = ? ORDER BY id DESC').get('claude');
  assert.equal(said.body, 'Cheapest path is a nightly cron.');
  assert.equal(said.kind, 'message');
});

test('the brief is what gets sent as context, not a bare question', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Context check', raw: 'THE ORIGINAL DUMP', by: 'rakim' });
  ctx.hub.decide({ idea: idea.slug, choice: 'sqlite over postgres', rationale: 'no daemon', by: 'crit' });
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])]);

  await p.askDirect({ body: 'thoughts?', idea: idea.slug, from: 'rakim' });
  const sent = calls[0].messages[0].content;
  assert.match(sent, /THE ORIGINAL DUMP/, 'carries the original idea');
  assert.match(sent, /sqlite over postgres/, 'carries the decisions');
  assert.match(sent, /no daemon/, 'carries the reasoning');
  assert.match(sent, /thoughts\?/, 'and the actual question');
});

test('the request uses the seat\u2019s model, adaptive thinking and effort', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Params', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])], () => {}, { ...SEAT, effort: 'max' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  const req = calls[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.deepEqual(req.output_config, { effort: 'max' });
  assert.equal(req.fallbacks, 'default');
  assert.ok(req.betas.includes('server-side-fallback-2026-07-01'), 'fallbacks need their beta flag');
  assert.ok(req.tools.some((t) => t.name === 'propose'));
});

test('an invalid effort falls back instead of 400ing on every wake', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Bad effort', raw: '', by: 'rakim' });
  const notes = [];
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])], (m) => notes.push(m), { ...SEAT, effort: 'extremely-high' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(calls[0].output_config, { effort: 'high' });
  assert.ok(notes.some((n) => /not a valid effort/.test(n)), 'and says so rather than failing quietly');
});

test('a propose tool call creates a scoreable proposal', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Routes', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [
    msg([use('propose', { title: 'Cron + SMTP', approach: 'nightly job', effort: 'S', risks: 'deliverability' })]),
  ]);

  await p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  const st = ctx.hub.standing({ idea: idea.slug }).contests[0];
  assert.equal(st.ranked.length, 1);
  assert.equal(st.ranked[0].title, 'Cron + SMTP');
  assert.equal(st.ranked[0].author, 'claude');
});

test('weigh_in scores another agent and the loop continues to a reply', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Scoring', raw: '', by: 'rakim' });
  const theirs = ctx.hub.propose({ idea: idea.slug, title: 'Their route', approach: 'x', by: 'crit' });
  const { p } = participant(ctx, [
    msg([use('weigh_in', { proposal: theirs.id, stance: 'endorse', feasibility: 4, reasoning: 'no new infra' })]),
    msg([use('reply', { body: 'Scored it — workable.' })]),
  ]);

  const r = await p.askDirect({ body: 'what do you think of that?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['weigh_in', 'reply']);
  const scored = ctx.hub.getProposal(theirs.id);
  assert.equal(scored.endorsements, 1);
  assert.equal(scored.feasibility, 4);
  assert.ok(scored.assessments.some((a) => a.agent === 'claude'));
});

test("a rejected action is handed back so it can correct itself, not swallowed", async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Recovery', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [
    // Scoring a proposal that does not exist must fail.
    msg([use('weigh_in', { proposal: 9999, stance: 'endorse', reasoning: 'x' })]),
    msg([use('reply', { body: 'That proposal is gone; here is my own view instead.' })]),
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
    msg([{ type: 'text', text: 'I think a queue is overkill here.' }], 'end_turn'),
  ]);

  const r = await p.askDirect({ body: 'queue or not?', idea: idea.slug, from: 'rakim' });
  assert.deepEqual(r.actions, ['reply']);
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('I think a queue is overkill here.'));
});

test('a refusal is reported and nothing is posted', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Refused', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg([], 'refusal')]);

  const r = await p.askDirect({ body: 'something declined', idea: idea.slug, from: 'rakim' });
  assert.equal(r.refused, true);
  assert.equal(ctx.hub.db.prepare("SELECT COUNT(*) n FROM messages WHERE author = 'claude'").get().n, 0);
});

test('hitting max_tokens is reported rather than posting a half sentence', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Truncated', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg([{ type: 'text', text: 'I was saying that' }], 'max_tokens')]);

  const r = await p.askDirect({ body: 'go on', idea: idea.slug, from: 'rakim' });
  assert.equal(r.truncated, true);
});

test('a runaway tool loop is capped', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Runaway', raw: '', by: 'rakim' });
  // Always answers with a non-terminal action, so only the cap stops it.
  const { p, calls } = participant(ctx, [msg([use('remember', { key: 'k', value: 'v' })])]);

  const r = await p.askDirect({ body: 'loop', idea: idea.slug, from: 'rakim' });
  assert.equal(r.exhausted, true);
  assert.ok(calls.length <= 6, `expected the cap to hold, got ${calls.length} requests`);
});

test('the participant queues for the floor like any other agent', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Manners', raw: '', by: 'rakim' });
  const { p } = participant(ctx, [msg([use('reply', { body: 'my turn now' })])]);

  // crit holds the floor and then releases it while Claude is waiting.
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

test("a seat with no key says so, naming itself and its provider", async () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const p = createModelParticipant({
    hub,
    seat: { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' },
    getKey: () => null,
  });
  await assert.rejects(() => p.askDirect({ body: 'hi', from: 'rakim' }), /no API key for gpt \(OpenAI\)/);
});

// ------------------------------------------------- several providers, one room

test('an OpenAI-shaped seat drives the same room through the other adapter', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Cross provider', raw: 'settle this', by: 'rakim' });
  const { p, calls } = openaiParticipant(
    ctx,
    [oaiMsg(null, [{ name: 'propose', input: { title: 'GPT route', approach: 'do it this way' } }]),
     oaiMsg('Proposed it.')],
    { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic', effort: 'high' },
  );

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
  const { p, calls } = openaiParticipant(
    ctx,
    [oaiMsg(null, [{ name: 'weigh_in', input: { proposal: theirs.id, stance: 'endorse', feasibility: 4, reasoning: 'fine' } }]),
     oaiMsg(null, [{ name: 'reply', input: { body: 'scored it' } }])],
    { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' },
  );

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
      oaiMsg('Second try: here is my view.'),
    ];
    const client = { chat: { completions: { create: async (p) => { calls.push(p); return turns[Math.min(i++, 1)]; } } } };
    return { client, calls };
  })();

  const p = createModelParticipant({
    hub: ctx.hub,
    seat: { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' },
    getKey: () => 'sk-test',
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
  const { p } = openaiParticipant(ctx, [oaiMsg(null, [], 'content_filter')],
    { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' });

  const r = await p.askDirect({ body: 'x', idea: idea.slug, from: 'rakim' });
  assert.equal(r.refused, true);
});

test('a truncated OpenAI response is reported rather than posted half-finished', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Cut off', raw: '', by: 'rakim' });
  const { p } = openaiParticipant(ctx, [oaiMsg('I was saying that', [], 'length')],
    { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' });

  const r = await p.askDirect({ body: 'go on', idea: idea.slug, from: 'rakim' });
  assert.equal(r.truncated, true);
});

test('models from different providers argue with each other in one room', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Mixed room', raw: 'pick an approach', by: 'rakim' });

  const opus = participant(ctx, [msg([use('propose', { title: 'Claude route', approach: 'a' })])], () => {},
    { name: 'opus', provider: 'anthropic', model: 'claude-opus-5', role: 'architect', effort: 'high' });
  const gpt = openaiParticipant(ctx,
    [oaiMsg(null, [{ name: 'weigh_in', input: { proposal: 1, stance: 'object', feasibility: 2, reasoning: 'breaks on retries', blocking: true } }]),
     oaiMsg('Objected.')],
    { name: 'gpt', provider: 'openai', model: 'gpt-5.2', role: 'critic' });

  await opus.p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  await gpt.p.askDirect({ body: 'is that sound?', idea: idea.slug, from: 'rakim' });

  const proposal = ctx.hub.getProposal(1);
  assert.equal(proposal.author, 'opus');
  assert.equal(proposal.choosable, false, 'the other provider blocked it');
  assert.deepEqual(proposal.blockingObjections.map((o) => o.agent), ['gpt']);

  // Each went to its own provider with its own model.
  assert.equal(opus.calls[0].model, 'claude-opus-5');
  assert.equal(gpt.calls[0].model, 'gpt-5.2');
});

test('several models sit in one room under their own names and models', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Two minds', raw: 'settle this', by: 'rakim' });

  const opus = participant(ctx, [msg([use('propose', { title: 'Route A', approach: 'do it this way' })])],
    () => {}, { name: 'opus', model: 'claude-opus-5', role: 'architect', effort: 'high' });
  const sonnet = participant(ctx, [msg([use('weigh_in', { proposal: 1, stance: 'object', feasibility: 2, reasoning: 'falls over on empty input', blocking: true })])],
    () => {}, { name: 'sonnet', model: 'claude-sonnet-5', role: 'critic', effort: 'medium' });

  await opus.p.askDirect({ body: 'how?', idea: idea.slug, from: 'rakim' });
  await sonnet.p.askDirect({ body: 'is that sound?', idea: idea.slug, from: 'rakim' });

  // Each seat is its own participant in the roster.
  const roster = ctx.hub.roster().map((a) => `${a.name}:${a.model}`);
  assert.ok(roster.includes('opus:claude-opus-5'));
  assert.ok(roster.includes('sonnet:claude-sonnet-5'));

  // And they genuinely disagree: one proposed, the other blocked it.
  const p = ctx.hub.getProposal(1);
  assert.equal(p.author, 'opus');
  assert.equal(p.choosable, false);
  assert.deepEqual(p.blockingObjections.map((o) => o.agent), ['sonnet']);

  // Each sent its own model and effort.
  assert.equal(opus.calls[0].model, 'claude-opus-5');
  assert.deepEqual(opus.calls[0].output_config, { effort: 'high' });
  assert.equal(sonnet.calls[0].model, 'claude-sonnet-5');
  assert.deepEqual(sonnet.calls[0].output_config, { effort: 'medium' });
});

test('a model is told which model it is and that the others differ', async () => {
  const ctx = room();
  const idea = ctx.hub.dropIdea({ title: 'Identity', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])], () => {},
    { name: 'haiku', model: 'claude-haiku-4-5', role: 'researcher', effort: 'low' });

  await p.askDirect({ body: 'hi', idea: idea.slug, from: 'rakim' });
  assert.match(calls[0].system, /You are "haiku", the researcher/);
  assert.match(calls[0].system, /running on claude-haiku-4-5/);
  assert.match(calls[0].system, /may be different models/);
});
