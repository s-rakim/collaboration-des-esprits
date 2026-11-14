#!/usr/bin/env node
/**
 * Check the skills the way a marketplace will, and zip them.
 *
 *   npm run skills:check   — lint only; exits 1 if anything would be refused
 *   npm run skills:build   — lint, then write dist/skills/*.zip
 *
 * The check runs first either way. Finding out by uploading is a day per round
 * trip; finding out here is a second.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAll } from '../src/skillpack.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

/** The room's real tools, read from where they are declared — never from a list kept beside it. */
export function roomTools() {
  const src = readFileSync(join(ROOT, 'src', 'mcp', 'tools.js'), 'utf8');
  return [...src.matchAll(/\btool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

const out = buildAll({ skillsDir: join(ROOT, 'skills'), mcpTools: roomTools() });

for (const s of out.skills) {
  const mark = s.errors.length ? 'FAIL' : s.warnings.length ? 'warn' : ' ok ';
  console.log(`  ${mark}  ${s.name.padEnd(22)} ${String(s.score).padStart(3)}/100  ${s.files} file(s), ${(s.bytes / 1024).toFixed(1)} KB${s.inPack ? '' : '   (listed alone: needs the room)'}`);
  for (const e of s.errors) console.log(`          refused: ${e}`);
  for (const w of s.warnings) console.log(`          warning: ${w}`);
}
if (out.repeated.length) console.log(`\n  two skills share a name: ${out.repeated.join(', ')}`);

if (!out.ok) {
  console.log('\nnot built — fix what would be refused first');
  process.exit(1);
}
if (checkOnly) {
  console.log(`\n${out.skills.length} skills would pass`);
  process.exit(0);
}

const dist = join(ROOT, 'dist', 'skills');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const [name, bytes] of out.archives) writeFileSync(join(dist, name), bytes);

// What the upload form asks for, in one place, so listing is copying.
const listing = out.skills.map((s) => ({
  name: s.name,
  summary: s.meta.summary ?? '',
  description: s.meta.description ?? '',
  version: s.meta.version ?? '',
  tags: s.meta.tags ?? [],
  keywords: s.meta.keywords ?? [],
  use_cases: s.meta.use_cases ?? [],
  archive: `${s.dir}.zip`,
  in_pack: s.inPack,
}));
writeFileSync(join(dist, 'listing.json'), `${JSON.stringify({ pack: out.pack, skills: listing }, null, 2)}\n`);

console.log(`\nwrote ${out.archives.size} archives to dist/skills/`);
if (out.pack) console.log(`  the pack: ${out.pack.name} — ${out.pack.skills.length} skills`);
