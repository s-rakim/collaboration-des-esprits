import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Invalid, NotFound } from '../src/core.js';

function room() {
  const h = new Hub({ dbPath: ':memory:' });
  h.join({ name: 'rakim', role: 'human', kind: 'human' });
  h.join({ name: 'archie', role: 'architect' });
  return h;
}

// --------------------------------------------------------------- artifacts

test('an artifact is versioned on every write and nothing is lost', () => {
  const h = room();
  const a = h.saveArtifact({ title: 'Spec', content: 'first', by: 'archie' });
  assert.equal(a.version, 1);

  h.saveArtifact({ slug: a.slug, content: 'second', summary: 'reworked', by: 'archie' });
  const now = h.getArtifact(a.slug);
  assert.equal(now.version, 2);
  assert.equal(now.content, 'second');

  // The earlier text is still readable, which is what makes revising safe.
  assert.equal(h.artifactVersion({ ref: a.slug, version: 1 }).content, 'first');
  assert.deepEqual(h.artifactHistory(a.slug).map((v) => v.version), [2, 1]);
});

test('restoring an old version moves forward rather than rewriting history', () => {
  const h = room();
  const a = h.saveArtifact({ title: 'Spec', content: 'v1 text', by: 'archie' });
  h.saveArtifact({ slug: a.slug, content: 'v2 text', by: 'archie' });

  const restored = h.restoreArtifact({ ref: a.slug, version: 1, by: 'rakim' });
  assert.equal(restored.version, 3, 'a restore is a new version, not a rollback of the log');
  assert.equal(h.getArtifact(a.slug).content, 'v1 text');
  assert.equal(h.artifactVersion({ ref: a.slug, version: 2 }).content, 'v2 text', 'and v2 is still there');
});

test('creating an artifact needs a title; revising one does not', () => {
  const h = room();
  assert.throws(() => h.saveArtifact({ content: 'x', by: 'archie' }), /needs a title/);
  const a = h.saveArtifact({ title: 'T', content: 'x', by: 'archie' });
  assert.doesNotThrow(() => h.saveArtifact({ slug: a.slug, content: 'y', by: 'archie' }));
});

test('saving an artifact announces it in the thread so the room knows', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Thing', raw: '', by: 'rakim' });
  h.saveArtifact({ title: 'Spec', content: 'x', idea: idea.slug, by: 'archie' });
  const said = h.db.prepare("SELECT body FROM messages WHERE author = 'archie' ORDER BY id DESC").get();
  assert.match(said.body, /Created: \*\*Spec\*\*/);
  assert.match(said.body, /artifact/);
});

test('the list view omits contents, so an index is not a payload', () => {
  const h = room();
  h.saveArtifact({ title: 'Big', content: 'x'.repeat(5000), by: 'archie' });
  const [listed] = h.artifacts();
  assert.equal(listed.content, undefined);
  assert.equal(listed.chars, 5000);
});

test('two artifacts cannot collide on a slug', () => {
  const h = room();
  const a = h.saveArtifact({ title: 'Spec', content: '1', by: 'archie' });
  const b = h.saveArtifact({ title: 'Spec', content: '2', by: 'archie' });
  assert.notEqual(a.slug, b.slug);
  assert.equal(h.getArtifact(a.slug).content, '1');
});

// ---------------------------------------------------------------- projects

test('a project gives every idea inside it shared context', () => {
  const h = room();
  const p = h.createProject({ name: 'Loversrock', brief: 'Self-hosted. Never a cloud dependency.', by: 'rakim' });
  const idea = h.dropIdea({ title: 'Widget', raw: 'a widget', by: 'rakim' });
  h.fileIdea({ ref: idea.slug, project: p.slug, by: 'rakim' });

  const d = h.brief({ idea: idea.slug }).digest;
  assert.match(d, /Project: Loversrock/);
  assert.match(d, /Never a cloud dependency/);
  assert.match(d, /binds every idea in the project/);
  assert.equal(h.getProject(p.slug).ideas, 1);
});

test('an idea can be taken back out of a project', () => {
  const h = room();
  const p = h.createProject({ name: 'P', by: 'rakim' });
  const idea = h.dropIdea({ title: 'I', raw: '', by: 'rakim' });
  h.fileIdea({ ref: idea.slug, project: p.slug, by: 'rakim' });
  assert.equal(h.getProject(p.slug).ideas, 1);
  h.fileIdea({ ref: idea.slug, project: null, by: 'rakim' });
  assert.equal(h.getProject(p.slug).ideas, 0);
  assert.equal(h.listIdeas()[0].project, null);
});

test('artifacts land in the project their idea belongs to', () => {
  const h = room();
  const p = h.createProject({ name: 'P', by: 'rakim' });
  const idea = h.dropIdea({ title: 'I', raw: '', by: 'rakim' });
  h.fileIdea({ ref: idea.slug, project: p.slug, by: 'rakim' });
  h.saveArtifact({ title: 'Doc', content: 'x', idea: idea.slug, by: 'archie' });
  assert.equal(h.getProject(p.slug).artifacts, 1);
  assert.equal(h.artifacts({ project: p.slug }).length, 1);
});

// ------------------------------------------------------------- attachments

test('an attached text file is readable by agents through the brief', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'With files', raw: '', by: 'rakim' });
  h.attach({ idea: idea.slug, filename: 'notes.md', mime: 'text/markdown', size: 20, url: '/media/n.md', text: '# Notes', by: 'rakim' });

  const d = h.brief({ idea: idea.slug }).digest;
  assert.match(d, /notes\.md/);
  assert.match(d, /read_file/);
  assert.equal(h.attachments({ idea: idea.slug })[0].hasText, true);
});

