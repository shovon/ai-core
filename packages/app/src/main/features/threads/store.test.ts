// What any thread store has to do, run against each one there is.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMigrated } from '../../sqlite.ts';
import { memoryStore } from './memory-store.ts';
import { sqliteStore, THREAD_MIGRATIONS } from './sqlite-store.ts';
import type { ThreadStore } from './threads.ts';
import type { Item, Thread } from '../../../shared/threads.ts';

// Composition root for these tests: each store is built here, on memory or on
// a scratch file that is removed when the test ends.
const stores: Record<string, (t: TestContext) => ThreadStore> = {
  memory: () => memoryStore(),
  sqlite: (t) => {
    const db = openMigrated(':memory:', THREAD_MIGRATIONS);
    t.after(() => db.close());
    return sqliteStore(db);
  },
};

const thread = (id: string, current: string | null = null, title = `thread ${id}`): Thread => ({ id, title, current });
const said = (id: string, parent: string | null, text = id): Item => ({
  id,
  parent,
  message: { from: 'user', content: [{ type: 'text', text }] },
});
const ids = (things: readonly { id: string }[]) => things.map((thing) => thing.id);

for (const [name, open] of Object.entries(stores)) {
  test(`${name}: a thread comes back as it was put, and a second put replaces the first`, async (t) => {
    const store = open(t);
    assert.equal(await store.thread('a'), undefined);
    await store.putThread(thread('a'));
    assert.deepEqual(await store.thread('a'), thread('a'));
    await store.putThread(thread('a', 'x', 'renamed'));
    assert.deepEqual(await store.thread('a'), thread('a', 'x', 'renamed'));
    assert.equal((await store.threads()).length, 1);
  });

  test(`${name}: items come back whole, in the order added, each thread's own`, async (t) => {
    const store = open(t);
    const model: Item = {
      id: 'a2',
      parent: 'a1',
      message: { from: 'model', content: [{ type: 'text', text: 'blue' }, { type: 'native', provider: 'x', value: { n: [1, null] } }], end: 'stop', usage: { input: 3, output: 1 } },
    };
    await store.addItem('a', said('a1', null, 'name a colour'));
    await store.addItem('b', said('b1', null));
    await store.addItem('a', model);
    await store.addItem('a', said('a3', 'a1', 'a fork'));

    assert.deepEqual(await store.items('a'), [said('a1', null, 'name a colour'), model, said('a3', 'a1', 'a fork')]);
    assert.deepEqual(ids(await store.items('b')), ['b1']);
    assert.deepEqual(await store.items('nope'), []);
  });

  test(`${name}: addItem() refuses an id already in use, and a parent that is not in the thread`, async (t) => {
    const store = open(t);
    await store.addItem('a', said('a1', null));
    await store.addItem('b', said('b1', null));
    await assert.rejects(store.addItem('a', said('a1', null)), /item id already in use: a1/);
    await assert.rejects(store.addItem('b', said('a1', null)), /item id already in use: a1/);
    await assert.rejects(store.addItem('a', said('a2', 'nope')), /no such parent in this thread: nope/);
    await assert.rejects(store.addItem('a', said('a2', 'b1')), /no such parent in this thread: b1/);
    assert.deepEqual(ids(await store.items('a')), ['a1']);
  });

  test(`${name}: threads() lists the one most recently added to first`, async (t) => {
    const store = open(t);
    for (const id of ['a', 'b', 'c']) await store.putThread(thread(id));
    await store.addItem('a', said('a1', null));
    await store.addItem('b', said('b1', null));
    await store.addItem('c', said('c1', null));
    assert.deepEqual(ids(await store.threads()), ['c', 'b', 'a']);

    await store.addItem('a', said('a2', 'a1'));
    assert.deepEqual(ids(await store.threads()), ['a', 'c', 'b']);

    // Putting a thread, as going somewhere in it does, is not adding to it.
    await store.putThread(thread('b', 'b1'));
    assert.deepEqual(ids(await store.threads()), ['a', 'c', 'b']);
  });

  test(`${name}: a thread with nothing in it is listed after those with something, newest made first`, async (t) => {
    const store = open(t);
    await store.putThread(thread('empty1'));
    await store.putThread(thread('a'));
    await store.putThread(thread('empty2'));
    await store.addItem('a', said('a1', null));
    assert.deepEqual(ids(await store.threads()), ['a', 'empty2', 'empty1']);
  });
}

for (const [name, open] of Object.entries(stores)) {
  test(`${name}: removeThread() forgets the thread and its items, and nothing of any other`, async (t) => {
    const store = open(t);
    await store.putThread(thread('a'));
    await store.putThread(thread('b'));
    await store.addItem('a', said('a1', null));
    await store.addItem('a', said('a2', 'a1'));
    await store.addItem('b', said('b1', null));

    await store.removeThread('a');
    assert.equal(await store.thread('a'), undefined);
    assert.deepEqual(await store.items('a'), []);
    assert.deepEqual(ids(await store.threads()), ['b']);
    assert.deepEqual(ids(await store.items('b')), ['b1']);
    // Removing what is not there is nothing.
    await store.removeThread('a');
    await store.removeThread('nope');
    assert.deepEqual(ids(await store.threads()), ['b']);
    // Its ids are free again, and the thread can be made anew.
    await store.addItem('a', said('a1', null));
    assert.deepEqual(ids(await store.items('a')), ['a1']);
  });
}

test('sqlite: what was stored is there when the file is opened again', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'thread-store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'threads.db');

  const first = openMigrated(file, THREAD_MIGRATIONS);
  const before = sqliteStore(first);
  await before.putThread(thread('a', 'a2'));
  await before.addItem('a', said('a1', null, 'name a colour'));
  await before.addItem('a', said('a2', 'a1', 'another'));
  first.close();

  const second = openMigrated(file, THREAD_MIGRATIONS);
  t.after(() => second.close());
  const after = sqliteStore(second);
  assert.deepEqual(await after.thread('a'), thread('a', 'a2'));
  assert.deepEqual(await after.items('a'), [said('a1', null, 'name a colour'), said('a2', 'a1', 'another')]);
  // The sequence carries on from where it was.
  await after.putThread(thread('b'));
  await after.addItem('b', said('b1', null));
  assert.deepEqual(ids(await after.threads()), ['b', 'a']);
});

test('openMigrated() applies each migration once, in order, however often the file is opened', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sqlite-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  const version = (db: ReturnType<typeof openMigrated>) =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

  const one = openMigrated(file, ['CREATE TABLE a (x)']);
  assert.equal(version(one), 1);
  one.close();
  const two = openMigrated(file, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)']);
  assert.equal(version(two), 2);
  two.close();
  // A migration that fails is undone, the ones before it stay, and the file is closed.
  assert.throws(() => openMigrated(file, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)', 'CREATE TABLE c (z); NOT SQL']));
  const three = openMigrated(file, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)']);
  t.after(() => three.close());
  assert.equal(version(three), 2);
  assert.deepEqual(
    (three.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name),
    ['a', 'b'],
  );
});
