/**
 * The shells the terminal can open a tab in.
 *
 * The Agents' PC has its own command line, and that is one tab. The others
 * are the command lines people already know — Ubuntu, Kali, the Mac's zsh,
 * Git Bash, PowerShell, the Windows Command Prompt — each run for real, by
 * whatever on this machine can run it:
 *
 *  - with a container engine, in a container that sees only the PC's folder
 *    (Ubuntu and Kali from their own images, PowerShell from Microsoft's);
 *  - on Windows without one, through WSL for the Linux ones, Git for Windows
 *    for Git Bash, and Windows' own shells;
 *  - on a Mac or Linux machine, with the shell itself where it is installed.
 *
 * Nothing is imitated. A shell this machine cannot run is listed as
 * unavailable with what to install to get it — a prompt that looked like Kali
 * and ran something else would be worse than no prompt.
 *
 * A shell that runs on the machine rather than in a container runs there
 * under the same rule as everything else: only in a folder the person linked,
 * or after they chose to run without a sandbox.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILES = [
  { id: 'pc', label: "Agents' PC", hint: 'The machine the agents work on. Shell commands, and pc … to drive the machine itself.' },
  { id: 'ubuntu', label: 'Ubuntu', hint: 'bash on Ubuntu', image: 'ubuntu:24.04', wsl: /ubuntu/i, osId: 'ubuntu', install: 'wsl --install -d Ubuntu' },
  { id: 'kali', label: 'Kali Linux', hint: 'bash on Kali', image: 'kalilinux/kali-rolling', wsl: /kali/i, osId: 'kali', install: 'wsl --install -d kali-linux' },
  { id: 'mac', label: 'macOS (zsh)', hint: 'zsh, the shell a Mac opens' },
  { id: 'gitbash', label: 'Git Bash', hint: 'bash, as Git for Windows ships it' },
  { id: 'powershell', label: 'PowerShell', hint: 'Windows PowerShell', image: 'mcr.microsoft.com/powershell:latest' },
  { id: 'cmd', label: 'Command Prompt', hint: 'cmd.exe, the Windows command line' },
];

export const profile = (id) => PROFILES.find((p) => p.id === id) ?? null;

/** Where Git for Windows puts its bash. */
const GIT_BASH = (env) => [
  env.ESPRITS_GIT_BASH,
  env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
].filter(Boolean);

/**
 * What this machine has, looked at once: which shells are on the PATH, which
 * WSL distributions are installed, which Linux this is.
 */
