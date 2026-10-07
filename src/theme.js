/**
 * The room's colours, as data you can change.
 *
 * The palette shipped is one opinion, and it is the wrong one for somebody. So
 * every colour is a named token with a default, and a saved override replaces
 * it — stored in the room's own database rather than in a browser, because a
 * room you open from a laptop and a phone should not look like two rooms.
 *
 * Values are validated rather than trusted. These end up inside a stylesheet,
 * and a "colour" of `red; } html { display: none` would be a page somebody
 * could break for everyone with one save.
 */

/**
 * What each token is for, in the order the editor shows them. The labels are
 * the whole documentation: a list called `--panel2` helps nobody choose.
 */
export const TOKENS = [
  { key: 'bg', label: 'Page', hint: 'Behind everything you read.' },
  { key: 'panel', label: 'Rail and cards', hint: 'The raised surfaces: the left rail, a card, a dialog.' },
  { key: 'panel2', label: 'Controls', hint: 'Buttons and inputs at rest.' },
  { key: 'line', label: 'Borders', hint: 'Every hairline and divider.' },
  { key: 'text', label: 'Text', hint: 'What you are reading.' },
  { key: 'dim', label: 'Secondary text', hint: 'Labels, metadata, the second line.' },
  { key: 'faint', label: 'Faint text', hint: 'Timestamps, placeholders, things you skim past.' },
  { key: 'accent', label: 'Accent', hint: 'The one saturated colour — whatever is wearing it is the thing to press.' },
  { key: 'good', label: 'Good', hint: 'Done, running, supported.' },
  { key: 'warn', label: 'Warning', hint: 'Needs you, unverifiable, waiting.' },
  { key: 'bad', label: 'Bad', hint: 'Failed, refused, contradicted.' },
  { key: 'human', label: 'You', hint: 'Marks your own name apart from the models.' },
];

