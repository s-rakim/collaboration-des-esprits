/**
 * Finding credentials that have been written down where they should not be.
 *
 * This exists because it happened here. Two real keys, pasted into a
 * conversation to debug a rejected-key report, were used as test fixtures —
 * same shape, right length, already to hand — and committed to a public
 * repository. Nothing looked wrong: the tests passed, and a key in a test file
 * reads like a fixture whether or not it opens anything.
 *
 * So the rule is not "do not commit keys", which everybody already agrees with
 * and which stopped nobody. It is narrower and checkable: anything in this
 * repository shaped like a credential has to say, in its own text, that it is
 * not one. A fixture that cannot be told from a real key by reading it is
 * treated as a real key.
 *
 * The same scan runs over a skill before it is packaged, because a marketplace
 * runs one too and would rather not be the place somebody's key is found.
 */

/**
 * The shapes worth recognising. Each is a format a provider actually issues,
 * with a length floor high enough that prose and identifiers do not match.
 */
const SHAPES = [
  { kind: 'NVIDIA API key', re: /nvapi-[A-Za-z0-9_-]{40,}/g },
  { kind: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{30,}/g },
  { kind: 'OpenAI-style secret key', re: /\bsk-[A-Za-z0-9_-]{32,}/g },
  { kind: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{40,}/g },
  { kind: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g },
  { kind: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
];

/**
 * How a fixture says it is not a credential.
 *
 * Deliberately a short list of plain words rather than a judgement about how
 * random something looks. A real key can be low-entropy by chance and a fake
 * one can look convincing; the only reliable signal is the author having said
 * so where the next reader will see it.
 */
const DECLARED_FAKE = /not-?a-?real|example|fake|dummy|placeholder|redacted|pasted-from|test-?key|xxxx|x{6,}|0123456789|abc123|abcdef/i;

/** Every credential-shaped string in a piece of text that does not declare itself fake. */
export function findSecrets(text) {
  const src = String(text ?? '');
  const found = [];
  const seen = new Set();
  for (const { kind, re } of SHAPES) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const value = m[0];
      // A key carries its own disclaimer, so it survives being copied somewhere
      // else. A PEM header has no room for one, so its line may carry it.
      let said = value;
      if (kind === 'private key') {
        const end = src.indexOf('\n', m.index);
        said = src.slice(src.lastIndexOf('\n', m.index) + 1, end === -1 ? undefined : end);
      }
      if (DECLARED_FAKE.test(said)) continue;
      // The broad sk- shape also matches the narrower ones; report each once.
      const key = `${m.index}:${value.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = src.slice(0, m.index).split('\n').length;
      found.push({
        kind,
        line,
        // Enough to find it, never enough to use it.
        preview: `${value.slice(0, 8)}…${value.slice(-2)} (${value.length} characters)`,
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Whether a string is one this module would let through as a declared fixture. */
export function looksDeclaredFake(value) {
  return DECLARED_FAKE.test(String(value ?? ''));
}
