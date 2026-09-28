import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Hub } from '../src/core.js';

/**
 * The compatibility layer over node:sqlite. prepare/get/all/run come straight
 * from the platform, so what is worth testing is the two pieces written here:
 * pragma, and the transaction helper with its savepoint nesting.
 */

const fresh = () => openDb(':memory:');

test('the schema, its indexes and FTS all build on the built-in SQLite', () => {
  const db = fresh();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['agents', 'ideas', 'messages', 'proposals', 'tasks', 'participants', 'floor_queue']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.equal(db.hasFts, true, 'FTS5 is compiled into the bundled SQLite');
});

test('pragma sets a value and reads it back', () => {
  const db = fresh();
  assert.equal(db.pragma('foreign_keys').foreign_keys, 1);
  // A pragma that returns no rows must not throw.
  assert.doesNotThrow(() => db.pragma('optimize'));
});

test('a transaction commits as one unit', () => {
  const db = fresh();
  db.exec('CREATE TABLE t (a INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  const tx = db.transaction(() => { ins.run(1); ins.run(2); });
  tx();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 2);
});

test('a throwing transaction rolls back everything it did', () => {
  const db = fresh();
  db.exec('CREATE TABLE t (a INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  const tx = db.transaction(() => {
    ins.run(1);
    throw new Error('boom');
  });
  assert.throws(() => tx(), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 0, 'the partial write is gone');

  // And the connection is usable afterwards, not stuck mid-transaction.
  ins.run(9);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 1);
});

test('transactions nest via savepoints, and an inner failure loses only inner work', () => {
  const db = fresh();
  db.exec('CREATE TABLE t (a INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');

  const inner = db.transaction(() => { ins.run(2); throw new Error('inner'); });
  const outer = db.transaction(() => {
    ins.run(1);
    // The caller catches the inner failure and carries on — the outer
    // transaction's own work must survive that.
    try { inner(); } catch { /* handled */ }
    ins.run(3);
  });
  outer();

  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all().map((r) => r.a), [1, 3]);
});

test('an outer rollback discards committed inner savepoints too', () => {
  const db = fresh();
  db.exec('CREATE TABLE t (a INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  const inner = db.transaction(() => ins.run(2));
  const outer = db.transaction(() => { ins.run(1); inner(); throw new Error('outer'); });

  assert.throws(() => outer(), /outer/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 0);
});

test('the real nested case in the domain: plan() creates tasks inside its own transaction', () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  hub.join({ name: 'planner', role: 'planner' });
  const idea = hub.dropIdea({ title: 'Nesting', raw: '', by: 'rakim' });

  const made = hub.plan({
    idea: idea.slug, by: 'planner',
    tasks: [{ title: 'first', role: 'backend' }, { title: 'second', role: 'backend', dependsOn: [0] }],
  });
  assert.equal(made.length, 2);
  assert.deepEqual(made[1].blockedBy.map((b) => b.id), [made[0].id]);

  // A plan that references a missing dependency must leave nothing behind.
  assert.throws(() => hub.plan({
    idea: idea.slug, by: 'planner',
    tasks: [{ title: 'doomed', role: 'backend', dependsOn: [9999], absoluteDeps: true }],
  }));
  assert.equal(hub.tasks({ idea: idea.slug }).length, 2, 'the failed plan added nothing');
});

test('run() reports changes and rowids as plain numbers, not BigInt', () => {
  const db = fresh();
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
  const r = db.prepare('INSERT INTO t (b) VALUES (?)').run('x');
  assert.equal(typeof r.lastInsertRowid, 'number');
  assert.equal(typeof r.changes, 'number');
  assert.equal(r.changes, 1);
});

test('two connections on one file see each other, which is what makes a room', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esprits-db-'));
  const file = join(dir, 'room.sqlite');

  const a = new Hub({ dbPath: file });
  a.join({ name: 'rakim', role: 'human', kind: 'human' });
  const idea = a.dropIdea({ title: 'Shared', raw: 'across connections', by: 'rakim' });

  // A second connection, as a separate agent process would open.
  const b = new Hub({ dbPath: file });
  assert.equal(b.getIdea(idea.slug).raw, 'across connections');

  b.join({ name: 'bob', role: 'backend' });
  b.post({ idea: idea.slug, body: 'seen from the other side', by: 'bob' });
  assert.ok(a.search({ query: 'other side' }).length, 'and writes flow back the other way');

  a.close();
  b.close();
});

test('db.name is the resolved path, which the permission tightening relies on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esprits-db-'));
  const file = join(dir, 'named.sqlite');
  const db = openDb(file);
  assert.equal(db.name, file);
  assert.equal(fresh().name, ':memory:');
});
