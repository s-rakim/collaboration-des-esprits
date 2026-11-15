# The guide: setting up, running, maintaining and fixing the room

This is the one document to read when you want the room working and to keep it
working. The [README](../README.md) explains *why* each part is the way it is;
this explains *what to do*.

Commands are written for Windows PowerShell and work the same in any other
shell unless a line says otherwise.

- [1. Setting up](#1-setting-up)
- [2. Running it](#2-running-it)
- [3. Using it](#3-using-it)
- [4. Workarounds](#4-workarounds)
- [5. Maintenance](#5-maintenance)
- [6. Troubleshooting](#6-troubleshooting)
- [7. Reference](#7-reference)

---

## 1. Setting up

### What you need

| | Needed for | Notes |
|---|---|---|
| **Node.js 22.5 or newer** | everything | Check with `node -v`. Older versions fail at start. |
| **Git** | getting and updating the code | |
| **At least one chat API key** | agents that answer | Any provider with an OpenAI-style `/chat/completions` endpoint. |
| Docker Desktop or Podman | the sandboxed terminal | Optional. Without it, link a folder instead ([4.1](#41-no-docker)). |
| Firefox | the shared browser | Optional. Found automatically when installed. |

### Install

```powershell
git clone https://github.com/s-rakim/collaboration-des-esprits.git
cd collaboration-des-esprits
npm install
npm start
```

Open **http://127.0.0.1:4300**. The first time, it asks who you are — one word,
no spaces. That is your name in the room.

`npm install` may print "vulnerabilities" from the package registry's audit.
That is a report about published dependencies, not an error, and the room runs
regardless. Do not run `npm audit fix --force`: it can replace a dependency
with a version the room was not written for.

### Add your agents

Go to **Setup** (the tab in the top bar, or `/setup`).

1. Under **Connections**, add a row per key. The fastest way is the paste box:
   paste the provider's own example snippet (the Python or curl one from their
   page) and press **Read it** — the address, model and key are picked out.
   Or fill a row by hand: a name, *Chat model*, the base URL, the model id, the
   key.
2. Press **find** on the row to have the room ask the endpoint what it offers,
   and **test** to make one real call.

**A chat key is an agent.** The moment a chat connection has a key it takes a
seat in the chat under the connection's name — that name is what you type
after `@`. You do not have to attach anything by hand. The first two keys take
the roles a new room starts with (architect, then critic); the rest are
generalists. Change a role, model or effort under **The models in your chat**.

Use different keys from different providers if you have them. Two models from
one family agree too easily to be worth the tokens.

### Other kinds of connection

The **Used for** column decides what a connection does:

| Used for | Does |
|---|---|
| Chat model | an agent in the chat |
| Image generation | the `/image` command and the agents' image tool |
| Speech to text / Text to speech | the microphone, and the room reading replies aloud |
| Video generation | the `/video` command |

For **NVIDIA images**, set *Used for* to Image, the base URL to
`https://ai.api.nvidia.com/v1` (the chat host `integrate.api.nvidia.com` works
too — it is redirected), and the model to the name on the model's page, such
as `flux.1-schnell` or `stable-diffusion-3-medium`.

---

## 2. Running it

| Command | What it does |
|---|---|
| `npm start` | The room, on this machine only: http://127.0.0.1:4300 |
| `npm run serve` | The same room, reachable from your other devices on LAN, VPN or Tailscale |
| `npm run link -- "C:\path"` | Point the running room at a folder of yours |
| `Ctrl`+`C` | Stop it |

Leave the window that started it open; closing it stops the room.

### What the start-up lines mean

```
collaboration-des-esprits
  room       http://127.0.0.1:4300/
  database   C:\Users\you\collaboration-des-esprits\data\esprits.sqlite
  auth       none (loopback only)
  models     stdenis=mistralai/…, st-etienne=nvidia/…
  endpoints  stdenis(chat), st-etienne(chat)
  sandbox    off: Docker is installed but not running — start it.
```

- **models** — the agents that will answer, and the model each is on. *none*
  means no chat connection has a key yet.
- **sandbox** — `on` means commands run in a container. `off` means the
  terminal will not run commands until you start Docker **or** link a folder.
  Chat, images and the browser do not need it.

As agents answer, each turn is logged with its timing:

```
stdenis: reply — 6.2s, first word after 1.4s
```

### From your phone or another computer: `npm run serve`

```
Open the room from another device
  Tailscale  http://100.101.102.103:4300/
  Wi-Fi      http://192.168.1.24:4300/

  Access token   k7fq-m2xw-9hpd-3vbt
  On this machine: http://127.0.0.1:4300/unlock#k7fq-m2xw-9hpd-3vbt
```

1. On the other device, open the address for the network you share with the PC.
2. Type the access token once. That browser stays signed in for 30 days.
3. On the PC itself, click the *On this machine* link once to sign in there.

The token is created on first run and kept in `data/access-token`. Only devices
on a private network are answered; callers from the public internet are
refused. On Wi-Fi shared with strangers, use the Tailscale address — a plain
LAN is not encrypted.

---

## 3. Using it

### Talking

- **Say something** and every agent answers, one after another, each having
  read what the others said. `Enter` sends; `Shift`+`Enter` is a new line.
- **`@name`** and only that agent answers. It stays a one-to-one — your next
  messages go to it without naming it again — until you say "thanks" / "that's
  all", go quiet for 90 seconds, type `@all`, or click **open the floor**. Then
  the others answer, with the whole exchange in front of them.
- **Hover a message** to react, reply to it specifically, or copy it.
- **Click any face** to change an agent's letter, emoji, colour or picture.

### The Speaking panel (left of the chat)

- The **order** agents answer in. Default: the order the keys were added. Drag
  the names to set your own, or choose *the coordinator decides*.
- The **coordinator**: *automation* (rules, no key) or one of your agents. It
  decides when a one-to-one is over, orders rounds when asked, and oversees
  builds.

### Ideas and builds

The lobby is for talk. Planning and building happen in an **idea**. If a lobby
conversation turns into something to make, either an agent opens an idea for it
(it will say so), or you hover the message that says it best and press 💡.

Agents cannot start a build. Only you can, by handing an idea over — so an
agent saying "starting thread 1" in the lobby has not started anything.

1. **Drop an idea** — a line is enough. The agents react to it in turn.
2. Talk it through in the idea's thread.
3. **Hand over to build** (top of the idea, or the Threads page). That is your
   approval. The coordinator cuts it into threads, each with a necessity (must /
   should / could), an importance (1–5), a model and an effort.
4. On **Threads**, change any thread's seat, model or effort; tell a running
   thread something; run one again. The coordinator's report says what was
   built and what was not.

### The tools (tabs on the right-hand edge)

| Tool | Where it appears | Shortcut |
|---|---|---|
| **Terminal** | a floating window — drag its bar, size its corner, double-click the bar to send it home | `Ctrl`+`` ` `` |
| **Browser** | a floating window, moved and sized the same way; click, scroll and type in the picture | |
| **Files & export** | a tab of the terminal window | |

Work stays in the sandbox (or your linked folder) until you export it from the
Files tab: **Download as a zip**, or **Copy to a folder on this computer**.

---

## 3b. The Agents' PC

The Agents' PC is the machine the agents work on: one folder, a terminal, a
browser, and — when Docker or Podman is running — a container around all
three. (Earlier versions called this "the sandbox"; it is the same thing.)
Agents reach it from the lobby and from every thread, and so do you.

### Where to find it

- **The tabs on the right-hand edge of every page** — *Agents' PC*, *Terminal*,
  *Browser*, *Explorer*. Each opens a small window you can drag by its bar,
  resize by its corner, and leave open while you carry on in the chat.
- The **Agents' PC** tab in the top bar (`/pc`) — the same PC as a whole page: icons
  for every program, the folder's files on the desktop, and a taskbar showing
  what is open and what is running.

### The programs

| Program | What it is for |
| --- | --- |
| **Explorer** | The folder as a tree and a list. It is live: a file an agent makes is tagged *new*, one it rewrites *changed*, one it deletes fades out, and a folder with changes inside carries a dot. Click a file to preview it; double-click to open it. New file, new folder, rename, delete, download, export as zip. |
| **Code** | A code editor: tabs, line numbers, Tab and auto-indent, `Ctrl S`, and *Run* for `.js`, `.py`, `.sh` and `.ts` files. |
| **Notes** | A text editor for prose: wraps, counts words. |
| **Terminal** | Tabs of command lines — the PC's own, Ubuntu, Kali, zsh, Git Bash, PowerShell, cmd. See below. |
| **Permissions** | Which websites, GitHub and programs the agents may read and write. |
| **Browser** | The Firefox window you share with the agents. |
| **Activity** | What the PC is, its switches (network, whether agents may use the terminal, restart), running commands with *Stop*, and the threads at work with a box to steer each. |
| **Export** | Download the folder as a zip, copy it out, or open it in your own editor. |

An open file **follows the disk** until you type in it, so you can watch an
agent write it. Once you have typed, nothing is taken from you: if the file
changes underneath, the editor says so and you choose *Load theirs* or
*Keep mine*; saving never silently overwrites an agent's newer version.

The bars between sections — the explorer's tree and preview, the PC window's
sections, the chat page's columns and its *Speaking* / *In the room* lists —
are dragged to resize them. Double-click a bar to put it back.

### Driving it from the command line

Anything typed in the Terminal runs on the PC as a shell command, except a
line that starts with `pc`, which is for the machine itself:

```
pc status                 what the PC is and where it is working
pc folders                the folders on it
pc use <name>             work in that folder (made if it is new)
pc link <path> [name]     work in a folder of this computer
pc unlink [name]          let go of a linked folder (nothing is deleted)
pc ls [dir]               what is in the folder
pc cat <file>             a file's text
pc write <file> <text>    put text in a file
pc mkdir <dir>            make a folder
pc mv <from> <to>         rename or move
pc rm <path>              delete a file or folder
pc ps                     what is running, commands and threads
pc stop <id|all>          stop a running command
pc tell <thread> <text>   say something to a thread while it works
pc network on|off         whether it can reach the internet
pc agents on|off          whether agents may use the terminal
pc restart                start it afresh (files are kept)
pc open [file]            open the folder, or a file, in your editor
pc export <path>          copy the folder out to this computer
pc browse <address>       open a page in the shared browser
pc empty                  delete everything in the PC's folder
pc perms                  what the agents may read and write
pc allow read|write <site>   let agents read, or write to, a site
pc deny read|write <site>    stop them
```

`pc` commands are yours alone — an agent's command line goes to the shell —
and they are written to the terminal's history like everything else.

### The terminal: tabs, and a shell in each

The Terminal is laid out like Windows Terminal: tabs along the top, and under
them a page that is only the prompt — the folder you are standing in, and the
cursor. Opening it asks **which command line** you want; **+** adds another
tab, **⌄** opens a shell directly, and there is no limit on how many tabs or
which kinds. Each tab is its own instance: its own folder (`cd` moves that tab
only), its own history (↑/↓), its own page (`clear`, `cls` or `Ctrl L` wipes
it). Tabs are remembered when you close the window.

| Tab | What runs your command |
| --- | --- |
| **Agents' PC** | The PC itself — its container with Docker, its folder without. Also shows what the agents run. |
| **Ubuntu** | A `ubuntu:24.04` container with Docker; otherwise WSL's Ubuntu on Windows (`wsl --install -d Ubuntu`). |
| **Kali Linux** | A `kalilinux/kali-rolling` container with Docker; otherwise WSL's Kali (`wsl --install -d kali-linux`). |
| **macOS (zsh)** | zsh on a Mac. Elsewhere it is zsh — the Mac's shell — in the PC's container or on the machine; macOS itself only runs on a Mac. |
| **Git Bash** | Git for Windows' bash on Windows; bash elsewhere. |
| **PowerShell** | Windows PowerShell on Windows; `pwsh` elsewhere (in a container with Docker). |
| **Command Prompt** | `cmd.exe` — Windows only. |

Nothing is imitated: a shell this computer cannot run is listed as
unavailable, with what to install. Every tab starts in the PC's folder and
cannot `cd` out of it. `pc …` commands work in every tab.

A shell that runs on the computer rather than in a container (WSL, Git Bash,
PowerShell, cmd — anything, when Docker is not running) is **not sandboxed**;
it opens only in a folder you linked, or after you chose to run without a
sandbox. The picker says which way each one runs.

Each command is run on its own, so a tab remembers its folder but not shell
variables from one line to the next; chain with `&&` when that matters.
Programs that take over the screen (`vim`, `top`) need a real terminal.

### Windows that leave the page

Every window — Terminal, Browser, Explorer, the editors, the PC, Activity,
Permissions — can hang over any edge of the page. To put one *outside* the
browser, press **↗** on its bar, or drag it out of the page and let go: it
opens as a real window of its own, which you can place anywhere on your
screen or on another monitor. (A web page cannot draw outside its browser
window, so this is the only way a window can.) If nothing opens, allow
pop-ups for the page.

### Permissions: what agents may read and write

**Agents' PC → Permissions** (also under the terminal's **⌄**) decides what
the agents may reach beyond their own folder. The rules bind agents, never
you.

- **Read** is looking: opening a page, fetching, cloning.
- **Write** is changing something there: clicking and typing on the site,
  submitting a form, `git push`, `gh pr create`.

*Websites.* Sites not listed get the default — read, no write. Add a site to
give it its own rule (a rule covers its subdomains). Untick read on "every
other site" and agents can reach only what you listed.

*GitHub* is listed from the start, read-only. Tick write to let agents push
and open pull requests. Save a **token** and `git` and `gh` on the PC sign in
with it (private repositories, pushing). The token is stored with your other
keys and never shown again. It can do whatever GitHub lets it — give a
read-only token if agents must only read.

*Programs on this computer.* Add a program by name and command (`code`,
`notepad`, a full path). With read, an agent can open a file from the PC's
folder in it; with write, it can run it with its own arguments and read what
it prints. These run on your computer, as you.

From the terminal: `pc perms`, `pc allow write github.com`,
`pc deny read all`.

How firm this is: the browser and the fetch tool are checked exactly — every
request names its site. A shell command is checked by reading it (the sites
it names, whether it pushes or posts), which stops the ordinary routes and
tells the agent why. It is not a wall round a shell; the wall is
`pc network off`.

### Emptying the PC, and saving the project

**Save as zip** downloads the project files (dependencies and `.git` left
out). **Empty…** deletes everything in the PC's folder and keeps the folder.
Both are in the Explorer's footer, the Agents' PC window, Activity, and the
terminal's Export page; `pc empty` does the same from the command line. A
folder of your own that you linked is never emptied from here.

### Steering an agent while it works

While a thread is running, a **Steer** strip appears at the foot of the
Terminal, Browser, Explorer and Agents' PC windows. What you type there
reaches the thread at its next step — the same as the box on the thread's own
card, or `pc tell <id> …`.

### Threads are opened by link

Threads do not open themselves. When a build is planned, the coordinator
posts one message in the lobby (and in the idea's own conversation) with a
link to every thread; click one to open that thread's conversation and steer
it. On the Threads page, clicking a thread's row does the same.

## 4. Workarounds

### 4.1 No Docker

The sandboxed terminal needs Docker Desktop or Podman. Without either:

**Link a folder.** In the terminal window's folder menu choose *link a folder
on this computer…* and give the full path of your project. Or, with the room
running, from the room's folder:

```powershell
npm run link -- "C:\Users\you\code\my-project"
npm run link -- --unlink        # let go of it again
```

The room then works in that folder. Commands run directly on your PC there —
not isolated — and the window shows **linked folder** for as long as it is in
use. It applies to that folder only.

You cannot link a whole drive, your home folder, or a folder that contains the
room's own `data` folder (it holds your keys). In particular, do not link the
`collaboration-des-esprits` folder itself; link the project you want worked on.

If you later start Docker, the same linked folder is mounted into the sandbox
and becomes the only thing the agents can see.

### 4.2 Any code editor

- **Files tab → Open in editor.** Starts your editor on the folder. Installed
  editors are found; for anything else choose *another editor…* and type the
  command that starts it (`code`, `zed`, `subl`, `idea`, or the full path to
  its program).
- **VS Code, Cursor, Windsurf, VSCodium:** install the extension.

  ```powershell
  code --install-extension extensions/vscode/esprits-room-0.1.0.vsix
  ```

  Use `cursor`, `windsurf` or `codium` in place of `code`. It adds *Esprits:*
  commands — link this folder, ask the room about a selection
  (`Ctrl`+`Alt`+`R`), run in the room's terminal, drop an idea, open the room
  — and an *Esprits room* output panel.

  If the editor refuses the `.vsix`, open the `extensions/vscode` folder in the
  editor and press `F5` to run it from source.

### 4.3 A provider that is slow

The room cannot make a provider faster, but it can show where the time goes.
Read the timing line in the start-up window:

- **first word after** is large → the provider is queuing or the model is slow
  to start. Try a smaller or faster model on that seat (Setup → *The models in
  your chat* → model box).
- total is large but *first word* is small → the model is writing a lot. Lower
  that seat's effort, or ask shorter questions.

While nothing has arrived, the agent shows *waiting for <model>* — that is the
provider, not the room.

### 4.4 A provider that rejects the reply length

Handled automatically: when an endpoint says a model allows fewer tokens than
were asked for, the room retries with what it allows and remembers it until
restart. If a seat still fails with a length error, lower its **max tokens** on
the setup page.

### 4.5 Running with no sandbox at all

Possible, not recommended: in the terminal window, *run anywhere without a
sandbox*. Commands then run as you, anywhere. Prefer linking a folder.

---

## 5. Maintenance

### Updating

```powershell
cd collaboration-des-esprits
git pull
npm install
npm start
```

Your data is not touched by an update; the database upgrades itself on start.

### Where everything lives

All of it is under the `data` folder beside the code (or wherever `ESPRITS_DB`
points):

| Path | Holds |
|---|---|
| `data/esprits.sqlite` | every message, idea, decision, setting **and your API keys** |
| `data/access-token` | the token `npm run serve` asks for |
| `data/media/` | generated images, audio and video |
| `data/sandbox/` | the sandbox's own folders (`project`, …) |
| `data/sandbox/downloads/` | files the shared browser downloaded |
| `data/firefox-profile/` | the shared browser's own profile |

Linked folders stay where they are on your disk; the room only remembers their
paths.

### Backing up

Stop the room, then copy the whole `data` folder. That is a complete backup.
Treat it like a password file — it contains your keys.

### Moving to another machine

Copy the `data` folder into the new clone before the first `npm start`.

### Starting over

Stop the room and delete (or rename) the `data` folder. The next start is a
new, empty room. To reset only one thing:

| To reset | Delete |
|---|---|
| the access token | `data/access-token` |
| the browser's logins and history | `data/firefox-profile/` |
| the terminal window's position | it is in the browser: double-click the window's bar |

### Changing keys

Setup → the connection's row → type the new key over *saved · … ch* → it saves
when you leave the box. Press **test**.

If a key was ever pasted somewhere public, revoke it at the provider and make a
new one; changing it here does not un-leak the old one.

### Rebuilding the editor extension

After changing anything in `extensions/vscode`:

```powershell
npm run extension:package
```

### Checking a change

```powershell
npm test               # the rules (unit tests)
npm run confirm        # a real server, exercised end to end
npm run check:pages    # the pages, in a real browser (needs Playwright)
```

`npm test` skips the container tests when no engine is running. Two guards run
with it: one fails if anything shaped like an API key is in a tracked file, so
a real key cannot be committed as a "fixture".

---

## 6. Troubleshooting

Find the symptom; the fix is beside it.

### Starting

| Symptom | Cause and fix |
|---|---|
| `npm start` fails mentioning `node:sqlite` or syntax | Node is older than 22.5. Install a current Node, reopen PowerShell, `node -v`. |
| `EADDRINUSE` / port 4300 in use | Another copy is running. Close its window, or start on another port: `$env:PORT=4301; npm start`. |
| `refusing to bind … without ESPRITS_TOKEN` | You set `ESPRITS_HOST` to a public address. Use `npm run serve` instead, which makes its own token. |
| The page asks for a token you do not have | It is printed by `npm run serve`, and kept in `data/access-token`. |

### Agents

| Symptom | Cause and fix |
|---|---|
| Nobody answers, and the chat says "Nobody can answer yet…" | Read the reason it gives: no key, switched off, or no model. Fix it on Setup. |
| Nobody answers and the chat says nothing | You are on an old version. `git pull`, restart. |
| "In the room" lists only you | No chat connection has a key. Add one; it takes a seat by itself. |
| `<name> could not answer — … has no model called "…" for this key (404)` | The model id is wrong or your key has no access to it. Press **find** on that row and pick one it lists. |
| `… answered 404 — the base URL is probably missing…` | The address is wrong. Most end in `/v1`. |
| `the provider rejected the API key` | The key is wrong, expired or revoked. Paste it again; **test**. |
| `rate limited by the provider` | Wait, or use a different key/provider for that seat. |
| `… sent no reply within 180s` | The provider hung. Try again, or a different model. |
| An agent answers when you named a different one | Check the spelling after `@` — pick it from the menu that opens when you type `@`. |
| An agent wrote a plan in the lobby and says it is "starting" work, but nothing happens | Plans and builds need an idea. Hover that message → 💡 to make it one, open the idea, then **Hand over to build**. |
| The other agents will not speak | You are in a one-to-one. Click **open the floor**, or type `@all`. |
| An agent is very slow | See [4.3](#43-a-provider-that-is-slow). |
| An image connection shows up as a chat agent, or errors in chat | Its *Used for* is set to Chat model. Set it to Image generation. |

### Images

| Symptom | Cause and fix |
|---|---|
| `NVIDIA has no image model at …` | Use the exact name from the model's page, e.g. `flux.1-schnell`. |
| `NVIDIA refused the key for …` | That key has no access to that model. |
| `made no image: the provider answered "content filtered"` | Reword the prompt. |
| `no image connection is configured` | No connection has *Used for* = Image generation. |

### Terminal and sandbox

| Symptom | Cause and fix |
|---|---|
| "Nothing can be run yet" | No container engine. Start Docker Desktop and press **Check again**, or link a folder ([4.1](#41-no-docker)). |
| `Docker is installed but not running` | Start Docker Desktop; wait for it to finish starting; **Check again**. |
| "Getting the sandbox ready" for minutes | First run downloads the image (`node:22-bookworm`). It happens once. |
| "The sandbox would not start" | Read the reason shown. Often Docker is out of disk, or file sharing for the drive is off in Docker Desktop's settings. |
| `the linked folder … is no longer there` | The folder was moved or deleted. Link it again at its new path, or switch folder. |
| `that folder holds the room's own data…` | You tried to link a folder containing `data`. Link the project itself. |
| A command stops after 2 minutes | That is the limit for one command. Run long jobs in your own terminal. |
| Agents cannot use the terminal | The *agents may use it* box is unticked. |
| The terminal window is off-screen or lost | Double-click its title bar, or press `Ctrl`+`` ` `` twice. |

### Browser

| Symptom | Cause and fix |
|---|---|
| "Firefox is not on this computer" | Install Firefox. If it is installed somewhere unusual, set `ESPRITS_FIREFOX` to the full path of `firefox.exe` and restart. |
| `Firefox started but did not open its control port` | Another program is using port 9222. Set `ESPRITS_FIREFOX_PORT` to another number and restart. |
| The picture does not update | Close and reopen the Browser from its tab on the right edge. |
| Clicking the picture does nothing | Make sure Firefox is current; very old versions lack the control this uses. |

### Other devices (`npm run serve`)

| Symptom | Cause and fix |
|---|---|
| The other device cannot connect | Windows Firewall. Allow Node.js on *Private networks*, or run the `netsh` line the banner prints, in an administrator PowerShell. |
| Still cannot connect on Wi-Fi | The Wi-Fi may isolate devices from each other (guest networks do). Use Tailscale. |
| `This room answers devices on its own private networks only` | The caller's address is a public one. Use the LAN or Tailscale address. |
| "That is not the token" | Copy it again from the banner or `data/access-token`. After 8 wrong tries it locks for a minute. |
| No addresses are listed | The PC is not on a network. Connect, and reload the page on the PC — no restart needed. |

### Editor

| Symptom | Cause and fix |
|---|---|
| Extension: "the room is not running at …" | Start the room, or set `esprits.url` if it is on another port. |
| Extension: "the room asked for its access token" | You started with `npm run serve`. Put the token in the `esprits.token` setting. |
| "there is no program called …" on Open in editor | The editor's command is not on the PATH. Choose *another editor…* and give the full path. |
| `npm run link`: "more than one person is in the room" | Add `--as yourname`. |

### When none of that is it

1. Look at the window that ran `npm start`. Errors are printed there.
2. Reload the page (`Ctrl`+`R`).
3. Restart the room.
4. `git pull`, `npm install`, restart.
5. Run `npm run confirm`. If it reports a failure, that line names what is
   broken on your machine.

When reporting a problem, include: the last 20 lines of the start-up window,
what you clicked, and the message the page showed. Do **not** include your keys
or the access token.

---

## 7. Reference

### Commands

| Command | |
|---|---|
| `npm start` | run the room on this machine |
| `npm run serve` | run it for your other devices too |
| `npm run link -- [folder] [--as name] [--unlink]` | link / unlink a folder |
| `npm run stdio` | the room as an MCP server over stdio, for an agent that connects that way |
| `npm run telegram` | the Telegram bridge on its own |
| `npm test` | unit tests |
| `npm run confirm` | end-to-end checks against a real server |
| `npm run check:pages` | page checks in a real browser |
| `npm run skills:check` / `skills:build` | lint / package the skills |
| `npm run extension:package` | rebuild the editor extension's `.vsix` |

### Settings by environment variable

Everything can be set in the app; a variable wins when both are set. In
PowerShell: `$env:NAME="value"; npm start`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `ESPRITS_PORT` | `4300` | port |
| `ESPRITS_HOST` | `127.0.0.1` | address to listen on |
| `ESPRITS_TOKEN` | — | access token (required beyond this machine) |
| `ESPRITS_DB` | `./data/esprits.sqlite` | the database; everything else lives beside it |
| `ESPRITS_HUMAN` | — | your name |
| `ESPRITS_KEY_<NAME>` | — | a key for the connection of that name, kept out of the database |
| `ESPRITS_COORDINATOR` | automation | the agent that coordinates |
| `ESPRITS_TURN_ORDER_MODE` | `added` | `added`, `custom` or `coordinator` |
| `ESPRITS_FLOOR_IDLE_MS` | `90000` | quiet time before a one-to-one ends |
| `ESPRITS_WORKSPACE` | `project` | the folder commands start in (a name) |
| `ESPRITS_SANDBOX_ENGINE` | found | `docker`, `podman` or `none` |
| `ESPRITS_SANDBOX_IMAGE` | `node:22-bookworm` | the sandbox's image |
| `ESPRITS_SANDBOX_NETWORK` | `true` | whether the sandbox reaches the internet |
| `ESPRITS_SANDBOX_UNCONFINED` | `false` | run with no sandbox |
| `ESPRITS_TERMINAL_AGENTS` | `true` | whether agents may use the terminal |
| `ESPRITS_EDITOR` | found | the command that starts your editor |
| `ESPRITS_FIREFOX` | found | full path to Firefox |
| `ESPRITS_FIREFOX_PORT` | `9222` | Firefox's control port |
| `ESPRITS_SEARCH_URL` | DuckDuckGo | search address, with `{query}` in it |
| `ESPRITS_TELEGRAM_TOKEN`, `ESPRITS_PAIR_CODE` | — | see [TELEGRAM.md](TELEGRAM.md) |

### Pages

| Address | |
|---|---|
| `/` | the chat |
| `/threads` | builds and their threads |
| `/work` | one-off parallel jobs |
| `/dashboard` | what the room has been doing |
| `/artifacts` | documents the room wrote |
| `/plugins` | plugins and skills |
| `/setup` | keys, agents, voice, colours |
| `/mcp` | the connector address for agents that connect from outside ([AGENTS.md](AGENTS.md)) |

### Safety, in one place

- The database holds your keys. Back it up privately; never commit `data/`.
- `npm start` is reachable only from this machine. `npm run serve` asks every
  device for a token and answers private networks only.
- Commands run in a container that sees one folder — or, in a linked folder,
  directly on your PC in that folder, and labelled as such.
- The shared browser uses its own profile, never your everyday one.
- Nothing leaves the sandbox unless you export it.

### Licence

Free for noncommercial use; commercial use needs a paid licence. See
[LICENSE](../LICENSE) and [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md).