export async function survey({ platform = process.platform, env = process.env, execImpl = execFile, exists = existsSync, read = readFileSync } = {}) {
  const run = (bin, args, encoding = 'utf8') => new Promise((done) => {
    try {
      execImpl(bin, args, { timeout: 6000, windowsHide: true, encoding: 'buffer' }, (err, out) => {
        done(err ? '' : Buffer.from(out ?? '').toString(encoding).replace(/\0/g, ''));
      });
    } catch { done(''); }
  });
  const has = async (bin) => Boolean((await run(platform === 'win32' ? 'where' : 'which', [bin])).trim());

  const out = { platform, wsl: [], osId: '', bash: '', zsh: false, pwsh: false };
  if (platform === 'win32') {
    // wsl.exe answers in UTF-16.
    out.wsl = (await run('wsl.exe', ['-l', '-q'], 'utf16le')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    out.bash = GIT_BASH(env).find((p) => exists(p)) ?? '';
  } else {
    out.bash = (await has('bash')) ? 'bash' : '';
    out.zsh = await has('zsh');
    out.pwsh = await has('pwsh');
    try { out.osId = (String(read('/etc/os-release', 'utf8')).match(/^ID=["']?([\w-]+)/m)?.[1] ?? '').toLowerCase(); } catch { /* not that kind of machine */ }
  }
  return out;
}

/**
 * How one shell would run one command here — or why it cannot.
 *
 * `where` is one of:
 *   'pc'        in the PC's own container, or its folder (the caller knows how)
 *   'exec'      in the PC's container, through another shell that is in it
 *   'container' in a container of its own, made for this command from `image`
 *   'host'      on this machine, in the PC's folder
 */
export function plan({ id, engine = null, have = {}, command = '' }) {
  const p = profile(id);
  if (!p) return { unavailable: `there is no shell called ${id}` };
  const platform = have.platform ?? process.platform;
  const win = platform === 'win32';

  switch (p.id) {
    case 'pc':
      return { where: 'pc', how: engine ? `the PC's ${engine} container` : 'the PC\'s folder on this computer' };

    case 'ubuntu':
    case 'kali': {
      if (engine) return { where: 'container', image: p.image, argv: ['bash', '-lc', command], how: `a ${p.image} container` };
      const distro = (have.wsl ?? []).find((d) => p.wsl.test(d));
      if (win && distro) return { where: 'host', bin: 'wsl.exe', argv: ['-d', distro, '--', 'bash', '-lc', command], wslCd: true, how: `WSL (${distro})` };
      if (!win && have.osId === p.osId && have.bash) return { where: 'host', bin: 'bash', argv: ['-lc', command], how: `this machine, which is ${p.label}` };
      return { unavailable: win
        ? `${p.label} is not on this computer. Install it with:  ${p.install}  — or start Docker and it runs in a container.`
        : `${p.label} needs Docker or Podman running — it runs in a ${p.image} container.` };
    }

    case 'mac':
      if (platform === 'darwin') return { where: 'host', bin: 'zsh', argv: ['-lc', command], how: 'zsh on this Mac' };
      if (engine) return { where: 'exec', argv: ['sh', '-c', 'command -v zsh >/dev/null 2>&1 || { echo "zsh is not installed on the Agents\' PC yet. Run:  apt-get update && apt-get install -y zsh   (in the Agents\' PC tab, with the network on)"; exit 127; }; exec zsh -c "$1"', 'zsh', command], how: 'zsh in the PC\'s container — the Mac\'s shell, not macOS itself' };
      if (have.zsh) return { where: 'host', bin: 'zsh', argv: ['-c', command], how: 'zsh on this machine — the Mac\'s shell, not macOS itself' };
      return { unavailable: win
        ? 'zsh is not on this computer, and macOS itself only runs on a Mac. Start Docker and zsh runs in the PC\'s container, or install it inside WSL.'
        : 'zsh is not installed. Install it (apt install zsh), or start Docker.' };

    case 'gitbash':
      if (win && have.bash) return { where: 'host', bin: have.bash, argv: ['-lc', command], how: 'Git for Windows' };
      if (engine) return { where: 'exec', argv: ['bash', '-lc', command], how: 'bash in the PC\'s container' };
      if (!win && have.bash) return { where: 'host', bin: 'bash', argv: ['-lc', command], how: 'bash on this machine' };
      return { unavailable: win ? 'Git Bash is not installed. Get Git for Windows from git-scm.com — it comes with it.' : 'bash is not installed.' };

    case 'powershell':
      if (win) return { where: 'host', bin: 'powershell.exe', argv: ['-NoProfile', '-NonInteractive', '-Command', command], how: 'Windows PowerShell' };
      if (engine) return { where: 'container', image: p.image, argv: ['pwsh', '-NoLogo', '-NoProfile', '-Command', command], how: 'PowerShell in a container' };
      if (have.pwsh) return { where: 'host', bin: 'pwsh', argv: ['-NoLogo', '-NoProfile', '-Command', command], how: 'PowerShell on this machine' };
      return { unavailable: 'PowerShell is not installed. Install pwsh, or start Docker and it runs in a container.' };

    case 'cmd':
      if (win) return { where: 'host', bin: 'cmd.exe', argv: ['/d', '/s', '/c', command], verbatim: true, how: 'Windows' };
      return { unavailable: 'The Command Prompt exists only on Windows.' };

    default:
      return { unavailable: `there is no shell called ${id}` };
  }
}

/** A line that only changes folder, in any of these shells — and where to. Null when it is anything else. */
export function cdTarget(line) {
  const m = String(line ?? '').trim().match(/^(?:cd|chdir|Set-Location|sl)(?:\s+\/d)?(?:\s+(?:-Path\s+)?(.+))?$/i);
  if (!m) return null;
  let to = (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
  if (/[;&|]/.test(to)) return null;
  if (to === '' || to === '~' || to === '/' || to === '\\') to = '';
  return { to };
}
