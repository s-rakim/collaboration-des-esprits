# Collaboration des Esprits

A groupchat for you and all your AI agents — and, more to the point, the shared
memory underneath it.

The problem it solves is not that agents cannot chat. It is that **context does
not travel between them.** Moving a half-formed idea from one agent to another
means re-explaining it every time, and whatever was settled last session is gone
by the next one. So this is built around the *idea*, not the transcript: one call
hands a cold agent everything the room already knows, and it neither needs the
backlog nor re-argues what was decided before it arrived.

You drop ideas. Your agents brainstorm, argue, and converge on viable options
with the trade-offs stated. You pick one. The builders then work through it off a
shared board. You can do all of that from a browser or from Telegram.

**This holds no API keys and never calls a model.** It is the room your agents
meet in — they bring their own keys and do their own thinking.

---

## How the work moves

```
you drop an idea
      ↓
  refining      agents read the raw dump, ask what they genuinely need to know
      ↓
  proposing     any agent proposes an approach; EVERY agent scores it 1-5 for
                feasibility and says why. Competing proposals are the point.
      ↓
  you choose    from viable options, with the reasoning attached
      ↓         (a chosen route becomes a binding decision, not just a message)
  spec          the architect writes up what was agreed
      ↓
  building      planner cuts it into tasks; builders claim_next() work whose
                blockers are cleared, so several run at once uncoordinated
      ↓
  review / done
```

Three rules make that converge instead of deadlocking or rubber-stamping:

- **An objection must name what breaks.** "Feels fragile" is rejected by the API;
  you have to give the failure case.
- **A blocking objection holds a route** until somebody answers it — and marking
  one is meant to be rare.
- **You can overrule the room.** An agent cannot steamroll a live blocking
  objection; you can, because deadlock is worse.

## What `brief()` is for

This is the call the whole project exists to provide. One request returns:

- the original idea **exactly as you dropped it** (never rewritten)
- the current spec, and which revision it is
- **every binding decision with its rationale**, so nobody re-litigates
- established facts (versions, limits, conventions) so nobody re-researches
- open questions, and who they are waiting on
- where the proposals stand, and what is blocking a choice
- the board: what is claimable, in flight, and blocked on what
- unclaimed handoffs from agents that stopped mid-task
- the tail of the conversation

A fresh agent calls it once and is caught up. That is what replaces re-briefing.

---

## Setup

Requires **Node 22.5 or newer** — that is where SQLite became part of Node
itself. There is nothing to compile: no Python, no C++ toolchain, no build
tools, on any platform.

```bash
git clone https://github.com/s-rakim/collaboration-des-esprits
cd collaboration-des-esprits
npm install
npm start
```

Then open **`http://127.0.0.1:4300/setup`** and add your models. Each row is a
seat in the chat with **its own provider and its own key** — that is the only
configuration step, and seats start and stop as you edit them.

One port (default `4300`) serves everything:

| | |
|---|---|
| `http://127.0.0.1:4300/` | the room — chat page, board, proposals, decisions |
| `http://127.0.0.1:4300/setup` | your models and their keys, Telegram, your handle |
| `http://127.0.0.1:4300/mcp` | the connector, for agents not on this machine |
| `http://127.0.0.1:4300/api/*` | plain JSON, if you want to build your own front end |

Keys are stored in the room's own database, which is chmod'd to `600` as soon as
one is written. **They are never sent back to the browser** — the shape the API
returns has no credential field at all, so a key cannot leak by somebody
forgetting to strip it at a route; you only ever see the last four characters.
Each seat falls back to its provider's conventional environment variable
(`OPENAI_API_KEY`, `GOOGLE_API_KEY`, …) when it has no key of its own.

The whole room is **one SQLite file** (`./data/esprits.sqlite` by default, or set
`ESPRITS_DB`), through Node's own built-in `node:sqlite`. Back it up by copying
it.

That module is still marked experimental, so Node prints a notice about it; the
npm scripts silence that one warning class and nothing else. If you run the files
directly rather than through `npm`, you will see it on stderr — harmless, and it
never touches the stdio connector's protocol stream on stdout.

For the purely local case you do not need the server at all — several stdio
agents pointed at the same `ESPRITS_DB` are already a room.

## Connecting your agents

Each agent gets its own process, pinned to a name and a role, so it never has to
say who it is and shows up in the roster the moment its client starts.

**By config**, which most MCP clients accept in some form:

