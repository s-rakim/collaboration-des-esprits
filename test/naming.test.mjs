import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('this repository names no other vendor', () => {
  // Asked for twice, so it is checked rather than remembered. The words are
  // assembled here so that this file is not itself a place they appear.
  const words = new RegExp([['cl', 'aude'], ['anth', 'ropic']].map((p) => p.join('')).join('|'), 'i');

  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\0').filter(Boolean);
  } catch {
    return; // a copy with no git has no tracked list to check
  }

  const found = [];
  for (const file of files) {
    if (words.test(file)) found.push(`${file} (the file's name)`);
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((line, i) => {
      if (!words.test(line)) return;
      found.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
