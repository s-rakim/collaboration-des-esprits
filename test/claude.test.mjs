import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createConfig } from '../src/settings.js';
import { createClaudeParticipant } from '../src/participants/claude.js';

/**
 * The participant is exercised with a stubbed SDK client: the point of these
 * tests is that a tool call coming back from the model lands in the room as the
 * real thing, and that the failure paths do not lose the reply.
 */
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

const msg = (content, stop_reason = 'tool_use') => ({ content, stop_reason, model: 'claude-opus-5' });
const use = (name, input) => ({ type: 'tool_use', id: `tu_${name}`, name, input });

function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  hub.join({ name: 'crit', role: 'critic' });
  const config = createConfig(hub.db);
  config.setSecret('anthropic_api_key', 'sk-test');
  config.set('claude_enabled', 'true');
  return { hub, config };
}

const participant = ({ hub, config }, turns, log = () => {}) => {
  const { client, calls } = scripted(turns);
  const p = createClaudeParticipant({ hub, config, log, createClient: () => client });
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

test('the request uses the configured model, adaptive thinking and effort', async () => {
  const ctx = room();
  ctx.config.set('claude_effort', 'max');
  const idea = ctx.hub.dropIdea({ title: 'Params', raw: '', by: 'rakim' });
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])]);

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
  ctx.config.set('claude_effort', 'extremely-high');
  const idea = ctx.hub.dropIdea({ title: 'Bad effort', raw: '', by: 'rakim' });
  const notes = [];
  const { p, calls } = participant(ctx, [msg([use('say_nothing', {})])], (m) => notes.push(m));

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

test('no API key is a clear error, not a crash', async () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const config = createConfig(hub.db);
  const { p } = participant({ hub, config }, [msg([use('say_nothing', {})])]);
  await assert.rejects(() => p.askDirect({ body: 'hi', from: 'rakim' }), /no Anthropic API key/);
});