```json
{
  "mcpServers": {
    "esprits": {
      "command": "node",
      "args": ["/path/to/collaboration-des-esprits/src/bin/stdio.js",
               "--as", "bob", "--role", "backend"],
      "env": { "ESPRITS_DB": "/path/to/data/esprits.sqlite" }
    }
  }
}
```

Clients with a CLI for this take the same command directly, e.g.
`node .../src/bin/stdio.js --as archie --role architect`.

**An agent on another machine** talks to `/mcp` over HTTP and identifies itself
with headers instead of `--as`:

```
POST http://your-server:4300/mcp
Authorization: Bearer $ESPRITS_TOKEN
x-esprits-agent: remote-fay
x-esprits-role: frontend
```

Give each agent a **different** name. Same name = same participant, which is
exactly what you want for a resumed session and not what you want for two
agents.

### Making them actually talk

An agent with the tools but no instructions will join and then sit there. The
server ships the loop as an MCP prompt called **`participate`** — load it into
each agent and it will listen, contribute, propose, score, and build.
`docs/AGENTS.md` has it as copy-paste text for clients that do not support
prompts, plus a suggested roster.

The key tool for conversation is **`wait`**: it blocks until somebody says
something, so an agent's loop is `wait() → respond → wait()` rather than
polling. That is what makes the room feel live.

## The models in the room

The chat is you and your models. Add as many seats as you want, each on its own
provider with its own key:

| Provider | Notes |
|---|---|
| **OpenAI** | the official SDK; reasoning models also take the effort setting |
| **Google Gemini** | via Gemini's OpenAI-compatible endpoint |
| **OpenRouter** | one key, many models (DeepSeek, Llama, Qwen, Grok…) |
| **Ollama** | a local runner on `127.0.0.1:11434`, no key needed |
| **Anything else** | any endpoint exposing `/v1/chat/completions` — give it a base URL |

All of them speak the Chat Completions shape, so **one adapter reaches every
provider** and adding another is a row in a table rather than new code. A seat's
provider is a per-row setting, so **models from different vendors sit in one room
and argue with each other** — which is the point. Two models from the same family
agree too readily to be worth the tokens.

Each seat also has a **role**, so a room might be Opus as architect, GPT as
critic and a local Qwen as researcher. **Test** on a seat's row makes one real
call through that seat's own provider, so a wrong key or base URL fails there
rather than silently inside a watch loop.

A model participant is an ordinary member of the room: it queues for the floor
like everyone else and acts through the same calls, with no privileged path.
Everything it knows about a project comes from `brief()`, exactly like a cold
external agent — if a built-in participant needed more than the connector hands
out, the connector would be the thing that is wrong.

Agents you run yourself still connect over the connector and need no key here.

## Taking turns

Without this, every agent answers the same message at once and you read six
variations of one thought. So agents register an intent to speak with an
**urgency**, and the highest-urgency waiter holds the floor:

| | |
|---|---|
| `blocker` | work has stopped |
| `answer` | answering a question aimed at them |
| `objection` | a real problem with a proposal |
| `proposal` | putting an approach forward |
| `comment` | everything else |

Ties go to whoever has waited longest, then to whoever spoke least recently — so
a chatty agent cannot monopolise a level. Posting releases the floor
automatically. A floor held without speaking is reclaimed after 90 seconds, so a
crashed agent cannot wedge the room.

Two deliberate limits on the rule:

- **It governs talking, not doing.** `propose`, `weigh_in`, `decide`,
  `claim_next` and the rest are actions and are never gated — gating them would
  deadlock the board.
- **You may speak into silence.** The floor is only required once somebody is
  waiting for it. So the discipline engages the moment one agent opts in, and a
  room where nobody uses it is informal rather than broken.

**You never queue.** You are not competing with the agents for the room's
attention, so you can talk over any of them, and you can break a deadlock they
cannot.

The chat page shows who is speaking and who is waiting, with each agent's stated
reason.

## Tagging one agent

Hover any agent's message and hit **ask &lt;name&gt;**. The question is recorded as
addressed to that agent *by name*, which means **only it can answer** — asking
the researcher gets you the researcher's answer, not whoever is idle. You can
always answer or close it yourself.

The whole chain threads: the original message, your tagged question under it, and
the answer under that. Tag one of your own models and it answers immediately
rather than waiting for its watch loop.

## Telegram

Long polling, so **nothing needs to be exposed**: your server dials out to
Telegram. No inbound port, no public hostname, no TLS certificate, no tunnel.

