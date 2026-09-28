import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { createSkills, parseFrontMatter, slugify } from '../src/skills.js';

/** The same zip shape the Office tests use; a skill folder is just a folder. */
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(locals); const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dirBuf, end]);
}

const fresh = (opts) => createSkills(openDb(':memory:'), opts);

test('front matter is read, and the instructions under it are kept whole', () => {
  const { data, body } = parseFrontMatter(
    '---\nname: code-review\ndescription: "How we review here"\nroles: [reviewer, critic]\n---\n\nRead the diff twice.\n',
  );
  assert.equal(data.name, 'code-review');
  assert.equal(data.description, 'How we review here');
  assert.deepEqual(data.roles, ['reviewer', 'critic']);
  assert.equal(body, 'Read the diff twice.');
});

test('a file with no front matter is still a skill', () => {
  const { data, body } = parseFrontMatter('# Commit messages\n\nImperative mood.');
  assert.deepEqual(data, {});
  assert.match(body, /^# Commit messages/);
});

test('names become something a model can say and a URL can carry', () => {
  assert.equal(slugify('Code Review!.md'), 'code-review');
  assert.equal(slugify('  '), 'skill');
});

test('a markdown upload becomes one skill, titled from its heading', () => {
  const skills = fresh();
  const [k] = skills.upload({
    filename: 'review.md',
    bytes: Buffer.from('---\nname: code-review\nroles: [reviewer]\n---\n# Code review\n\nRead it twice.'),
  });
  assert.equal(k.name, 'code-review');
  assert.equal(k.title, 'Code review');
  assert.deepEqual(k.roles, ['reviewer']);
  assert.match(k.body, /Read it twice/);
});

test('a zipped skill folder brings its files with it', () => {
  const stored = [];
  const skills = fresh({ store: (path, data) => { stored.push(path); return `/media/${path}`; } });
  const [k] = skills.upload({
    filename: 'bundle.zip',
    bytes: zip({
      'proposal-style/SKILL.md': '---\nname: proposal-style\ndescription: House style.\n---\nOpen with the constraint.',
      'proposal-style/checklist.md': '- constraint named\n',
      'proposal-style/diagram.png': '\u0089PNG\r\n\u001a\n binary',
    }),
  });
  assert.equal(k.name, 'proposal-style');
  assert.deepEqual(k.files.map((f) => f.path), ['checklist.md', 'diagram.png']);
  // Text comes along; binary is put on disk and pointed at.
  assert.equal(k.files.find((f) => f.path === 'checklist.md').readable, true);
  assert.equal(k.files.find((f) => f.path === 'diagram.png').url, '/media/diagram.png');
  assert.deepEqual(stored, ['diagram.png']);
});

test('a zip of loose markdown is one skill each, not one skill', () => {
  const skills = fresh();
  const saved = skills.upload({
    filename: 'mine.zip',
    bytes: zip({
      'notes/commit-messages.md': '# Commit messages\n\nImperative mood.',
      'notes/naming.md': '# Naming\n\nSay what it is.',
      '__MACOSX/._junk': 'ignore',
    }),
  });
  assert.deepEqual(saved.map((k) => k.name).sort(), ['commit-messages', 'naming']);
});

test('a zip with nothing usable in it says so', () => {
  const skills = fresh();
  assert.throws(() => skills.upload({ filename: 'photos.zip', bytes: zip({ 'a.png': 'x' }) }), /no skill found/);
});

test('a skill is handed over verbatim, with the files it brought', () => {
  const skills = fresh();
  skills.upload({
    filename: 'b.zip',
    bytes: zip({
      'x/SKILL.md': '---\nname: x\n---\nDo it exactly this way.',
      'x/checklist.md': '- one\n- two\n',
    }),
  });
  const used = skills.use('x', { by: 'nova' });
  assert.equal(used.body, 'Do it exactly this way.');
  assert.deepEqual(used.attached, [{ path: 'checklist.md', text: '- one\n- two\n' }]);
  assert.equal(skills.get('x').used, 1);
});

test('the menu names skills without pasting them, and respects roles', () => {
  const skills = fresh();
  skills.save({ name: 'for-reviewers', body: 'check it', roles: ['reviewer'] });
  skills.save({ name: 'for-anyone', body: 'anybody can use this' });

  const menu = skills.menu({ role: 'backend' });
  assert.deepEqual(menu.map((k) => k.name), ['for-anyone']);
  // What a model is shown must not include the instructions themselves.
  assert.equal(JSON.stringify(menu).includes('anybody can use this'), false);
  assert.deepEqual(skills.menu({ role: 'reviewer' }).map((k) => k.name).sort(), ['for-anyone', 'for-reviewers']);
});

test('a switched-off skill is not offered and cannot be used', () => {
  const skills = fresh();
  skills.save({ name: 'x', body: 'do it' });
  skills.setEnabled('x', false);
  assert.deepEqual(skills.menu(), []);
  assert.throws(() => skills.use('x'), /switched off/);
});

test('re-uploading the same skill replaces it rather than duplicating it', () => {
  const skills = fresh();
  skills.upload({ filename: 'a.md', bytes: Buffer.from('---\nname: house\n---\nfirst version') });
  skills.upload({ filename: 'a.md', bytes: Buffer.from('---\nname: house\n---\nsecond version') });
  assert.equal(skills.all().length, 1);
  assert.match(skills.get('house').body, /second version/);
});

test('a skill needs instructions in it', () => {
  const skills = fresh();
  assert.throws(() => skills.save({ name: 'empty', body: '   ' }), /needs a body/);
  assert.throws(() => skills.upload({ filename: 'x.md', bytes: Buffer.from('---\nname: x\n---\n') }), /no instructions/);
});

test('a binary file is refused as a skill rather than stored as mojibake', () => {
  const skills = fresh();
  assert.throws(
    () => skills.upload({ filename: 'photo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd, 0x00, 0xff]) }),
    /not text/,
  );
});
