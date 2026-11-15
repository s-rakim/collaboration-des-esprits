/**
 * Opening the room to your other devices.
 *
 * `npm start` listens on this machine only. `npm run serve` is the same room,
 * reachable from a phone on the same Wi-Fi, a laptop on the VPN, or anything
 * on your tailnet — and from nowhere else. Three things make that safe enough
 * to be one command:
 *
 *  - It asks for a token. One is made the first time and kept beside the
 *    database, so there is nothing to invent and nothing to put in a file.
 *  - It answers private addresses only. Listening on every interface is what
 *    lets a VPN that connects later still reach it; refusing a caller whose
 *    own address is a public one is what stops that from meaning "the
 *    internet" on a machine that has a public address.
 *  - It says where it is. The address to type is different on every network
 *    the machine is on, and working that out is exactly the step people get
 *    stuck at.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * What kind of address this is.
 *
 * loopback — this machine. private — a home or office network, a VPN, or a
 * tailnet (100.64/10 is the range Tailscale hands out). everything — all
 * interfaces at once. Anything else, including any hostname, is public.
 */
export function addressKind(host) {
  let h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  // An IPv4 caller seen through an IPv6 socket.
  if (h.startsWith('::ffff:')) h = h.slice(7);
  // A link-local address carries the interface it came in on.
  h = h.replace(/%.*$/, '');
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.')) return 'loopback';
  if (h === '0.0.0.0' || h === '::' || h === '*') return 'everything';

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)) return 'private';
    return 'public';
  }
  // Tailscale's own IPv6 range is inside fd00::/8, with the rest of unique-local.
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return 'private';
  return 'public';
}

/** May somebody calling from this address be answered at all? */
export const callerAllowed = (remote) => ['loopback', 'private'].includes(addressKind(remote));

/** Letters and digits that cannot be mistaken for each other when read off one screen and typed on another. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function makeToken() {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/**
 * The room's access token: the one in the environment, else the one kept
 * beside the database, else a new one that is then kept there.
 */
export function accessToken({ dbPath, env = process.env }) {
  if (env.ESPRITS_TOKEN) return { token: env.ESPRITS_TOKEN, from: 'ESPRITS_TOKEN', file: null };
  const dir = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : join(process.cwd(), 'data');
  const file = join(dir, 'access-token');
  if (existsSync(file)) {
    const kept = readFileSync(file, 'utf8').trim();
    if (kept) return { token: kept, from: 'file', file };
  }
  const token = makeToken();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${token}\n`);
  // Best effort: a Windows volume has no such thing as a mode.
  try { chmodSync(file, 0o600); } catch { /* not fatal */ }
  return { token, from: 'new', file };
}

/** A name for the network an address is on, from the address and the adapter it sits on. */
function networkName(address, adapter) {
  const [a, b] = address.split('.').map(Number);
  if ((a === 100 && b >= 64 && b <= 127) || /tailscale/i.test(adapter)) return 'Tailscale';
  if (/wireguard|wg\d|tun\d|tap\d|vpn|zerotier|nord|proton|openvpn|utun/i.test(adapter)) return 'VPN';
  if (/wi-?fi|wlan|wireless/i.test(adapter)) return 'Wi-Fi';
  if (/ethernet|^eth|^en\d/i.test(adapter)) return 'Ethernet';
  return 'LAN';
}

/**
 * Every address another device could use to reach this machine.
 *
 * IPv4 only: it is what a person can read off one screen and type on
 * another. Virtual adapters that lead nowhere another device can stand —
 * container bridges, a hypervisor's switch — are left out, since an address
 * that looks right and cannot work is worse than a shorter list.
 */
export function reachable(interfaces = networkInterfaces()) {
  const out = [];
  for (const [adapter, list] of Object.entries(interfaces)) {
    if (/docker|veth|vethernet|br-|virbr|vmware|virtualbox|hyper-v|wsl|loopback/i.test(adapter)) continue;
    for (const item of list ?? []) {
      if (item.internal || (item.family !== 'IPv4' && item.family !== 4)) continue;
      const kind = addressKind(item.address);
      if (kind === 'loopback' || item.address.startsWith('169.254.')) continue;
      out.push({ address: item.address, adapter, public: kind === 'public', network: kind === 'public' ? 'public' : networkName(item.address, adapter) });
    }
  }
  // Tailscale first: it is the one that works from anywhere.
  const rank = { Tailscale: 0, VPN: 1, 'Wi-Fi': 2, Ethernet: 3, LAN: 4, public: 9 };
  return out.sort((x, y) => (rank[x.network] ?? 5) - (rank[y.network] ?? 5) || x.address.localeCompare(y.address));
}

/** What to tell the person who just ran it: where the room is, from each network, and the way in. */
export function shareBanner({ port, token, from, file, addresses = reachable(), platform = process.platform, name = hostname() }) {
  const priv = addresses.filter((a) => !a.public);
  const pub = addresses.filter((a) => a.public);
  const lines = ['', 'Open the room from another device'];
  if (!priv.length) {
    lines.push('  This machine is not on a network another device could reach it by.',
      '  Connect to Wi-Fi, a VPN or Tailscale; the room will answer on it without a restart.');
  } else {
    const width = Math.max(...priv.map((a) => a.network.length));
    for (const a of priv) lines.push(`  ${a.network.padEnd(width)}  http://${a.address}:${port}/`);
    if (priv.some((a) => a.network === 'Tailscale')) {
      lines.push(`  ${''.padEnd(width)}  http://${name.toLowerCase()}:${port}/   (by name, with MagicDNS on)`);
    }
  }
  lines.push(
    '',
    `  Access token   ${token}`,
    `                 ${from === 'new' ? `made just now and kept in ${file}` : from === 'file' ? `kept in ${file} — delete that file for a new one` : 'from ESPRITS_TOKEN'}`,
    '  Each device asks for it once, then stays signed in for 30 days.',
    `  On this machine: http://127.0.0.1:${port}/unlock#${token}`,
    '',
    '  Only devices on a private network are answered — your LAN, a VPN, your tailnet.',
    '  A LAN is not encrypted: on a network you share with strangers, use Tailscale instead.',
  );
  if (pub.length) {
    lines.push(`  This machine also has a public address (${pub.map((a) => a.address).join(', ')}). Callers from the internet are refused.`);
  }
  if (platform === 'win32') {
    lines.push(
      '',
      '  If another device cannot connect, Windows Firewall is the usual reason. When Windows asks',
      '  whether to allow Node.js, tick "Private networks". If it never asked, run this once in an',
      '  administrator PowerShell:',
      `    netsh advfirewall firewall add rule name="Collaboration des Esprits" dir=in action=allow protocol=TCP localport=${port}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
