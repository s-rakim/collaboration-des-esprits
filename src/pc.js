/**
 * The Agents' PC, driven from its own command line.
 *
 * The PC is the machine the agents work on: a folder, a terminal, a browser,
 * and — when there is a container engine — walls around all three. Everything
 * about it that can be changed with a button can be changed by typing, in the
 * same terminal as everything else, with a line that starts `pc`. A person who
 * lives in the terminal never has to leave it, and what they did to the machine
 * is on the same record as what they ran on it.
 *
 * These are a person's commands. An agent's command line goes to the shell,
 * where `pc` is nothing; the machine's own settings are not theirs to change.
 */

const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const HELP = `The Agents' PC — commands
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
Anything else you type is run on the PC as a shell command.`;

/** Split a line into words, keeping what is in quotes together. */
export function words(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export const isPcCommand = (line) => /^pc(\s|$)/i.test(String(line ?? '').trim());

export function createPc({ sandbox, terminal, threads = null, browser = null }) {
  const onOff = (word) => {
    if (/^(on|yes|true|1)$/i.test(word ?? '')) return true;
    if (/^(off|no|false|0)$/i.test(word ?? '')) return false;
    throw new Error('say on or off');
  };

  async function statusText() {
    const s = await sandbox.status();
    return [
      `state     ${s.preparing ? 'getting ready' : s.isolated ? `sandboxed (${s.engine}, ${s.image})` : s.linked ? 'linked folder — runs on this computer' : s.unconfined ? 'NOT sandboxed — runs on this computer' : `cannot run anything: ${s.why}`}`,
      `folder    ${s.folder}${s.linked ? ' (linked)' : ''}`,
      `runs in   ${s.dir}`,
      `on disk   ${s.hostDir}`,
      `network   ${s.network ? 'on' : 'off'}`,
      `agents    ${terminal.agentsAllowed() ? 'may use the terminal' : 'may not use the terminal'}`,
      s.error ? `error     ${s.error}` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * Run one `pc …` line for a person. Gives back what a terminal would show:
   * the text, and whether it worked.
   */
  async function run(line, by) {
    const [, verb = 'help', ...args] = words(String(line).trim());
    const rest = String(line).trim().replace(/^pc\s+\S+\s*/i, '');
    try {
      return { ok: true, text: await handle(verb.toLowerCase(), args, rest, by) };
    } catch (err) {
      return { ok: false, text: `pc ${verb}: ${err.message}` };
    }
  }

  async function handle(verb, args, rest, by) {
    switch (verb) {
      case 'help': case '-h': case '--help': case '?':
        return HELP;

      case 'status': case 'info':
        return statusText();

      case 'folders': {
        const s = await sandbox.status();
        const linked = new Map(s.links.map((l) => [l.name, l.path]));
        return s.folders.map((f) => `${f === s.folder ? '*' : ' '} ${f}${linked.has(f) ? `  ->  ${linked.get(f)}` : ''}`).join('\n');
      }

      case 'use': case 'cd': {
        if (!args[0]) throw new Error('which folder? pc use <name>');
        const f = sandbox.setFolder(args[0]);
        return `working in ${f.name}`;
      }

      case 'link': {
        if (!args[0]) throw new Error('which folder of this computer? pc link <path> [name]');
        const l = sandbox.link({ path: args[0], name: args[1] });
        return `linked ${l.name} — working in ${l.hostDir}`;
      }

      case 'unlink': {
        const name = args[0] ?? sandbox.folder().name;
        sandbox.unlink(name);
        return `let go of ${name}; nothing in it was deleted`;
      }

      case 'ls': case 'dir': {
        const t = sandbox.tree();
        const at = (args[0] ?? '').replace(/^\.?\/+|\/+$/g, '').replace(/^\.$/, '');
        const depth = at ? at.split('/').length : 0;
        const rows = t.entries.filter((e) => (at ? e.path.startsWith(`${at}/`) : true) && e.path.split('/').length === depth + 1);
        if (at && !t.entries.some((e) => e.path === at && e.kind !== 'file')) throw new Error(`there is no folder ${at}`);
        if (!rows.length) return '(empty)';
        return rows.map((e) => {
          const name = e.path.split('/').pop();
          return e.kind === 'file' ? `${name.padEnd(36)} ${size(e.size).padStart(10)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')}` : `${name}/`;
        }).join('\n');
      }

      case 'cat': case 'type': {
        if (!args[0]) throw new Error('which file?');
        const f = sandbox.read({ path: args[0] });
        if (f.binary) return `${f.path} is not text (${size(f.size)})`;
        return f.text + (f.clipped ? '\n… the rest is not shown' : '');
      }

      case 'write': {
        if (!args[0]) throw new Error('pc write <file> <text>');
        const text = rest.slice(rest.indexOf(args[0]) + args[0].length).replace(/^["']?\s+/, '');
        const w = sandbox.write({ path: args[0], text: text ? `${text.replace(/\\n/g, '\n')}\n` : '' });
        return `wrote ${w.path} (${size(w.size)})`;
      }

      case 'mkdir':
        if (!args[0]) throw new Error('which folder?');
        return `made ${sandbox.makeDir({ path: args[0] }).path}/`;

      case 'mv': case 'move': case 'rename': {
        if (!args[1]) throw new Error('pc mv <from> <to>');
        const m = sandbox.move({ from: args[0], to: args[1] });
        return `${m.from} -> ${m.to}`;
      }

      case 'rm': case 'del': case 'delete':
        if (!args[0]) throw new Error('which file or folder?');
        return `deleted ${sandbox.remove({ path: args[0] }).path}`;

      case 'ps': case 'top': {
        const runs = terminal.running();
        const work = threads?.running() ?? [];
        return [
          runs.length ? 'commands' : 'no command is running',
          ...runs.map((r) => `  ${String(r.id).padEnd(6)} ${r.by.padEnd(14)} ${r.command.slice(0, 80)}`),
          work.length ? 'threads' : 'no thread is working',
          ...work.map((t) => `  ${String(t.id).padEnd(6)} ${String(t.seat ?? '').padEnd(14)} ${t.title}`),
        ].join('\n');
      }

      case 'stop': case 'kill': {
        if (!args[0]) throw new Error('which command? pc stop <id> — pc ps lists them');
        const ids = args[0] === 'all' ? terminal.running().map((r) => r.id) : [Number(args[0])];
        const stopped = ids.filter((id) => terminal.stop(id));
        if (!stopped.length) throw new Error(args[0] === 'all' ? 'nothing is running' : `command ${args[0]} is not running`);
        return `stopped ${stopped.join(', ')}`;
      }

      case 'tell': case 'steer': {
        if (!threads) throw new Error('there are no threads here');
        const id = Number(args[0]);
        const text = rest.replace(/^\S+\s*/, '').trim();
        if (!id || !text) throw new Error('pc tell <thread id> <what to say> — pc ps lists the threads');
        const r = threads.note(id, { text, by });
        return `thread ${id} will hear that ${r.heard}`;
      }

      case 'network': case 'net':
        sandbox.configure({ network: onOff(args[0]) });
        return `network ${onOff(args[0]) ? 'on' : 'off'} — it applies to commands started from now`;

      case 'agents':
        terminal.setAgentsAllowed(onOff(args[0]));
        return `agents ${onOff(args[0]) ? 'may' : 'may not'} use the terminal`;

      case 'restart': case 'reboot':
        await sandbox.restart();
        return `restarted\n${await statusText()}`;

      case 'open': {
        const r = await sandbox.openInEditor({ path: args[0] });
        return `opened ${r.opened} with ${r.with}`;
      }

      case 'export': {
        if (!args[0]) throw new Error('to where? pc export <a folder on this computer>');
        const r = sandbox.exportTo({ to: args[0] });
        return `copied ${r.files} file(s) to ${r.to}`;
      }

      case 'browse': case 'browser': {
        if (!browser) throw new Error('there is no browser here');
        if (!args[0]) throw new Error('which address, or what to search for?');
        const typed = rest.trim();
        const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || /^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(typed);
        const page = address ? await browser.open({ url: typed, by }) : await browser.search({ query: typed, by });
        return `opened ${page?.title || page?.url || rest.trim()}`;
      }

      default:
        throw new Error('not a command the PC knows — pc help lists them');
    }
  }

  return { run, help: HELP };
}
