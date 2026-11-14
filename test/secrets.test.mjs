import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSecrets, looksDeclaredFake } from '../src/secrets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Keys shaped like the real thing, assembled here rather than written out.
 *
 * A test that proves the scanner finds a key needs a key the scanner would
 * find, and a literal one in this file would be found by the very check below.
 * Building them at run time keeps the proof and keeps the file clean.
 */
const shaped = {
  nvidia: `nvapi-${'Qz7'.repeat(21)}Q`,
  skAnt: `sk-ant-${'Lm4_'.repeat(12)}`,
  openai: `sk-${'pR8k'.repeat(12)}`,
  groq: `gsk_${'Wv3n'.repeat(12)}`,
  huggingface: `hf_${'Tq6m'.repeat(9)}`,
  google: `AIza${'Zk5u'.repeat(8)}Zk5`,
  github: `ghp_${'Hd2y'.repeat(9)}`,
  telegram: `7${'4'.repeat(9)}:${'Bq9w'.repeat(8)}Bq9`,
};

test('a credential-shaped string is found, and never repeated in full', () => {
  for (const [name, key] of Object.entries(shaped)) {
    const found = findSecrets(`line one\nconst k = "${key}";\nline three`);
    assert.equal(found.length, 1, `${name} was not recognised`);
    assert.equal(found[0].line, 2);
    // Enough to find it, never enough to use it: the report goes into logs and
    // test output, which is exactly where a key must not turn up a second time.
    assert.ok(!found[0].preview.includes(key), `${name} was printed whole`);
    assert.match(found[0].preview, /characters\)$/);
  }
});

test('a fixture that says it is not a key is let through', () => {
  // The rule is not that keys must look fake to a clever reader. It is that
  // they must say so, where the next person will see it without being clever.
  for (const declared of [
    'nvapi-NOT-A-REAL-KEY_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM',
    'nvapi-EXAMPLE-ONLY_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcb',
    'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234yz',
    '0123456789:EXAMPLE-not-a-real-token-0123456789',
  ]) {
    assert.deepEqual(findSecrets(`key = "${declared}"`), [], declared.slice(0, 20));
    assert.equal(looksDeclaredFake(declared), true);
  }
});

test('ordinary text is not mistaken for a credential', () => {
  // A scanner that cries at prose gets switched off, and then finds nothing.
  const prose = [
    'The task-runner picks sk-ipped tests up again on the next run.',
    'See https://example.com/a-very-long-path/with-many-segments/and-then-some-more/index.html',
    'const id = "0f3c2b1a-9d8e-4f7a-b6c5-d4e3f2a1b0c9";',
    'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'A private key belongs in a keychain, not in a repository.',
  ].join('\n');
  assert.deepEqual(findSecrets(prose), []);
});

test('a private key header is found, unless its line says it is an example', () => {
  const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.equal(findSecrets(`${header}\nMIIEvQ...`).length, 1);
  assert.equal(findSecrets(`${header}  (example, not a real key)\nMIIEvQ...`).length, 0);
});

/** Everything git tracks, or — in a copy with no git — everything that is not somebody else's. */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\0').filter(Boolean);
  } catch {
    const skip = new Set(['node_modules', '.git', 'dist', 'data', '__pycache__', '.pytest_cache']);
    const out = [];
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const full = join(dir, name);
        const path = rel ? `${rel}/${name}` : name;
        if (statSync(full).isDirectory()) walk(full, path);
        else out.push(path);
      }
    };
    walk(ROOT, '');
    return out;
  }
}

test('nothing in this repository is shaped like a credential without saying it is not one', () => {
  // This is the check that would have stopped it. Two real keys, pasted into a
  // conversation to debug a rejected-key report, went into a test file as
  // fixtures — right shape, right length, already to hand — and were pushed to
  // a public repository. The tests passed, because a key in a test file reads
  // like a fixture whether or not it opens anything.
  const offenders = [];
  let scanned = 0;
  for (const file of trackedFiles()) {
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // not text
    scanned += 1;
    for (const hit of findSecrets(text)) {
      offenders.push(`${file}:${hit.line} — ${hit.kind}, ${hit.preview}`);
    }
  }
  assert.ok(scanned > 50, `only ${scanned} files were scanned — the listing is not working`);
  assert.deepEqual(
    offenders, [],
    'credential-shaped strings that do not declare themselves fake. If one is real, revoke it '
    + 'first — it is already in history — and then replace it with a fixture that says what it is.',
  );
});
