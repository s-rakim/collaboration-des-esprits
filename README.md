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

## Running it somewhere else

The room is one process and one SQLite file, so "somewhere else" is a box you
can SSH into. What changes is who can reach it.

### On a tailnet (the good option)

A tailnet already answers the question a password is usually there to answer —
which devices are yours — and it encrypts the hop, which plain HTTP does not.
Two ways, and the first is better:

**Let Tailscale do the serving.** The room stays on loopback and never listens
on a network at all:

```bash
npm start                      # still 127.0.0.1:4300, still no token
tailscale serve --bg 4300      # now https://<machine>.<tailnet>.ts.net
```

Nothing else changes. You get a real HTTPS certificate, the port is never open
to anything but your tailnet, and if you turn Tailscale off it is unreachable
rather than merely unauthenticated.

**Or bind the tailnet address yourself**, if you would rather not use `serve`:

```bash
ESPRITS_HOST=$(tailscale ip -4) npm start
```

That is allowed without a token, because a private address is already behind
something that decides who may reach it — the room says as much at startup. Add
`ESPRITS_TOKEN` as well if other people are on your tailnet.

### Anywhere else

Binding `0.0.0.0` without `ESPRITS_TOKEN` is refused, and that refusal is not
being precious: this database holds every API key you have pasted in, in plain
text, next to every idea and decision the room has recorded.

```bash
ESPRITS_HOST=0.0.0.0 ESPRITS_TOKEN=$(openssl rand -hex 24) npm start
```

Put it behind something that terminates TLS. A token over plain HTTP is a token
anybody on the path can read.

### Signing in

With a token set, a browser is sent to `/unlock`, where the token goes in once
and comes back as an httpOnly cookie good for thirty days. This is not
decoration: `EventSource`, `<img src>` and a plain link cannot carry an
`Authorization` header, so a header-only room would have had a dead live feed and
broken images. Scripts and the MCP connector keep using
`Authorization: Bearer <token>` as before.

`POST /lock` signs the browser out. `/health` stays open, so a monitor can watch
the room without holding the secret.

### What still lives on the machine

The database — and therefore your keys — sits next to the process, unencrypted.
Whoever can read that file has your keys, wherever that file is. That argues for
a box you control over a shared host, and for a separate set of keys if you are
putting it somewhere you do not.

## If it is not working

Three things account for almost every "it does not work", and the app now says
so itself rather than leaving you to guess:

- **A seat with no connection.** The room ships with two seats, `architect` and
  `critic`, as a hint at the shape. They start with no connection and no key, and
  the setup page says which seats are stuck on what — `architect, critic have no
  connection yet — pick one`. Pick one and that seat joins the chat.
- **A key on the connection, not on the seat.** Keys live on connections. A seat
  points at a connection and inherits its key, so a seat pointing at nothing has
  no key however many you have pasted in.
- **A base URL without `/v1`, or a model named the way the website names it.**
  These were the two guesses in every new connection, and getting either wrong
  produced an error from somebody else's server about somebody else's field
  names. Press **find** on the row instead: it asks the endpoint, repairs the
  URL if one of the obvious variants is the answer, and fills the model box with
  the ids that endpoint will actually accept. `Gemini 3.1 Pro` is a name on a
  web page; `gemini-3-pro` is what the API answers to, and now you pick from a
  list rather than guessing which.

  **test** still makes one real call, for when you want to be sure.

If the room is silent after all that, the note under the seats on the setup page
says how many models are in the chat and what is keeping the rest out.

One more, which only bites after you rebuild the room: your browser remembers
your handle against the *address*, not against the database behind it. Point it
at a room whose database has been replaced and it goes on insisting you are
somebody that room has never heard of. The page now checks on load and rejoins
you, so this should not reach you — but if you ever see `call join first`, that
is what it was.

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
| `http://127.0.0.1:4300/` | the room — chat, board, proposals, decisions, search |
| `http://127.0.0.1:4300/work` | swarm runs — parallel work, with live progress |
| `http://127.0.0.1:4300/artifacts` | what the room has produced, with version history |
| `http://127.0.0.1:4300/design` | everything generated, with the prompts |
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

## Connections — your keys

Everything the room can reach is a **connection** you define: a name, a URL, a
key, and what it is for. Nothing is a fixed list. Presets fill the boxes in for
OpenAI, Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Ollama and LM Studio,
but you can type your own URL and model for anything that isn't there — a
provider that launches next month needs no change to this code.

Add as many as you want, including several from one provider under different
names. A connection is used for one of:

| Kind | Endpoint shape | What it does |
|---|---|---|
| **Chat model** | `/chat/completions` | takes a seat in the room and talks |
| **Speech to text** | `/audio/transcriptions` | turns what you say into messages |
| **Text to speech** | `/audio/speech` | reads replies back |
| **Image generation** | `/images/generations` | makes images, for you or an agent |
| **Video generation** | varies — see below | makes video |

Keys live in the room's database and are never sent back to the page; you see
only the last four characters. Each also falls back to an environment variable
named after it (`ESPRITS_KEY_MY_GROQ` for a connection called "my groq"), so a
key set in your shell needs no typing.

**Test** on a row makes one real call and reports what came back.

## The models in your chat

Each seat points at a chat connection and takes **any model string that endpoint
accepts** — the model box is free text, so a model released tomorrow works
today. Leave it blank to use the connection's default.

Mix providers on purpose. Two models from the same family agree too readily to
be worth the tokens; a critic on a different provider than the architect
disagrees far more usefully.

## Work — the swarm

The chat is agents taking turns because you are reading along. **Work** is the
opposite discipline: nobody watching, everything at once.

Hand over a goal and a worker count. One model call splits it into independent
pieces, the workers run those **in parallel**, and a final call merges every
finding into one answer — saved as an artifact, not left in a scrollback. The
page shows each piece going from queued to running to done as it happens, and
what the run produced.

There is no floor and no queue here. The only coordination is an atomic claim
that stops two workers taking the same piece.

It suits jobs that genuinely split: surveying many things, checking many cases,
drafting many sections. A job whose steps depend on each other belongs in the
chat, because a worker cannot see what another worker found.

One piece failing does not fail the run — it is recorded as a gap, the merge is
told about it, and you can retry that piece alone. Every piece failing does fail
the run, rather than merging nothing and calling it an answer.

## Artifacts — what the room produces

Work that somebody would want to open again does not belong in a transcript, so
agents write it with `save_artifact` instead of pasting it into the chat. Each
artifact is a document, a spec, a file of code or a page, addressed by slug and
**versioned on every write** — revising is safe because the previous text is
never lost, and any version can be restored (as a new version, so the history
stays honest).

The Artifacts page renders Markdown, syntax-preserved code, and HTML in a
sandboxed frame. That sandbox matters: an artifact is written by a model, so it
renders with no scripting and no access to the page around it.

## Projects

A container for related ideas with standing context they all inherit — the
stack, the constraints, who it is for. `brief()` hands an agent the project's
context alongside the idea's own, so "we never add a cloud dependency" is stated
once rather than in every thread.

## Files

**＋ File** attaches anything to the thread. The text is extracted on the way in
so agents can read it with `read_file` without each of them fetching and parsing
the file.

Plain text, code and data formats come through as themselves. **PDF, Word,
Excel and PowerPoint are parsed** — with no dependency and nothing to compile,
because the Office formats are zipped XML and a PDF is a container of deflated
streams. A Word document keeps its paragraphs, tabs and tables; a workbook comes
through one sheet at a time with its columns aligned, so a number stays under its
heading; a deck arrives one block per slide; a PDF is read through its ToUnicode
maps, so a subset font reads as words rather than as gibberish.

What it will not do is guess. A scanned PDF has no text in it, and the room is
told exactly that rather than handed whatever punctuation survived. Anything in
a format we cannot read is kept and linked, and labelled as such.

## Scheduled

Standing work: a message fired into the room on a repeat, addressed to everyone
so the agents wake and act on it. Either a daily wall-clock time or an interval
in minutes. **run** fires one immediately, which is how you check it says what
you meant.

## Customize

Two standing texts on the setup page, prepended to every model's instructions:
**About you** (what the room should assume without being told again) and
**Standing instructions** (how you want them to work). They outrank a model's
own habits, but never a decision the room has already recorded. Both take effect
on the next turn.

## Talking to it

Three ways in, all landing in the same room:

- **Type.** The composer, as normal.
- **Push to talk.** Hold 🎙 Talk (or click to latch it on). Your clip goes to
  your speech-to-text connection and is posted as ordinary text — so every agent
  reads speech exactly the way it reads typing. No model needs to understand
  audio.
- **Live.** Hands-free. It watches the microphone level and posts each time you
  stop speaking, so you can keep talking without touching anything. Click Live
  again to stop.

Transcription is biased toward the names in the room, so your agents' names come
back spelled right instead of mangled.

### The room talking back

**🔊 Listen** is the other half. With it on, every reply that arrives is read
aloud in the room's voice, in order, and with Live on that makes the whole
exchange hands-free in both directions.

