/**
 * Packaging skills for somewhere other than this room.
 *
 * A skill here is instructions a model reads. The same instructions are worth
 * having in other agents, and the places that distribute them all take the same
 * thing: a folder with a SKILL.md at its root, front matter naming it, zipped.
 *
 * Three jobs, kept together because each is useless without the others:
 *
 *   lint   — say what a marketplace's scan will say, before it says it. They
 *            check structure, file types, dangerous commands, secrets,
 *            environment harvesting, obfuscation and injected instructions,
 *            and finding out by upload is a day per round trip.
 *   zip    — write the archive, with nothing but what Node already has.
 *   export — turn a skill already in this room into that archive, so the
 *            thing somebody wrote for their own agents can go on a shelf.
 */

import { deflateRawSync, crc32 } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { findSecrets } from './secrets.js';

// ----------------------------------------------------------------- front matter

/**
 * Read the front matter of a SKILL.md.
 *
 * Only the YAML a skill actually uses: `key: value`, quoted or not, and flow
 * lists. Anything cleverer is reported rather than guessed at, because a field
 * this reads differently from the next parser is worse than a field it refuses.
 */
export function readFrontMatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, body: src.trim(), problems: ['no front matter — the file must start with a --- block'] };

  const data = {};
  const problems = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) { problems.push(`front matter line not understood: "${line.trim().slice(0, 60)}"`); continue; }
    const raw = kv[2].trim();
    if (/^[>|]/.test(raw)) {
      problems.push(`"${kv[1]}" uses a block scalar (> or |) — write it on one line, in quotes`);
      continue;
    }
    if (/^\[.*\]$/.test(raw)) {
      data[kv[1]] = raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
      continue;
    }
    const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
    // An unquoted value with ": " in it is a mapping to YAML, not a sentence.
    if (!quoted && /:\s/.test(raw)) problems.push(`"${kv[1]}" contains ": " and is not quoted — quote the whole value`);
    data[kv[1]] = quoted ? quoted[2] : raw;
  }
  return { data, body: src.slice(m[0].length).trim(), problems };
}

// ------------------------------------------------------------------------ lint

const EXECUTABLE = /\.(exe|dll|so|dylib|bin|app|dmg|msi|deb|rpm|wasm|class|jar|war)$/i;
const UNREADABLE = /\.(png|jpe?g|gif|webp|pdf|ico|bmp)$/i;

/** What a scan refuses outright. Each names the thing, so the fix is obvious. */
const DANGEROUS = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, what: 'pipes a download into a shell' },
  { re: /\bos\.system\s*\(/, what: 'calls os.system' },
  { re: /\bshell\s*=\s*True\b/, what: 'runs a subprocess with shell=True' },
  { re: /\bchmod\s+(?:-R\s+)?777\b/, what: 'chmod 777' },
  { re: /\brm\s+-rf?\s+(?:\/|~)(?:\s|$)/, what: 'deletes from the root or the home directory' },
];