/** The fonts on offer. A list, not a free text box: these end up in CSS too. */
export const FONTS = {
  serif: {
    label: 'Serif (titles)',
    choices: {
      system: { label: 'System serif', stack: 'ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif' },
      georgia: { label: 'Georgia', stack: 'Georgia,"Times New Roman",serif' },
      times: { label: 'Times', stack: '"Times New Roman",Times,serif' },
      sans: { label: 'No serif — use the body font', stack: 'inherit' },
    },
  },
  sans: {
    label: 'Sans (everything else)',
    choices: {
      system: { label: 'System sans', stack: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif' },
      inter: { label: 'Inter / Segoe', stack: 'Inter,"Segoe UI",Roboto,system-ui,sans-serif' },
      helvetica: { label: 'Helvetica', stack: '"Helvetica Neue",Helvetica,Arial,sans-serif' },
      humanist: { label: 'Optima / Candara', stack: 'Optima,Candara,"Gill Sans",sans-serif' },
    },
  },
  mono: {
    label: 'Monospace (code, ids)',
    choices: {
      system: { label: 'System mono', stack: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace' },
      consolas: { label: 'Consolas', stack: 'Consolas,"Courier New",monospace' },
      courier: { label: 'Courier', stack: '"Courier New",Courier,monospace' },
    },
  },
};

/** The palettes that ship. The first is the default. */
export const PRESETS = {
  mono: {
    label: 'Mono — black and white, the default',
    // Nearly colourless on purpose. Everything on screen here was written by
    // somebody — you or a model — and the colour that survives is the one doing
    // a job: a thing failed, a thing needs you, a thing is the one to press.
    // The accent is simply the page inverted, which is why it reads as emphasis
    // rather than as decoration.
    dark: {
      bg: '#212121', panel: '#171717', panel2: '#2f2f2f', line: '#3f3f3f',
      text: '#ececec', dim: '#b4b4b4', faint: '#8f8f8f',
      accent: '#ffffff',
      // Kept, and kept distinguishable. Red and green carry meaning that grey
      // cannot, and somebody reading "failed" should not have to read it twice.
      good: '#7bb98a', warn: '#d8a657', bad: '#f06a5d', human: '#a8a8ff',
    },
    light: {
      bg: '#ffffff', panel: '#f9f9f9', panel2: '#f4f4f4', line: '#e5e5e5',
      text: '#0d0d0d', dim: '#5d5d5d', faint: '#8f8f8f',
      accent: '#0d0d0d',
      good: '#2f7a46', warn: '#8a6111', bad: '#c0362c', human: '#4b4bb5',
    },
  },
  clay: {
    label: 'Clay — warm',
    dark: {
      bg: '#262624', panel: '#1f1e1d', panel2: '#30302e', line: '#3d3d3a',
      text: '#faf9f5', dim: '#b7b5ad', faint: '#8a8880',
      accent: '#d97757', good: '#8fbc6d', warn: '#e0a458', bad: '#e0685c', human: '#c9a3d4',
    },
    light: {
      bg: '#ffffff', panel: '#faf9f5', panel2: '#f0eee6', line: '#e5e3da',
      text: '#3d3d3a', dim: '#6b6a65', faint: '#93918a',
      accent: '#c96442', good: '#4e7a3a', warn: '#9a6a1c', bad: '#b5483c', human: '#7a4e94',
    },
  },
  midnight: {
    label: 'Midnight — cool blue',
    dark: {
      bg: '#0f1115', panel: '#171a21', panel2: '#1e222b', line: '#2a2f3a',
      text: '#e6e8ee', dim: '#98a0b3', faint: '#6b7488',
      accent: '#7aa2f7', good: '#9ece6a', warn: '#e0af68', bad: '#f7768e', human: '#bb9af7',
    },
    light: {
      bg: '#f6f7f9', panel: '#ffffff', panel2: '#f0f2f6', line: '#dde1e8',
      text: '#12151b', dim: '#5b6373', faint: '#8b93a5',
      accent: '#2d5bd7', good: '#3f8f3f', warn: '#96660d', bad: '#c3364f', human: '#6f3fc0',
    },
  },
  forest: {
    label: 'Forest — green and slate',
    dark: {
      bg: '#161a17', panel: '#111411', panel2: '#1f251f', line: '#2c342c',
      text: '#eef2ec', dim: '#a7b2a5', faint: '#79857a',
      accent: '#7fb069', good: '#8fd694', warn: '#d9b168', bad: '#d97c72', human: '#9fc0d9',
    },
    light: {
      bg: '#fbfcfa', panel: '#f2f5f0', panel2: '#e7ece4', line: '#d8e0d5',
      text: '#1d251e', dim: '#546055', faint: '#818d82',
      accent: '#3f7a2e', good: '#2f7a3f', warn: '#8a6413', bad: '#a8402f', human: '#2f5f86',
    },
  },
  paper: {
    label: 'Paper — high contrast, light first',
    dark: {
      bg: '#101010', panel: '#000000', panel2: '#1c1c1c', line: '#3a3a3a',
      text: '#ffffff', dim: '#c4c4c4', faint: '#9a9a9a',
      accent: '#ffb000', good: '#5fd75f', warn: '#ffb000', bad: '#ff5f5f', human: '#af87ff',
    },
    light: {
      bg: '#ffffff', panel: '#f4f4f4', panel2: '#e8e8e8', line: '#c8c8c8',
      text: '#000000', dim: '#3a3a3a', faint: '#666666',
      accent: '#0050b3', good: '#166534', warn: '#8a5a00', bad: '#a4161a', human: '#5b21b6',
    },
  },
};

export const DEFAULT_PRESET = 'mono';
export const DEFAULTS = PRESETS[DEFAULT_PRESET];

/**
 * Is this something a browser will read as a colour, and nothing else?
 *
 * Deliberately narrow. Anything that gets past here is written into a
 * stylesheet every page loads, so the cost of being generous is somebody
 * closing the app for everyone with a semicolon.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\((?:[\d.]+%?|\s|,|\/|deg)+\)$/i;
const NAMED = /^[a-z]{3,20}$/i;

export function isColor(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 64) return false;
  return HEX.test(v) || FUNCTIONAL.test(v) || NAMED.test(v);
}

const KEYS = new Set(TOKENS.map((t) => t.key));

/**
 * Take what was submitted and return only the parts of it that are a theme.
 *
 * Returns the cleaned theme and what was thrown away, because silently dropping
 * somebody's input is how you get a bug report that says "it did not save".
 */
/**
 * Dark, light, or whichever the machine is set to.
 *
 * Following the system sounds like the considerate default and is not: this is
 * a room you sit in for hours while models talk, and the machine's setting is
 * usually about everything else. Dark is what it is for, and the other two are
 * a choice away.
 */
export const APPEARANCES = {
  dark: { label: 'Dark', hint: 'Always dark, whatever the machine is set to.' },
  light: { label: 'Light', hint: 'Always light.' },
  system: { label: 'Match the machine', hint: 'Follow the system setting, and change when it does.' },
};
export const DEFAULT_APPEARANCE = 'dark';

export function cleanTheme(raw) {
  const out = { dark: {}, light: {}, fonts: {} };
  const rejected = [];

  for (const mode of ['dark', 'light']) {
    for (const [key, value] of Object.entries(raw?.[mode] ?? {})) {
      if (!KEYS.has(key)) { rejected.push(`${mode}.${key}: not a colour this room has`); continue; }
      if (!isColor(value)) { rejected.push(`${mode}.${key}: ${JSON.stringify(value)} is not a colour`); continue; }
      // A value equal to the default is not an override; storing it would
      // freeze this page against a future change to the defaults.
      if (String(value).toLowerCase() === DEFAULTS[mode][key]) continue;
      out[mode][key] = String(value).trim();
    }
  }

  const look = raw?.appearance;
  if (look !== undefined && look !== null && look !== '') {
    if (!APPEARANCES[look]) rejected.push(`appearance: ${JSON.stringify(look)} is not one of dark, light or system`);
    else if (look !== DEFAULT_APPEARANCE) out.appearance = look;
  }

  for (const [role, def] of Object.entries(FONTS)) {
    const choice = raw?.fonts?.[role];
    if (choice === undefined || choice === null || choice === '') continue;
    if (!def.choices[choice]) { rejected.push(`fonts.${role}: ${JSON.stringify(choice)} is not on the list`); continue; }
    if (choice === 'system') continue; // the default
    out.fonts[role] = choice;
  }

  return { theme: out, rejected };
}

/** The saved overrides merged over the defaults — what the page will actually use. */
export function resolveTheme(saved) {
  const applied = { dark: { ...DEFAULTS.dark }, light: { ...DEFAULTS.light }, fonts: {} };
  for (const mode of ['dark', 'light']) {
    Object.assign(applied[mode], saved?.[mode] ?? {});
  }
  for (const [role, def] of Object.entries(FONTS)) {
    const choice = saved?.fonts?.[role] ?? 'system';
    applied.fonts[role] = def.choices[choice] ? choice : 'system';
  }
  applied.appearance = APPEARANCES[saved?.appearance] ? saved.appearance : DEFAULT_APPEARANCE;
  return applied;
}

/**
 * The CSS that carries the overrides.
 *
 * Appended after the stylesheet's own `:root`, so it wins by order rather than
 * by specificity — which keeps it working if the base sheet is rearranged. Only
 * what differs from the default is written, so a room with no theme set adds
 * nothing at all.
 */
/**
 * The default palette, as CSS.
 *
 * It used to be written out twice — once here as data, once in theme.css as
 * declarations — and the second copy is the one the browser believed. Changing
 * the default did nothing at all, visibly, which is the kind of bug that makes
 * somebody doubt the change rather than the stylesheet.
 *
 * So the stylesheet keeps the layout and this keeps the colours, and there is
 * one place to change them.
 */
export function defaultsCss(saved) {
  const block = (mode, pad = '  ') => TOKENS
    .map(({ key }) => `${pad}--${key}:${DEFAULTS[mode][key]};`)
    .join('\n');

  const look = APPEARANCES[saved?.appearance] ? saved.appearance : DEFAULT_APPEARANCE;

  // Either way round, the data-theme attribute still wins, so a page can be
  // flipped without reloading and without the stylesheet being rebuilt.
  if (look === 'system') {
    return `:root {
${block('dark')}
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
${block('light')}
  }
}

:root[data-theme="light"] {
${block('light')}
}
`;
  }

  const base = look === 'light' ? 'light' : 'dark';
  const other = base === 'light' ? 'dark' : 'light';
  return `:root {
${block(base)}
}

:root[data-theme="${other}"] {
${block(other)}
}

:root[data-theme="${base}"] {
${block(base)}
}
`;
}

export function themeCss(saved) {
  const dark = [];
  const light = [];
  const fonts = [];

  for (const { key } of TOKENS) {
    const d = saved?.dark?.[key];
    if (d && isColor(d)) dark.push(`  --${key}:${d};`);
    const l = saved?.light?.[key];
    if (l && isColor(l)) light.push(`  --${key}:${l};`);
  }

  for (const [role, def] of Object.entries(FONTS)) {
    const choice = saved?.fonts?.[role];
    if (choice && def.choices[choice] && choice !== 'system') {
      fonts.push(`  --${role}:${def.choices[choice].stack};`);
    }
  }

  if (!dark.length && !light.length && !fonts.length) return '';

  const parts = ['\n/* Set on the setup page. */'];
  if (dark.length || fonts.length) parts.push(`:root {\n${[...dark, ...fonts].join('\n')}\n}`);
  if (light.length) {
    parts.push(
      `@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {\n` +
      `${light.map((l) => `  ${l}`).join('\n')}\n  }\n}`,
    );
  }
  return `${parts.join('\n')}\n`;
}
