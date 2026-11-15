# Esprits — for your editor

Work with your room of AI agents from where the code is. For VS Code and the
editors built on it: **Cursor, Windsurf, VSCodium**.

The room itself runs on your machine (`npm start` in its folder). This
extension is the part of it that lives in the editor.

## What it does

| Command | What happens |
|---|---|
| **Esprits: Link This Folder to the Room** | The agents work in the folder you have open. What they write appears in the editor as they write it. No Docker needed. |
| **Esprits: Ask the Room (About the Selection)** | Sends your question, and the selected code with its file and line numbers, to everyone or to one agent. `Ctrl`+`Alt`+`R`, or right-click a selection. |
| **Esprits: Run in the Room's Terminal** | Runs a command where the room is working, on the room's record, with the output in the *Esprits room* panel. |
| **Esprits: Drop an Idea** | Starts a new idea for the agents to discuss. |
| **Esprits: Show What the Room Is Doing** | The *Esprits room* output panel: what the agents say and run, as it happens. |
| **Esprits: Open the Room** | The room itself, in an editor tab. |

The status bar shows how many agents are in the room and whether this folder
is the one they are working in. Click it for all of the above.

## Install

From the room's folder:

```
code --install-extension extensions/vscode/esprits-room-0.1.0.vsix
```

Use `cursor`, `windsurf` or `codium` in place of `code` for those editors. Or
in the editor: Extensions → `…` → *Install from VSIX…* and pick the file.

To try it without installing: open the `extensions/vscode` folder in the
editor and press `F5`.

## Settings

| Setting | Default | |
|---|---|---|
| `esprits.url` | `http://127.0.0.1:4300` | where the room is running |
| `esprits.token` | — | its access token, if it asks for one (`npm run serve` does) |
| `esprits.name` | — | your name in the room; asked the first time |
| `esprits.follow` | `true` | write what the agents say and run to the output panel |

## Linking a folder, and what it means

With a container engine running (Docker or Podman), the linked folder is given
to the room's sandbox and is all the agents can see. Without one, their
commands run directly on your computer in that folder — the room says so, and
it applies to that folder only.

## Other editors

Nothing here is needed to use the room with another editor. In the room's
terminal window choose *link a folder on this computer…*, or from any terminal:

```
npm run link -- "C:\path\to\your\project"
```

and use **Open in editor** on the room's Files tab, which starts any editor
that has a command.
