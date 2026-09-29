import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKENS, FONTS, PRESETS, DEFAULTS, DEFAULT_PRESET,
  isColor, cleanTheme, resolveTheme, themeCss,
} from '../src/theme.js';

/**
 * The colours are editable, which means the values end up inside a stylesheet
 * every page loads. That makes validation the whole of the security story here:
 * a "colour" that closes the rule and opens another is a page somebody can
 * break for everyone with one save.
 */

test('what counts as a colour', () => {
  for (const good of ['#fff', '#d97757', '#ffccaa80', 'rgb(12, 34, 56)', 'rgba(1,2,3,.5)',
                      'hsl(210 40% 50%)', 'tomato', 'REBECCAPURPLE']) {
    assert.equal(isColor(good), true, `${good} should be allowed`);
  }
  for (const bad of ['red; } html { display:none }', 'url(http://x/y)', 'javascript:alert(1)',
                     'expression(alert(1))', '#gggggg', '', '   ', null, undefined,
                     'var(--accent)', '#fff;', 'rgb(1,2,3);}', 'a'.repeat(80)]) {
    assert.equal(isColor(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('anything that is not a colour never reaches the stylesheet', () => {
  const { theme, rejected } = cleanTheme({
    dark: { accent: 'red; } html { display:none } /*', bg: '#101418' },
    light: { text: 'url(evil)' },
  });
  assert.deepEqual(theme.dark, { bg: '#101418' });
  assert.deepEqual(theme.light, {});
  assert.equal(rejected.length, 2);
  // And it says what it dropped, rather than silently losing it.
  assert.match(rejected.join(' '), /dark\.accent/);
  assert.match(rejected.join(' '), /light\.text/);

  const css = themeCss(theme);
  assert.equal(css.includes('display:none'), false);
  assert.equal(css.includes('}'), true, 'the generated rule still closes properly');
});

test('an unknown token is not invented', () => {
  const { theme, rejected } = cleanTheme({ dark: { sidebarGradient: '#fff' } });
  assert.deepEqual(theme.dark, {});
  assert.match(rejected[0], /not a colour this room has/);
});

test('a value equal to the default is not stored as an override', () => {
  // Otherwise every page freezes against a later change to the defaults.
  const { theme } = cleanTheme({ dark: { accent: DEFAULTS.dark.accent, bg: '#000000' } });
  assert.deepEqual(theme.dark, { bg: '#000000' });
});

test('fonts come from the list, not from a text box', () => {
  const { theme, rejected } = cleanTheme({ fonts: { serif: 'georgia', sans: 'Comic Sans; }', mono: 'system' } });
  assert.deepEqual(theme.fonts, { serif: 'georgia' });
  assert.match(rejected.join(' '), /fonts\.sans/);
});

test('nothing set produces no CSS at all', () => {
  assert.equal(themeCss({}), '');
  assert.equal(themeCss({ dark: {}, light: {}, fonts: {} }), '');
  assert.equal(themeCss(cleanTheme({}).theme), '');
});

test('the CSS puts each mode where that mode is read', () => {
  const css = themeCss({ dark: { bg: '#101418' }, light: { bg: '#fffef8' }, fonts: { serif: 'georgia' } });
  assert.match(css, /:root \{[\s\S]*--bg:#101418/);
  assert.match(css, /prefers-color-scheme: light[\s\S]*--bg:#fffef8/);
  assert.match(css, /--serif:Georgia/);
  // The light block must be inside the media query, not loose after it.
  const light = css.slice(css.indexOf('@media'));
  assert.equal(light.split('{').length, light.split('}').length, 'braces must balance');
});

test('resolving fills the gaps from the defaults', () => {
  const applied = resolveTheme({ dark: { accent: '#00d4aa' }, fonts: { serif: 'nonsense' } });
  assert.equal(applied.dark.accent, '#00d4aa');
  assert.equal(applied.dark.bg, DEFAULTS.dark.bg, 'an untouched token keeps its default');
  assert.equal(applied.light.accent, DEFAULTS.light.accent);
  assert.equal(applied.fonts.serif, 'system', 'a font that is not on the list falls back');
});

test('every preset covers every token, in both modes, with real colours', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.label, `${id} needs a label`);
    for (const mode of ['dark', 'light']) {
      for (const { key } of TOKENS) {
        const value = preset[mode]?.[key];
        assert.ok(value, `${id}.${mode} is missing ${key}`);
        assert.equal(isColor(value), true, `${id}.${mode}.${key} is ${value}`);
      }
    }
  }
  assert.ok(PRESETS[DEFAULT_PRESET], 'the default preset has to exist');
  assert.deepEqual(DEFAULTS, PRESETS[DEFAULT_PRESET]);
});

test('every font choice is a usable stack', () => {
  for (const [role, def] of Object.entries(FONTS)) {
    assert.ok(def.choices.system, `${role} needs a system default`);
    for (const [id, choice] of Object.entries(def.choices)) {
      assert.ok(choice.label, `${role}.${id} needs a label`);
      assert.ok(choice.stack.length, `${role}.${id} needs a stack`);
      // A stack is a font list; anything else would be escaping into the sheet.
      assert.equal(/[;{}]/.test(choice.stack), false, `${role}.${id} has punctuation that closes a rule`);
    }
  }
});

test('every token is described, because --panel2 helps nobody choose', () => {
  for (const t of TOKENS) {
    assert.ok(t.label && t.hint, `${t.key} needs a label and a hint`);
    assert.ok(DEFAULTS.dark[t.key] && DEFAULTS.light[t.key], `${t.key} needs a default in both modes`);
  }
});
