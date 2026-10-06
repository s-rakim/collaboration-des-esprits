import { chatAdapter } from './participants/chat.js';

/**
 * Running a swarm: one goal, split into pieces, worked in parallel, merged.
 *
 * This is the opposite discipline to the room. In the chat, agents take turns
 * because a person is reading along. A swarm is nobody watching and everything
 * at once — so there is no floor, no queue, and the only coordination is the
 * atomic claim that stops two workers taking the same piece.
 *
 * Three phases, each a plain model call, so the mechanism works on any endpoint
 * that can hold a conversation:
 *   plan       — split the goal into independent pieces
 *   fan out    — workers run concurrently, bounded by the worker count
 *   merge      — one call that reads every result and writes the answer
 */

const PLANNER_SYSTEM = [
  'You break a goal into independent pieces of work for parallel workers.',
  '',
  'Rules that matter:',
  '- Every piece must stand alone. Workers cannot see each other or talk, so a piece that',
  '  depends on another piece\'s answer is a broken piece.',
  '- Cover the goal completely and without overlap. Two workers doing the same thing is waste.',
  '- Between 2 and the requested number of pieces. Fewer is fine if the goal is small;',
  '  inventing filler work to reach a number is not.',
  '- Each prompt must be self-contained: restate whatever context the worker needs, because',
  '  it gets nothing but that prompt.',
].join('\n');

const WORKER_SYSTEM = [
  'You are one worker in a parallel swarm. You have exactly one piece of a larger goal.',
  '',
  'Answer only your piece. Do not restate the goal, do not preamble, do not speculate about',
  'what the other workers are doing — your answer is going to be merged with theirs, so',
  'anything that is not your finding is noise somebody has to strip out.',
  'Be concrete and specific. If you genuinely cannot do your piece, say so in one line and',
  'say why, rather than producing something plausible and empty.',
].join('\n');

const MERGER_SYSTEM = [
  'You are merging the findings of a swarm of workers into one answer.',
  '',
  'Write the answer to the original goal, not a summary of who did what. Use the findings',
  'as material. Where workers disagree, say so and say which is better supported. Where a',
  'piece failed, note the gap rather than papering over it — a confident answer with a',
  'silent hole in it is worse than an honest one.',
].join('\n');

/** JSON from a model may arrive fenced or with prose around it. */
function parsePlan(text, max) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('the planner did not return a list of pieces');

  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error('the planner returned something that is not valid JSON');
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('the planner returned no pieces');

  return parsed.slice(0, max).map((p, i) => ({
    title: String(p?.title ?? `Piece ${i + 1}`).slice(0, 200),
    prompt: String(p?.prompt ?? p ?? '').trim(),
  })).filter((p) => p.prompt);
}

export function createSwarmRunner({ hub, seats, log = () => {}, createClient = null }) {
  const running = new Map(); // runId -> AbortController-ish flag

  /** One model call, no tools, returning text. */
  async function ask({ resolved, system, prompt, maxTokens = 8000 }) {
    const adapter = chatAdapter({
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens,
      effort: resolved.effort ?? 'medium',
      effortParam: resolved.effortParam,
      tokenParam: resolved.tokenParam,
      baseURL: resolved.baseURL,
      createClient,
    });
    const turn = adapter.startTurn({ system, tools: [] });
    const step = await turn.send(prompt);
    if (step.stopReason === 'refusal') throw new Error('the model declined this piece');
    return step.text ?? '';
  }

  /**
   * Run a swarm to completion. Returns when everything is merged or failed.
   * Progress is written to the database as it goes, so a page can poll it.
   */
  async function run({ id, plan = null }) {
    const started = hub.getSwarm(id);
    const resolved = seats.resolve(started.seat);
    if (!resolved) throw new Error(`the swarm's seat "${started.seat}" has no usable connection`);
    running.set(id, { cancelled: false });

    try {
      // ---- plan ----
      if (!started.total || plan) {
        const pieces = plan ?? parsePlan(
          await ask({
            resolved,
            system: PLANNER_SYSTEM,
            prompt:
              `Goal:\n${started.goal}\n\n` +
              `Split this into at most ${started.workers} independent pieces.\n` +
              `Reply with JSON only: [{"title": "...", "prompt": "..."}]`,
            maxTokens: 4000,
          }),
          started.workers,
        );
        hub.planSwarm({ id, tasks: pieces });
        log(`swarm ${id}: planned ${pieces.length} piece(s)`);
      }

      // ---- fan out ----
      const run0 = hub.getSwarm(id);
      const width = Math.min(run0.workers, run0.total);
      const worker = async (n) => {
        for (;;) {
          if (running.get(id)?.cancelled) return;
          const piece = hub.claimSwarmTask({ runId: id });
          if (!piece) return; // nothing left; this worker is done
          try {
            const result = await ask({
              resolved,
              system: WORKER_SYSTEM,
              prompt: `The overall goal, for context only:\n${run0.goal}\n\nYour piece:\n${piece.prompt}`,
            });
            hub.finishSwarmTask({ taskId: piece.id, result });
            log(`swarm ${id}: worker ${n} finished piece ${piece.seq + 1}/${run0.total}`);
          } catch (err) {
            // One piece failing must not take the swarm down; it is recorded as
            // a gap and the merge is told about it.
            hub.finishSwarmTask({ taskId: piece.id, error: err.message });
            log(`swarm ${id}: piece ${piece.seq + 1} failed — ${err.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: width }, (_, n) => worker(n + 1)));

      if (running.get(id)?.cancelled) return hub.getSwarm(id);

      // ---- merge ----
      const finished = hub.getSwarm(id);
      const done = finished.tasks.filter((t) => t.status === 'done');
      const failed = finished.tasks.filter((t) => t.status === 'failed');
      if (!done.length) {
        return hub.finishSwarm({ id, error: 'every piece failed', status: 'failed' });
      }

      const synthesis = await ask({
        resolved,
        system: MERGER_SYSTEM,
        maxTokens: 16000,
        prompt: [
          `Goal:\n${finished.goal}`,
          '',
          '## Findings',
          ...done.map((t) => `### ${t.title || `Piece ${t.seq + 1}`}\n${t.result}`),
          ...(failed.length
            ? ['', '## Pieces that failed — note these as gaps',
               ...failed.map((t) => `- ${t.title || `Piece ${t.seq + 1}`}: ${t.error}`)]
            : []),
        ].join('\n'),
      });

      // The answer is worth keeping as a document rather than a chat message.
      let artifactSlug = null;
      try {
        const art = hub.saveArtifact({
          title: finished.goal.slice(0, 120),
          content: synthesis,
          kind: 'markdown',
          idea: finished.idea,
          summary: `swarm of ${finished.total} pieces`,
          by: finished.createdBy,
        });
        artifactSlug = art.slug;
      } catch (err) {
        log(`swarm ${id}: could not save the write-up — ${err.message}`);
      }

      log(`swarm ${id}: merged ${done.length}/${finished.total}`);
      return hub.finishSwarm({ id, synthesis, artifactSlug });
    } catch (err) {
      log(`swarm ${id}: failed — ${err.message}`);
      return hub.finishSwarm({ id, error: err.message, status: 'failed' });
    } finally {
      running.delete(id);
    }
  }

  return {
    run,
    cancel: (id) => {
      const r = running.get(id);
      if (r) r.cancelled = true;
      return hub.cancelSwarm({ id });
    },
    isRunning: (id) => running.has(id),
  };
}