const HARVESTING = [
  { re: /\bprintenv\b|\benv\s*\|\s*(?:curl|nc|base64)/i, what: 'dumps the environment' },
  { re: /\bos\.environ\b(?!\s*(?:\[|\.get\())/, what: 'reads the whole environment (os.environ)' },
  { re: /JSON\.stringify\(\s*process\.env\s*\)/, what: 'serialises process.env' },
  { re: /~\/\.(?:ssh|aws|netrc)\b|\.env\b[^\n]{0,40}\b(?:curl|fetch|post|upload)/i, what: 'reaches for credentials on disk' },
];

const OBFUSCATED = [
  { re: /\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:ba)?sh\b/i, what: 'decodes base64 into a shell' },
  { re: /\beval\s*\(\s*atob\s*\(/, what: 'evaluates a decoded string' },
  { re: /[A-Za-z0-9+/]{240,}={0,2}/, what: 'carries a long encoded blob' },
];

/**
 * Instructions aimed at the reader's own instructions rather than at the task.
 * A skill is handed to a model as trusted text, so these are the phrases a
 * marketplace looks for, and the ones a skill has no honest reason to contain.
 */
const INJECTION = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules)/i,
  /disregard (?:the |your |all )?(?:system prompt|previous instructions|prior instructions)/i,
  /do not (?:tell|inform|reveal to|mention (?:this )?to) the user/i,
  /you are now (?:in )?(?:developer|dan|jailbreak|unrestricted)/i,
  /reveal (?:your |the )?system prompt/i,
];

/** Calls that exist only inside a running room. A standalone skill using one cannot work. */
const ROOM_ONLY_CALL = /\b(brief|propose|weigh_in|claim_next|catch_up|request_floor|wait_for_turn|take_handoff|update_task|resolve_objection|remember|recall|decide|handoff)\s*\(/;

/** The stricter of the two upload routes, so a pack that passes here fits both. */
export const LIMITS = { files: 100, bytes: 5 * 1024 * 1024, scriptBytes: 20 * 1024, bodyLines: 500 };

/**
 * Check one skill the way it will be checked on arrival.
 *
 * `files` maps a path inside the skill to its bytes, SKILL.md included.
 * `errors` would be refused; `warnings` cost points and are worth a look.
 * `mcpTools`, when given, is the real list of this room's tools: a skill that
 * says it drives the room is held to naming only tools that exist.
 */
export function lintSkill({ dir, files, mcpTools = null }) {
  const errors = [];
  const warnings = [];
  const manifest = files.get('SKILL.md');
  if (!manifest) return { name: dir, errors: ['no SKILL.md at the root of the skill'], warnings, meta: {} };

  const { data, body, problems } = readFrontMatter(manifest.toString('utf8'));
  errors.push(...problems);
  const meta = data ?? {};

  // --- structure
  const name = String(meta.name ?? '');
  if (!name) errors.push('front matter has no name');
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push(`name "${name}" must be lowercase letters, digits and single hyphens`);
    if (name.length > 64) errors.push(`name is ${name.length} characters; the limit is 64`);
    if (dir && name !== dir) errors.push(`name "${name}" does not match its folder "${dir}"`);
  }
  const description = String(meta.description ?? '');
  if (!description) errors.push('front matter has no description');
  else {
    if (description.length > 1024) errors.push(`description is ${description.length} characters; the limit is 1024`);
    if (description.length < 80) warnings.push('description is very short — it is all an agent has to decide whether to load this');
    // An agent picks a skill by its description alone, so it has to say when.
    if (!/\buse (?:when|at|before|after|for|this)\b/i.test(description)) {
      warnings.push('description does not say when to use the skill ("Use when …")');
    }
  }
  if (meta.version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(meta.version))) {
    errors.push(`version "${meta.version}" is not major.minor.patch`);
  }
  const lines = body ? body.split('\n').length : 0;
  if (lines < 15) errors.push('the body is too thin to be instructions an agent can follow');
  if (lines > LIMITS.bodyLines) warnings.push(`the body is ${lines} lines; past ${LIMITS.bodyLines} an agent reads it badly — move detail into references/`);

  // --- files
  let total = 0;
  for (const [path, bytes] of files) {
    total += bytes.length;
    if (EXECUTABLE.test(path)) errors.push(`${path}: executables are refused`);
    else if (UNREADABLE.test(path)) warnings.push(`${path}: an agent cannot read images or PDFs`);
    else if (bytes.includes(0)) errors.push(`${path}: not a text file`);
    if (/(^|\/)(node_modules|site-packages|\.venv|venv)\//.test(path)) errors.push(`${path}: bundled dependencies are not allowed`);
    if (/^scripts\//.test(path) && bytes.length > LIMITS.scriptBytes) warnings.push(`${path}: scripts are best kept under 20 KB`);
  }
  if (files.size > LIMITS.files) errors.push(`${files.size} files; the limit is ${LIMITS.files}`);
  if (total > LIMITS.bytes) errors.push(`${(total / 1048576).toFixed(1)} MB; the limit is 5 MB`);

  // --- content of every text file
  for (const [path, bytes] of files) {
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const { re, what } of DANGEROUS) if (re.test(text)) errors.push(`${path}: ${what}`);
    for (const { re, what } of HARVESTING) if (re.test(text)) errors.push(`${path}: ${what}`);
    for (const { re, what } of OBFUSCATED) if (re.test(text)) errors.push(`${path}: ${what}`);
    for (const re of INJECTION) {
      const hit = text.match(re);
      if (hit) errors.push(`${path}: reads as an instruction about the reader's instructions ("${hit[0]}")`);
    }
    for (const s of findSecrets(text)) errors.push(`${path}:${s.line}: ${s.kind} — ${s.preview}`);
  }

  // --- links to files that are not in the package
  for (const m of body.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const target = m[1].replace(/^\.\//, '').replace(/#.*$/, '');
    if (target && !files.has(target)) errors.push(`SKILL.md links to ${target}, which is not in the package`);
  }

  // --- does it work where it says it works?
  const drivesRoom = Array.isArray(meta.tags) && meta.tags.includes('mcp');
  if (!drivesRoom) {
    const call = body.match(ROOM_ONLY_CALL);
    if (call) {
      errors.push(`calls ${call[1]}(), which exists only inside a running room — a standalone skill cannot use it`);
    }
  } else if (mcpTools) {
    // Anything in backticks with an underscore is being presented as a tool.
    const named = new Set([...body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]));
    for (const tool of named) {
      if (!mcpTools.includes(tool)) errors.push(`names a tool the room does not have: ${tool}`);
    }
    if (!/requires|needs/i.test(description)) {
      warnings.push('description should say up front that it needs the MCP server connected');
    }
  }

  return { name: name || dir, errors, warnings, meta, score: Math.max(0, 100 - 20 * errors.length - 5 * warnings.length) };
}

// ------------------------------------------------------------------------- zip

/**
 * Write a zip archive.
 *
 * Deterministic on purpose: the same files give the same bytes, with a fixed
 * timestamp and sorted names, so a rebuild that changed nothing changes nothing
 * and a diff between two builds is a diff between their contents.
 */
export function zip(entries) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest the format can say

  const locals = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of sorted) {
    const name = Buffer.from(path, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const packed = deflateRawSync(raw, { level: 9 });
    const stored = packed.length < raw.length ? packed : raw;
    const method = stored === packed ? 8 : 0;
    const sum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + stored.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ------------------------------------------------------------------- from disk

/** Every file under a folder, as path → bytes, with forward slashes. */
export function readTree(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.DS_Store' || name === 'Thumbs.db') continue;
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, path);
      else out.set(path, readFileSync(full));
    }
  };
  walk(root, '');
  return out;
}