Two details are load-bearing. Replies are queued rather than played as they
arrive, because three agents answering at once would otherwise talk over each
other in a way they do not in the transcript. And the microphone is held shut
while audio plays — otherwise Live hears the room through your speakers, posts
it back, and the room starts answering itself.

What gets read is what somebody said: links become "a link", code becomes "some
code", and joins and status lines are skipped, because bookkeeping read aloud
mid-conversation is what makes you switch the feature off.

### The voice

The voice is a connection like any other, and it does two jobs: it reads replies
aloud, and it is what **Create → Audio** makes audio with. One voice to
configure, so the room sounds like one thing.

Presets ship for OpenAI, ElevenLabs, Deepgram Aura, Groq and a local Kokoro, and
each names the voices that provider actually has, so the setup page offers a list
rather than a text box. The providers disagree about everything — where the text
goes, what the voice field is called, whether the key is a bearer token or its
own header — so the differences are *described* per connection rather than coded
for: `keyHeader`, `keyScheme`, `textKey`, `voiceKey`, `modelKey`, `path`. A
provider that does not exist yet needs no code change, only a description.

Agents have `generate_audio` too, for when hearing it is the point.

## Images, video and audio

**Create** — in the composer or on the Design page — generates an image or a
video from a prompt and posts it to the thread. Everything generated, by you or
by an agent, is collected on the **Design** page with the prompt that made it,
because the prompt is the half you iterate on. Pin the good ones; reuse a prompt
to make a variation. Agents can do it too — they have `generate_image` and
`generate_video`, for when a mockup or a diagram carries the point better than a
paragraph, and `generate_audio` for when it should be heard.

Generated files are written next to the database and served from `/media`, so
the room keeps working after a provider's temporary link expires.

Image generation follows the common `/images/generations` shape and handles both
base64 and URL responses. **Video is the ragged one:** providers disagree on
almost everything, and most start a job you then poll. The polling path and
field names are per-connection settings rather than hard-coded, so an endpoint
that returns `{"id": ...}` and exposes `/videos/{id}` works by describing it:

```json
{ "statusPath": "/videos/{id}", "idField": "id", "urlField": "url" }
```

## How it looks

One stylesheet, `src/web/theme.css`, holds the palette, the fonts and the shape
of the things every page shares. The pages hold only what is theirs. It used to
be seven copies of the same colours, which meant changing one meant changing
seven and finding out later which one you missed.

The palette shipped is warm rather than blue: a room you leave open all day is a
room you are staring into, and a warm near-black is easier to sit in front of
than a cold one. The clay accent is the only saturated colour on the page, so the
thing wearing it is always the thing to press. Both themes follow the system
setting.

**All of it is editable.** Setup → *Colours* has every token — page, rail,
controls, borders, the three weights of text, the accent, and the four status
colours — for the dark and light themes separately, plus the three font roles.
Four palettes ship to start from (clay, midnight, forest, paper); any of them can
then be changed a colour at a time.

Changes show on the page as you make them, because you pick a colour by looking
at it rather than by reading a hex code. Nothing is written until you press save,
and what is saved goes in the room's own database rather than in a browser — a
room you open from a laptop and a phone should not be two different-looking
rooms. `/theme.css` is then served with your colours already in it, so no page
flashes somebody else's first.

Values are validated rather than trusted: they end up inside a stylesheet every
page loads, so a "colour" of `red; } html { display:none` would be a room
somebody could break for everyone with one save. Anything that is not plainly a
colour is refused and the save says which ones it dropped.

Titles are set in a serif, the rest in a sans, and neither is fetched — the room
runs on a machine that may have no internet, which is rather the point of it, so
a web font would be a blank page waiting on a request that never returns. Both
are whichever good one the system already has.

## The rail

Everything the room can do runs down the left-hand side, in one column you read
top to bottom. A horizontal bar has a budget of about six words before it wraps;
a rail does not, which is why every app that grows past six features ends up
with one.

At the top is the toggle. **Chat** is where you and the models talk, with what
that produces beside it — the thread, the artifacts, the design library.
**Work** is where jobs get handed over and run without you watching — the
dashboard, the task board and the swarm, the plugins and skills. Keeping both
sets visible at once made the list long and the distinction invisible, which is
what the toggle is for. Under it sits the one thing that *does* something rather
than going somewhere — New idea, or New task — on `Ctrl`/`Cmd` `K`.

The right-hand column folds away with the button on its inner edge, and stays
folded until you say otherwise. Closed it becomes a strip holding its own way
back, because a panel with no way back is one people close once and never find
again.

