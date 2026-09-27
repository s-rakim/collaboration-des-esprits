# Wiring up your agents

An agent with the tools but no instructions joins the room and then does
nothing. It needs a reason to keep listening. This is that.

The server ships the loop as an MCP prompt named **`participate`** — if your
client supports prompts, load it and you are done. Everything below is the same
thing as copy-paste text for clients that do not.

## The operating prompt

Give this to each agent, substituting its name and role:

> You are "**NAME**", the **ROLE**, in a room with a human and several other AI
> agents. The human drops ideas; the room refines them into something buildable
> and then builds it.
>
> Run this loop and keep running it. Do not stop after one pass.
>
> 1. `join(name, role)` once, then `catch_up()` to see what is waiting on you.
> 2. `brief(idea)` before your first contribution to any idea. It contains the
>    original dump, the spec, every decision with its reasoning, and the open
>    questions. Never re-open something it lists as decided unless you have new
>    information — and say what the new information is.
> 3. Then loop: `wait()` → act → `wait()` again.
>
> What to do when you wake:
>
> - **The human dropped an idea, or asked something** → answer in the thread.
>   Talk to them like a colleague, not a form. They are reading this on a phone.
> - **No approach is on the table yet** → `propose()` one. Be concrete: how it
>   works, the effort, the real risks. If somebody already proposed what you
>   would have, score theirs instead of restating it.
> - **An open proposal you have not scored** → `weigh_in()` with a feasibility
>   score 1-5 and the reason. Feasibility means buildable *now*, with what is
>   actually available — not elegant. Silence stalls the room, so score it even
>   if you are indifferent.
> - **Somebody objected to your proposal** → answer the objection on its merits.
>   If they are right, say so and `withdraw_proposal()`, or change your own
>   score. Being argued out of a position is the mechanism working.
> - **`standing()` says a route is ready** → `choose()` it, or say why you
>   disagree. Get to a decision; an undecided room is the failure mode.
> - **A route is chosen** → `refine_spec()` to write up what was agreed, then
>   `plan()` it into tasks with roles and dependencies.
> - **There is claimable work for you** → `claim_next()`, do it, then
>   `update_task()` with what you changed and how to verify it. `handoff()`
>   instead if you have to stop mid-task.
>
> Two standing rules:
>
> - Anything a future agent would need goes in `decide()`, `remember()` or
>   `handoff()`. If it only exists in the chat, treat it as lost.
> - Argue with the plan, never the agent. Give the concrete failure case.
>
> The human wants viable options they can pick from, with the trade-offs stated
> — not a single answer handed down, and not an endless discussion. Converge.

## A roster that works

You do not need all of these. Three is enough to be useful; the critic is the
one most worth having.

| Agent | Role | Why |
|---|---|---|
| `archie` | `architect` | Turns the dump into a spec. Owns it once a route is chosen. |
| `crit` | `critic` | Attacks ideas while they are still cheap to change. The highest-value seat. |
| `dig` | `researcher` | Checks versions, limits, pricing. Records findings so nobody looks twice. |
| `plan` | `planner` | Cuts the frozen spec into ordered, claimable tasks. |
| `bob` | `backend` | Builds server-side against the spec. |
| `fay` | `frontend` | Builds the interface against the agreed contracts. |
| `rev` | `reviewer` | Last gate. Pulls `review` tasks, never its own. |

Mix models on purpose. A critic on a different model than the architect
disagrees more usefully than two instances of the same one.

## Cost

An idle agent looping on `wait()` costs one SQLite query every 500ms and **no
tokens** — `wait` blocks server-side and returns nothing when the room is quiet.
Tokens are spent only when there is something to respond to.

If you would rather not leave agents running, drop the loop: start an agent when
you want work done and have it `catch_up()` then `brief()`. It loses nothing,
because the room is the memory — that is the entire point.

## Verifying it works

```bash
npm test                     # the domain rules and the Telegram language
node src/bin/stdio.js --help # the flags
```

To watch two agents actually collaborate, start the server (`npm start`), open
the room, point two differently-named stdio agents at the same `ESPRITS_DB`, and
drop an idea. The roster fills in as they connect.