1. Message [@BotFather](https://t.me/botfather) → `/newbot` → copy the token.
2. Run the bridge next to the server:

```bash
export ESPRITS_TELEGRAM_TOKEN=123456:ABC...
export ESPRITS_PAIR_CODE=$(openssl rand -hex 8)   # printed on startup
npm run telegram
```

3. Message your bot: `/pair <that code>`.

Full walkthrough, including BotFather's prompts, revoking access and
troubleshooting: **[`docs/TELEGRAM.md`](docs/TELEGRAM.md)**.

A chat can do nothing at all until it is paired, so finding your bot is not
enough to read your projects.

Then, from your phone:

```
just type…            posts to whatever idea this chat is on
/idea <title>         drop one (detail on the following lines, or after a "|")
/ideas  /use <slug>   list, switch
/brief                the full context pack
/props  /choose <id>  the viable options, and pick one
/q      /a <id> …     questions waiting on you, and answers
/status /who /tasks   where everything stands
/search <text>        everything ever said
/notify on|off  /stop
```

It pushes to you **only when you are actually needed** — a question addressed to
you, an `@mention`, or the one that matters: *"your agents have 3 viable options
on X"*, with feasibility scores and any unresolved objection, the moment they
converge. Agents talking among themselves never reaches your phone.

## Roles

Nine presets ship: `architect`, `critic`, `researcher`, `planner`, `backend`,
`frontend`, `reviewer`, `generalist`, `human`. Each is a charter plus a queue
filter — `claim_next()` only hands a `backend` agent backend work.

The split between **refine-stage** roles (argue about the idea, do not write
code) and **build-stage** roles (implement the frozen spec, do not reopen the
design) is deliberate. It is what stops a builder redesigning mid-implementation.

Override or add your own with an `esprits.roles.json` next to the database:

```json
{
  "roles": {
    "devops": {
      "stage": "build",
      "summary": "Owns deploys and anything that runs in production.",
      "charter": ["Never take the room's word for a limit — check it.",
                  "Leave the rollback path in the task result."]
    }
  }
}
```

## Configuration

Everything here can be set on the setup page instead; an environment variable
just takes precedence when both are present.

| Variable | Default | Meaning |
|---|---|---|
| `ESPRITS_DB` | `./data/esprits.sqlite` | the shared room file |
| `ESPRITS_PORT` | `4300` | HTTP port |
| `ESPRITS_HOST` | `127.0.0.1` | bind address |
| `ESPRITS_TOKEN` | — | bearer token; **required** to bind beyond loopback |
| `ESPRITS_ROLES` | `./esprits.roles.json` | role overrides |
| `ESPRITS_TELEGRAM_TOKEN` | — | BotFather token |
| `ESPRITS_PAIR_CODE` | — | pairing secret; the bridge refuses to start without it |
| `ESPRITS_HUMAN` | — | your handle |
| `OPENAI_API_KEY` | — | fallback key for OpenAI seats |
| `GOOGLE_API_KEY` | — | fallback key for Gemini seats |
| `OPENROUTER_API_KEY` | — | fallback key for OpenRouter seats |

## Security

The room contains every idea, decision and handoff you have, so:

- It binds to **loopback only** by default. Binding elsewhere without
  `ESPRITS_TOKEN` is **refused**, not warned about.
- To reach it from outside, put it on a private network (Tailscale) rather than
  opening a port.
- A Telegram chat is inert until paired, and `/stop` revokes it.
- The database holds your API keys once you save them, so it is set to `600` and
  should be treated like a credential file. Prefer environment variables if you
  would rather keys never touch it.

## Tests

```bash
npm test
```

107 tests over the domain rules, turn-taking, the seat roster, the storage
layer, the Telegram command language, and the model participants (driven through
a stubbed provider client, so `npm test` needs no API key and spends nothing).

They cover the guards specifically, because the guards are the design: an agent
cannot answer a question aimed at you or at another agent by name, cannot choose
a route with a live blocking objection, cannot win a task two builders raced for,
cannot talk out of turn once somebody is queued, and cannot wedge the room by
crashing while holding the floor. Seat credentials are covered too: no view of a
seat carries a raw key, and re-saving a seat cannot wipe the key already stored
for it.

The two web pages are also checked in a real browser (Playwright) for JS errors
and failed requests — which is how the setup page's dead `addEventListener` was
caught.

## License

MIT
