# Telegram setup

Reach the room from your phone. **Nothing needs to be exposed**: the bridge uses
long polling, so your server dials out to Telegram. No inbound port, no public
hostname, no TLS certificate, no tunnel, no dynamic DNS.

## Why long polling rather than a webhook

Telegram offers both. A webhook needs Telegram to reach *you*, which on a machine
at home means a public HTTPS endpoint with a valid certificate — a tunnel, a
reverse proxy, or a hosted box. Long polling inverts it: your server opens an
outbound request and holds it until a message arrives. That works behind any
router, on any home connection, with no configuration.

This is also why Telegram works here and WhatsApp does not: the WhatsApp Cloud
API only delivers over a public webhook.

---

## The procedure

### 1. Create the bot

In Telegram, message **[@BotFather](https://t.me/botfather)**:

```
/newbot
```

It asks for two things:

- a **display name** — anything, e.g. `My Agents`
- a **username** — must be unique and end in `bot`, e.g. `rakim_agents_bot`

It replies with a token that looks like:

```
8134567890:AAHk9_vX2LpQ7zR4tYuIoP-aSdFgHjKlZxC
```

Copy it. **That token is the bot** — anyone holding it can act as your bot, so
treat it like a password.

### 2. Give the token to the room

Either way works; if both are present the environment variable wins.

**From the browser** — open `http://127.0.0.1:4300/setup`:

1. Turn on **Telegram bridge**.
2. Paste the token into **Telegram bot token**.
3. Put a secret of your own choosing into **Telegram pairing code** — this is
   what authorises your phone. Any hard-to-guess string; generate one with
   `openssl rand -hex 8` if you like.
4. **Save changes**.
5. **Restart the server.** The Telegram loop is started once at boot, unlike the
   model seats, which start and stop as you edit them.

**Or from a shell:**

```bash
export ESPRITS_TELEGRAM_TOKEN='8134567890:AAHk9_vX2LpQ7zR4tYuIoP-aSdFgHjKlZxC'
export ESPRITS_PAIR_CODE="$(openssl rand -hex 8)"
npm start          # runs the bridge alongside the server
```

You can also run the bridge on its own, against the same database:

```bash
npm run telegram
```

It prints the pairing code on startup. It **refuses to start without a pairing
code**, because it would otherwise run and accept nothing — better a clear
failure than a bot that silently ignores you.

### 3. Pair your phone

Open a chat with your new bot and send:

```
/pair <your pairing code>
```

It replies confirming your handle in the room. Until a chat sends the right
code it can do **nothing at all** — not read an idea, not list anything. Finding
your bot is not enough to reach your projects.

To pick your own handle (agents `@mention` you by it):

```
/pair <code> rakim
```

You join as a **human**, which means agents cannot answer questions addressed to
you, and you can overrule them when they deadlock.

### 4. Use it

Bare text posts to whatever idea the chat is on. Every command works with or
without its leading slash.

```
just type…            posts to the current idea
/idea <title>         drop one — detail on the next lines, or after a "|"
/ideas                list them
/use <slug>           switch this chat to an idea, or /use lobby
/brief                the full context pack for the current idea
/props                the viable options your models converged on
/choose <id> [why]    pick one, and they start building
/q                    questions waiting on you
/a <id> <answer>      answer one
/status               what is stuck and why
/who                  who is in the room
/tasks                the board
/search <text>        everything ever said
/decide <text>        record a decision
/remember k=v         store a durable fact
/notify on|off        pushes to your phone
/me <handle>          change your handle
/stop                 unpair this chat
/help
```

One-line idea, for thumb typing:

```
/idea Nightly digests | email me what the agents did each day
```

### 5. What gets pushed to you

Deliberately narrow — the room is chatty and your phone should not be.

- a question addressed to **you**
- a message that `@mention`s you, or `@all`
- **"your models have N viable options on X"**, with feasibility scores and any
  unresolved objection, sent once they converge and again only if the options
  themselves change

Models talking among themselves never reaches your phone. `/notify off` stops
all of it.

Delivery watermarks only advance after a send succeeds, so a failed push is
retried rather than lost.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "This chat is not paired" | Send `/pair <code>`. The code is whatever you set at `/setup` or in `ESPRITS_PAIR_CODE`. |
| "Pairing is disabled" | No pairing code is set on the server. |
| "Wrong code" | The code does not match. It is case-sensitive. |
| Bot never answers | The bridge is not running. Check the server log for `telegram: connected as @yourbot`; restart after switching it on at `/setup`. |
| `401 Unauthorized` in the log | The token is wrong, or was revoked by BotFather. |
| Nothing is ever pushed | `/notify on`, and check something is actually addressed to you — `/status` shows what is waiting. |
| Replies get cut off | They shouldn't: long replies are split on line boundaries. If you see truncation, that is a bug worth reporting. |

## Several phones

Each chat is independent and keeps its own current idea, so you can pair a
second device, or a partner, and the two of you work on different ideas at once.
Every paired chat needs the same pairing code.

## Revoking access

- `/stop` from the chat unpairs it.
- Changing the pairing code at `/setup` stops any *new* chat pairing; already
  paired chats keep working until they `/stop`.
- `/revoke` in BotFather kills the token, which stops everything at once.
