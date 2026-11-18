import { test } from 'node:test';
import assert from 'node:assert/strict';
import { before, dropped, heard, landing, loaded, nothing, prompt, rows, type Shown } from './shown.ts';
import type { Item, ThreadEvent } from '../../shared/threads.ts';
import type { Row } from '../Thread/Thread.tsx';

const said = (id: string, parent: string | null, from: 'user' | 'model', text: string): Item => ({
  id,
  parent,
  message: from === 'user' ? { from, content: [{ type: 'text', text }] } : { from, content: [{ type: 'text', text }], end: 'stop' },
});
const chunk = (thread: string, text: string): ThreadEvent => ({ type: 'chunk', thread, chunk: { type: 'text', text } });
/** Items were stored, and the thread is at the last of them. */
const added = (thread: string, ...items: Item[]): ThreadEvent => ({
  type: 'changed',
  thread: { id: thread, title: 'a thread', current: items.at(-1)?.id ?? null },
  added: items,
});
/** The thread went somewhere; nothing was stored. */
const went = (thread: string, current: string): ThreadEvent => ({ type: 'changed', thread: { id: thread, title: 'a thread', current }, added: [] });
const hear = (shown: Shown, ...events: ThreadEvent[]) => events.reduce(heard, shown);
const lines = (shown: readonly Row[]) =>
  shown.map(({ message: m }) => `${m.from}: ${m.content.map((part) => ('text' in part ? part.text : `[${part.type}]`)).join('')}`);

const start = loaded({ thread: { id: 't', title: '', current: null }, items: [] });

test('before there is a thread, and in a new one, nothing is on screen', () => {
  assert.deepEqual(rows(nothing), []);
  assert.deepEqual(rows(start), []);
});

test('what is stored shows as the path to where the thread is', () => {
  const shown = hear(start, added('t', said('a', null, 'user', 'name a colour')), added('t', said('b', 'a', 'model', 'blue')));
  assert.deepEqual(lines(rows(shown)), ['user: name a colour', 'model: blue']);
  assert.equal(shown.thread?.current, 'b');
});

test('a turn shows as it arrives, after what is stored, with its text joined', () => {
  const shown = hear(start, added('t', said('a', null, 'user', 'name a colour')), chunk('t', 'bl'), chunk('t', 'ue'));
  assert.deepEqual(lines(rows(shown)), ['user: name a colour', 'model: blue']);
  // Stored rows have an id; the arriving one has none yet.
  assert.deepEqual(rows(shown).map((row) => row.id), ['a', undefined]);
  assert.equal(shown.items.length, 1);
});

test('once the turn is stored it is no longer arriving, so it shows once', () => {
  const shown = hear(
    start,
    added('t', said('a', null, 'user', 'name a colour')),
    chunk('t', 'blue'),
    { type: 'chunk', thread: 't', chunk: { type: 'end', reason: 'stop' } },
    added('t', said('b', 'a', 'model', 'blue')),
  );
  assert.deepEqual(shown.arriving, []);
  assert.deepEqual(lines(rows(shown)), ['user: name a colour', 'model: blue']);
});

test('a turn that failed is dropped, and what is stored stays', () => {
  const shown = dropped(hear(start, added('t', said('a', null, 'user', 'name a colour')), chunk('t', 'bl')));
  assert.deepEqual(lines(rows(shown)), ['user: name a colour']);
});

test('events for another thread, or before there is a thread, change nothing', () => {
  const event = added('other', said('x', null, 'user', 'elsewhere'));
  assert.equal(heard(start, event), start);
  assert.equal(heard(start, chunk('other', 'hm')), start);
  assert.equal(heard(nothing, event), nothing);
});

// ── Forks ───────────────────────────────────────────────────────────────────

//  a ─ b ─┬─ c ─ d ─ f ─ g      the first version of the second prompt, worked on last
//         └─ e ─ h              the second version
const forked = hear(
  start,
  added('t', said('a', null, 'user', 'name a colour'), said('b', 'a', 'model', 'blue')),
  added('t', said('c', 'b', 'user', 'another'), said('d', 'c', 'model', 'green')),
  added('t', said('e', 'b', 'user', 'a warmer one'), said('h', 'e', 'model', 'red')),
  went('t', 'd'),
  added('t', said('f', 'd', 'user', 'why green?'), said('g', 'f', 'model', 'it is next to blue')),
  went('t', 'h'),
);

test('only the path to where the thread is shows, not every item the page holds', () => {
  assert.equal(forked.items.length, 8);
  assert.deepEqual(lines(rows(forked)), ['user: name a colour', 'model: blue', 'user: a warmer one', 'model: red']);
});

test('each row knows its versions: everything that follows what it follows, oldest first', () => {
  assert.deepEqual(
    rows(forked).map((row) => [row.id, row.versions]),
    [['a', ['a']], ['b', ['b']], ['e', ['c', 'e']], ['h', ['h']]],
  );
});

test('a second version of the first prompt is a second way to begin', () => {
  const shown = hear(forked, added('t', said('z', null, 'user', 'name a shape')));
  assert.deepEqual(rows(shown).map((row) => [row.id, row.versions]), [['z', ['a', 'z']]]);
});

test('going somewhere changes what shows and stores nothing', () => {
  const shown = heard(forked, went('t', 'g'));
  assert.equal(shown.items, forked.items);
  assert.deepEqual(lines(rows(shown)), [
    'user: name a colour',
    'model: blue',
    'user: another',
    'model: green',
    'user: why green?',
    'model: it is next to blue',
  ]);
});

test('a new version of an item is said after whatever the item follows', () => {
  assert.equal(before(forked, 'e'), 'b');
  assert.equal(before(forked, 'c'), 'b');
  assert.equal(before(forked, 'a'), null);
  assert.throws(() => before(forked, 'nope'), /no such item: nope/);
});

test('showing a version lands where that version was last worked on', () => {
  assert.equal(landing(forked, 'c'), 'g'); // not d: the follow-up came later
  assert.equal(landing(forked, 'e'), 'h');
});

test('what an item answers is the nearest thing the user said, at or above it', () => {
  assert.equal(prompt(forked, 'h'), 'e'); // an answer: the prompt before it
  assert.equal(prompt(forked, 'e'), 'e'); // a prompt: itself
  assert.equal(prompt(forked, 'g'), 'f');
  assert.throws(() => prompt(forked, 'nope'), /no such node: nope/);
});

test('a thread being removed is not this fold\'s to act on', () => {
  assert.equal(heard(forked, { type: 'removed', thread: 't' }), forked);
});

test('reasoning shows as it arrives, joined, ahead of the answer it leads to', () => {
  const reasoning = (text: string): ThreadEvent => ({ type: 'chunk', thread: 't', chunk: { type: 'reasoning', text } });
  const asked = hear(start, added('t', said('a', null, 'user', 'name a colour')));
  // The model has started working: a part with nothing in it yet.
  assert.deepEqual(rows(hear(asked, reasoning('')))[1]?.message, { from: 'model', content: [{ type: 'reasoning', text: '' }] });
  const shown = hear(asked, reasoning(''), reasoning('The sky, '), reasoning('perhaps.'), chunk('t', 'Blue.'));
  assert.deepEqual(rows(shown)[1]?.message.content, [{ type: 'reasoning', text: 'The sky, perhaps.' }, { type: 'text', text: 'Blue.' }]);
});