/** The skills in a folder: each subfolder holding a SKILL.md. */
export function readSkills(skillsDir) {
  return readdirSync(skillsDir)
    .filter((d) => { try { return statSync(join(skillsDir, d, 'SKILL.md')).isFile(); } catch { return false; } })
    .sort()
    .map((dir) => ({ dir, files: readTree(join(skillsDir, dir)) }));
}

/**
 * Lint every skill and build the archives.
 *
 * One zip per skill, each holding its own folder, and one pack: a README and
 * every skill that works on its own. A skill that needs this room's server is
 * listed by itself, because a pack sold as "works anywhere" has to.
 */
export function buildAll({ skillsDir, mcpTools = null, packName = 'room-in-plain-files' }) {
  const skills = readSkills(skillsDir);
  const reports = skills.map((s) => ({ ...s, report: lintSkill({ dir: s.dir, files: s.files, mcpTools }) }));

  const names = reports.map((r) => r.report.name);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);

  const archives = new Map();
  for (const { dir, files } of reports) {
    archives.set(`${dir}.zip`, zip([...files].map(([path, data]) => [`${dir}/${path}`, data])));
  }

  const standalone = reports.filter((r) => !(r.report.meta.tags ?? []).includes('mcp'));
  const pack = [];
  let readme = null;
  try { readme = readFileSync(join(skillsDir, 'README.md')); } catch { /* a pack without one still zips */ }
  if (readme) pack.push(['README.md', readme]);
  for (const { dir, files } of standalone) {
    for (const [path, data] of files) pack.push([`skills/${dir}/${path}`, data]);
  }
  if (standalone.length > 1) archives.set(`${packName}.zip`, zip(pack));

  return {
    ok: reports.every((r) => !r.report.errors.length) && !repeated.length,
    repeated,
    skills: reports.map((r) => ({
      dir: r.dir,
      ...r.report,
      files: r.files.size,
      bytes: [...r.files.values()].reduce((n, b) => n + b.length, 0),
      inPack: standalone.includes(r),
    })),
    pack: standalone.length > 1 ? { name: `${packName}.zip`, skills: standalone.map((r) => r.dir), readme: Boolean(readme) } : null,
    archives,
  };
}

// --------------------------------------------------------------- from the room

/**
 * A skill already in this room, as the folder a marketplace takes.
 *
 * The room stores the body and the description apart from each other; a
 * SKILL.md wants them back together under front matter. Files the skill brought
 * with it come along when they are text, and the ones that are not are named
 * rather than silently dropped.
 */
export function exportSkill(skill, { fileText = () => '' } = {}) {
  const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const front = [
    '---',
    `name: ${skill.name}`,
    `description: "${oneLine(skill.description)}"`,
    ...(skill.title ? [`summary: "${oneLine(skill.title)}"`] : []),
    'version: 1.0.0',
    '---',
    '',
  ].join('\n');

  const files = new Map([['SKILL.md', Buffer.from(`${front}${String(skill.body).trim()}\n`, 'utf8')]]);
  const left = [];
  for (const f of skill.files ?? []) {
    const text = f.readable ? fileText(f.path) : '';
    if (text) files.set(f.path, Buffer.from(text, 'utf8'));
    else left.push(f.path);
  }

  const report = lintSkill({ dir: skill.name, files });
  return {
    filename: `${skill.name}.zip`,
    archive: zip([...files].map(([path, data]) => [`${skill.name}/${path}`, data])),
    report,
    leftOut: left,
  };
}