test('a file we cannot read is kept and labelled honestly', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Binary', raw: '', by: 'rakim' });
  h.attach({ idea: idea.slug, filename: 'photo.heic', mime: 'image/heic', size: 900, url: '/media/p.heic', text: '', by: 'rakim' });
  const d = h.brief({ idea: idea.slug }).digest;
  assert.match(d, /photo\.heic/);
  assert.match(d, /only the link/, 'it says what it cannot do rather than pretending');
});

test('the attachment index omits file contents', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'I', raw: '', by: 'rakim' });
  h.attach({ idea: idea.slug, filename: 'big.txt', url: '/media/b.txt', text: 'y'.repeat(9000), by: 'rakim' });
  assert.equal(h.attachments({ idea: idea.slug })[0].text, undefined);
  assert.equal(h.getAttachment(h.attachments({ idea: idea.slug })[0].id).text.length, 9000);
});

// --------------------------------------------------------------- schedules

test('a schedule fires into the room and re-arms itself', () => {
  const h = room();
  const s = h.createSchedule({ name: 'Standup', prompt: 'What is blocked?', everyMinutes: 30, by: 'rakim' });
  assert.equal(h.dueSchedules().length, 0, 'not due the moment it is made');

  h.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id);
  assert.deepEqual(h.dueSchedules().map((x) => x.name), ['Standup']);

  const { message } = h.runSchedule({ id: s.id });
  const posted = h.db.prepare('SELECT author, body FROM messages WHERE id = ?').get(message.id);
  assert.match(posted.body, /@all What is blocked\?/, 'addressed to everyone, so listening agents wake');
  assert.equal(posted.author, 'rakim', 'spoken as the human when no agent is named');

  assert.equal(h.dueSchedules().length, 0, 'and it is no longer due');
  assert.ok(h.getSchedule(s.id).nextRunAt > new Date().toISOString());
  assert.ok(h.getSchedule(s.id).lastRunAt);
});

test('a daily schedule anchors to the wall clock, not to when it was created', () => {
  const h = room();
  const s = h.createSchedule({ name: 'Morning', prompt: 'brief me', atTime: '08:30', by: 'rakim' });
  const next = new Date(h.getSchedule(s.id).nextRunAt);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 30);
  assert.ok(next > new Date(), 'and it is in the future');
});

test('a schedule can speak as a named agent', () => {
  const h = room();
  const s = h.createSchedule({ name: 'Review', prompt: 'anything to review?', everyMinutes: 60, asAgent: 'archie', by: 'rakim' });
  h.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id);
  const { message } = h.runSchedule({ id: s.id });
  assert.equal(h.db.prepare('SELECT author FROM messages WHERE id = ?').get(message.id).author, 'archie');
});

test('schedules validate their inputs rather than failing at fire time', () => {
  const h = room();
  assert.throws(() => h.createSchedule({ name: '', prompt: 'x', by: 'rakim' }), /needs a name/);
  assert.throws(() => h.createSchedule({ name: 'n', prompt: '', by: 'rakim' }), /needs something to say/);
  assert.throws(() => h.createSchedule({ name: 'n', prompt: 'x', atTime: 'half eight', by: 'rakim' }), /08:30/);
  assert.throws(() => h.createSchedule({ name: 'n', prompt: 'x', asAgent: 'ghost', by: 'rakim' }), NotFound);
});

test('disabling a schedule stops it without deleting it', () => {
  const h = room();
  const s = h.createSchedule({ name: 'S', prompt: 'x', everyMinutes: 5, by: 'rakim' });
  h.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id);
  h.updateSchedule({ id: s.id, enabled: false });
  assert.equal(h.dueSchedules().length, 0);
  assert.equal(h.getSchedule(s.id).enabled, false);

  h.updateSchedule({ id: s.id, enabled: true });
  assert.equal(h.getSchedule(s.id).enabled, true);
  assert.ok(h.getSchedule(s.id).nextRunAt > new Date().toISOString(), 're-enabling re-arms it rather than firing immediately');
});

// -------------------------------------------------------------- the library

test('every generation is kept with the prompt that made it', () => {
  const h = room();
  const g = h.recordGeneration({ kind: 'image', prompt: 'a dark mockup', url: '/media/a.png', model: 'img-1', by: 'rakim' });
  assert.equal(h.generations()[0].prompt, 'a dark mockup');
  assert.equal(h.generations({ kind: 'video' }).length, 0);

  h.pinGeneration({ id: g.id });
  assert.deepEqual(h.generations({ pinned: true }).map((x) => x.id), [g.id]);
});

test('removing a generation from the library leaves the file alone', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'I', raw: '', by: 'rakim' });
  const g = h.recordGeneration({ kind: 'image', prompt: 'x', url: '/media/keep.png', idea: idea.slug, by: 'rakim' });
  h.post({ idea: idea.slug, body: 'here it is\n\n![image](/media/keep.png)', by: 'rakim' });

  h.deleteGeneration({ id: g.id });
  assert.equal(h.generations().length, 0);
  // The message still points at it, which is why the file must survive.
  assert.ok(h.db.prepare('SELECT 1 FROM messages WHERE body LIKE ?').get('%/media/keep.png%'));
});