Below the links are the threads, filed the way the room files them: the lobby,
then each project with its ideas under it, then anything unfiled. A dot means
that one is waiting on you. Picking one on the chat page switches the thread
without a page load, so the feed and the floor stay live.

The rail narrows to icons with the button at the top, and remembers that. On a
phone it is not there at all until you ask for it, and slides back out of the
way once you have.

## The / menu

Type `/` at the start of a line in the composer and everything the room can do
is one keystroke away: add files, use a skill, open the plugins, hand a job to
the swarm, search the web and quote a result, make an image, a video or audio,
switch on read-aloud. Arrow keys and Enter, Escape to dismiss.

It opens only on a slash that starts a line, so a URL or a date typed
mid-sentence does not throw a menu over what you are writing.

## Skills

The instructions you have already written, uploaded once.

A plugin *does* something. A skill tells a model **how** you want something done
— your review checklist, your house style, the procedure you keep re-explaining
— and a model reads it and works that way. So the body is stored and handed over
verbatim: summarising somebody's standards back at them defeats the point of
having written them down.

Drop files on the **Plugins** page. A `.md` file is one skill; a `.zip` is a
skill folder with a `SKILL.md` at its root and whatever files it needs, or
several of those, or a folder of loose markdown — each read the way that throws
none of your work away. Front matter `name`, `description` and `roles` are read
if present; without it the title comes from the first heading and the
description from the first paragraph.

Skills are *named* in every model's instructions, not pasted into them, so
twelve skills do not cost twelve pages of prompt on every turn. A model calls
`use_skill` when it needs one and gets it in full, with the files the folder
brought. `roles: [reviewer, critic]` limits which seats are told about it.

## Plugins

An HTTP call you describe once, which any agent can then make with `use_plugin`.
The description matters as much as the URL — it is what a model reads to decide
whether to reach for the thing, so a vague one gets called at the wrong moments
or never at all.

The **Plugins** page has three things on it:

- **Built in** — the capabilities that are already part of the room (PDF, Excel,
  Word, PowerPoint, image, video and audio generation, web search, the swarm),
  each saying whether it is ready or still needs a connection. These are
  pointers, not wrappers: following one gets you the working thing.
- **Ready to add** — public data sources, filled in, needing no key: Crossref
  and OpenAlex for papers, ECB rates and market quotes, World Bank indicators,
  IMF macro series, WHO health data, country facts, and SEC company filings and
  reported figures. Add one and test it in place.
- **Your own** — anything else, described in the same form.

Every call is logged with its arguments, status and duration, because the plugin
is the point where the room touches the outside world and that makes it the part
most worth being able to audit. A failure reports what the server actually said
rather than only the status code — an agent handed "HTTP 403" has nowhere to go,
where "403: Host not in allowlist" names the thing to fix.

To check the catalogue really works from wherever you are running it:

```bash
npm run check:presets          # all of them
npm run check:presets sec      # just the ones whose name or group matches
```

It calls each one through the same engine an agent uses and checks the response
contains what it should — a 200 holding an error page is not a working endpoint.
If your network only allows named hosts, that is what it will tell you. A URL that resolves to a private address is
refused before a socket is opened — and *that refusal is logged too*, since a
model filling a template to point at the machine's own network is the single
call most worth having a record of.

## The composer

Both halves have one, because a half of an app you cannot type in is a half you
only ever read. In the chat it posts a message; on Work it hands a job to the
swarm, and the run opens where you are rather than sending you looking for it.

The box is centred and capped — a line of text three feet wide is one nobody can
read the start and end of at once — with the controls on a row beneath it rather
than inside it: what you are writing is the point, not the buttons under it.
`/` opens the menu of everything else.

**Two buttons, two jobs.** The return key sends what you wrote. The filled circle
stops what is already running, and only appears while something is. They cannot
be the same control: you want the second one while the box is empty.

Stopping is real. It aborts the request *in flight* rather than waiting for the
current one to come back, because the wait you actually want to end is the one
in the middle — a model thinking for thirty seconds is exactly when you realise
you asked the wrong thing. The seat then stays out of the way for a few seconds;
without that its watch loop picks the next thing up immediately and the stop
looks like it did nothing. Running swarm jobs are cancelled the same way.

Beside it, a ring turns while anybody is working. It asks the server who is
mid-turn rather than reading the roster, and on its own clock rather than with
the feed: a model thinking says nothing for as long as it thinks, which is
precisely the window the ring exists for.

## The dashboard

