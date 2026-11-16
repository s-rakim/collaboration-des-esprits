import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hub } from '../src/core.js';
import { createChats } from '../src/chats.js';

function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'malcolm', role: 'human', kind: 'human' });
  hub.join({ name: 'ada', role: 'architect', kind: 'agent' });
  const switched = [];
  const chats = createChats({ db: hub.db, onSwitch: (id) => switched.push(id) });
  return { hub, chats, switched };
}
const said = (hub) => hub.recent({ idea: null }).filter((m) => m.authorKind !== 'system').map((m) => m.body);

test('what was in the lobby before chats existed becomes the first chat — nothing is lost', () => {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'malcolm', role: 'human', kind: 'human' });
  hub.post({ body: 'from before', by: 'malcolm' });
  const chats = createChats({ db: hub.db });
  const { current, chats: list } = chats.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, current);
  assert.equal(list[0].title, 'from before');
  assert.deepEqual(said(hub), ['from before']);
});

test('a new chat is a clean page, for the person and for the agents', () => {
  const { hub, chats, switched } = room();
  chats.init();
  hub.post({ body: 'Which database should the notes app use?', by: 'malcolm' });
  hub.post({ body: 'SQLite.', by: 'ada' });
  assert.equal(said(hub).length, 2);

  const first = chats.current();
  chats.start();
  assert.notEqual(chats.current(), first);
  assert.deepEqual(switched, [chats.current()]);
  // What an agent is shown of the lobby is this chat and only this chat.
  assert.deepEqual(said(hub), []);
  hub.post({ body: 'A different subject', by: 'malcolm' });
  assert.deepEqual(said(hub), ['A different subject']);

  // Going back shows the first conversation again, whole.
  chats.open(first);
  assert.deepEqual(said(hub), ['Which database should the notes app use?', 'SQLite.']);
  // And what is said now lands in it.
  hub.post({ body: 'And for search?', by: 'malcolm' });
  assert.equal(said(hub).length, 3);
});

test('a chat is named after the first thing said in it, until somebody names it', () => {
  const { hub, chats } = room();
  chats.init();
  assert.equal(chats.list().chats[0].title, 'New chat');
  hub.post({ body: `A long opening line ${'that goes on '.repeat(10)}`, by: 'malcolm' });
  const auto = chats.list().chats[0];
  assert.ok(auto.title.startsWith('A long opening line'));
  assert.ok(auto.title.length <= 60);
  assert.equal(auto.named, false);
  chats.rename(auto.id, '  Notes app  ');
  assert.equal(chats.list().chats[0].title, 'Notes app');
  chats.rename(auto.id, '');
  assert.ok(chats.list().chats[0].title.startsWith('A long opening line'));
});

test('new chats do not pile up empty', () => {
  const { chats } = room();
  chats.init();
  chats.start(); chats.start(); chats.start();
  assert.equal(chats.list().chats.length, 1);
});

test('deleting a chat deletes what was said in it, and only that', () => {
  const { hub, chats } = room();
  chats.init();
  const first = chats.current();
  const kept = hub.post({ body: 'keep me', by: 'malcolm' });
  const idea = hub.dropIdea({ title: 'An idea', raw: 'from the lobby', by: 'malcolm' });
  hub.post({ idea: idea.slug, body: 'said inside the idea', by: 'ada' });
  chats.start();
  const second = chats.current();
  hub.post({ body: 'throwaway', by: 'malcolm', replyTo: kept.id });
  hub.react?.({ message: hub.recent({ idea: null }).at(-1).id, emoji: '👍', by: 'ada' });

  // Deleting the chat the room is in moves the room to another.
  const r = chats.remove(second);
  assert.ok(r.removed >= 1);
  assert.equal(chats.current(), first);
  assert.ok(said(hub).includes('keep me'));
  assert.ok(!said(hub).includes('throwaway'));
  // An idea has its own thread; it is not part of any chat.
  assert.equal(hub.recent({ idea: idea.slug }).filter((m) => m.body === 'said inside the idea').length, 1);

  // Deleting the last one leaves a fresh, empty chat to be in.
  chats.remove(first);
  assert.equal(chats.list().chats.length, 1);
  assert.deepEqual(said(hub), []);
  assert.throws(() => chats.remove(9999), /no such chat/);
});

test('removing an agent takes its name off the room and leaves what it said', () => {
  const { hub } = room();
  hub.post({ body: 'I said this', by: 'ada' });
  assert.ok(hub.roster().some((a) => a.name === 'ada'));
  assert.equal(hub.removeAgent('ADA'), true);
  assert.ok(!hub.roster().some((a) => a.name === 'ada'));
  assert.ok(hub.recent({ idea: null }).some((m) => m.body === 'I said this' && m.author === 'ada'));
  assert.equal(hub.removeAgent('ada'), false);
  // The name is free to be joined under again.
  hub.join({ name: 'ada', role: 'critic', kind: 'agent' });
  assert.equal(hub.roster().find((a) => a.name === 'ada').role, 'critic');
});