Where everything stands, in one page: what is waiting on **you**, the ideas and
their stages, live swarm runs with their progress, who is in the room and
whether they are running, what the prefect has flagged, the plugins and skills
and how much they get used, what has been made lately, and which capabilities
this room actually has. It follows the room live rather than going stale until
you reload.

## The prefect

A seat with the `prefect` role, whose job is not to contribute ideas but to
check the ones that are made. It pulls the statements of fact out of what was
said — numbers, versions, limits, prices, API shapes, "this is impossible" —
and checks each one: first against the room's own recorded decisions, facts and
artifacts with `check_claim`, and where the room cannot settle it, against the
web. Every check is recorded with its source, because "I verified it" without a
source is the same failure it exists to catch.

It speaks only when something is wrong or unsupported, and it says
**unverifiable** when that is the honest answer rather than converting an
absence of evidence into a verdict either way.

The dashboard's prefect card is deliberately not reassuring when it is empty: no
prefect seated means nothing is being checked, and it says so rather than
showing a comfortable zero.

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

Ten presets ship: `architect`, `critic`, `researcher`, `planner`, `backend`,
`frontend`, `reviewer`, `prefect`, `generalist`, `human`. Each is a charter plus
a queue filter — `claim_next()` only hands a `backend` agent backend work.

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
| `ESPRITS_KEY_<NAME>` | — | fallback key for the connection of that name |

## Security

The room contains every idea, decision and handoff you have, so:

- It binds to **loopback only** by default. A private or tailnet address binds
  without a token, with a line at startup saying what that means; a public
  address or `0.0.0.0` without one is **refused**, not warned about.
- To reach it from outside, put it on a private network (Tailscale) rather than
  opening a port. See **Running it somewhere else**.
- With a token set, a browser signs in once at `/unlock` and carries an httpOnly,
  SameSite=Strict cookie; scripts keep using a bearer header. Sign-in attempts
  are rate limited, and the `next` parameter can only ever point back at this
  server.
- A Telegram chat is inert until paired, and `/stop` revokes it. The Bot API host
is configurable with `ESPRITS_TELEGRAM_API`, for a self-hosted Bot API server —
and so the polling loop can be exercised against a stub rather than being the one
part nothing covers.
- The database holds your API keys once you save them, so it is set to `600` and
  should be treated like a credential file. Prefer environment variables if you
  would rather keys never touch it.

## Tests

```bash
npm test              # the rules, the routes, the binding rules and auth
npm run confirm       # the whole room, end to end, on a scratch database
npm run check:pages   # the pages, in a real browser
npm run check:presets # the endpoint catalogue, by calling it
```

`confirm` is the one to run when you want to know whether the thing works. It
starts a server, stubs everything outside this machine, and drives each
capability the way a person does: a key pasted with its whole line around it, an
endpoint interrogated, a model seated and answering, a skill uploaded and read
back, a document parsed, a voice spoken, a plugin refused for pointing inside the
network, a job swarmed, a phone paired over Telegram. It needs no keys and spends
nothing.

`check:pages` starts its own server on a scratch database and drives the room
the way a person does: joining, adding a key, putting a model in the chat, and
checking it answers. It exists because the bugs that made this feel broken on a
first run were all invisible to a unit test — Enter doing nothing in a dialog, an
error painted behind the modal that raised it, a seat that displayed a
connection it did not have.

244 tests over the domain rules, turn-taking, connections and seats, artifacts
and their versioning, projects, attachments, schedules, the swarm runner, the media
library, the document readers, skills, plugins, the voice, the storage layer, the
Telegram command language, the page routes, and the model participants (driven
through a stubbed provider client, so `npm test` needs no API key and spends
nothing).

They cover the guards specifically, because the guards are the design: an agent
cannot answer a question aimed at you or at another agent by name, cannot choose
a route with a live blocking objection, cannot win a task two builders raced for,
cannot talk out of turn once somebody is queued, and cannot wedge the room by
crashing while holding the floor. Seat credentials are covered too: no view of a
seat carries a raw key, and re-saving a seat cannot wipe the key already stored
for it.

The document readers are tested against real containers — a zip written the way
the Office tools write one, a PDF with a real cross-reference table — rather than
against a convenient simplification, including a two-byte ToUnicode map and a
scanned page that must come back empty instead of inventing text.

Every web page is also checked in a real browser (Playwright) for JS errors and
failed requests — which is how the setup page's dead `addEventListener` was
caught. The voice path is exercised there against a stub provider: the read-aloud
loop is driven end to end and asserted to name the speaker, use the chosen voice,
skip your own messages and the join notices, strip URLs and code, and fall silent
when switched off.

## License

MIT
