import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asked, blank, busy, entries, error, heard, learned, listed, onScreen, selected, settled, UNMADE, type Page } from './page.ts';
import { rows } from './shown.ts';
import type { Item, Thread, ThreadEvent } from '../../shared/threads.ts';

const thread = (id: string, current: string | null = null): Thread => ({ id, title: `thread ${id}`, current });
const said = (id: string, parent: string | null, text = id): Item => ({
  id,
  parent,
  message: { from: 'user', content: [{ type: 'text', text }] },
});
const chunk = (id: string, text: string): ThreadEvent => ({ type: 'chunk', thread: id, chunk: { type: 'text', text } });
const added = (id: string, ...items: Item[]): ThreadEvent => ({ type: 'changed', thread: thread(id, items.at(-1)?.id ?? null), added: items });
const went = (id: string, current: string): ThreadEvent => ({ type: 'changed', thread: thread(id, current), added: [] });
const hear = (page: Page, ...events: ThreadEvent[]) => events.reduce(heard, page);
const titles = (page: Page) => page.list.map((listed) => listed.id);
const texts = (page: Page) =>
  rows(onScreen(page)).map(({ message: m }) => `${m.from}: ${m.content.map((part) => ('text' in part ? part.text : `[${part.type}]`)).join('')}`);

// Two threads in the list; `a` has been opened and is on screen.
const two = selected(
  learned(listed(blank, [thread('b', 'b1'), thread('a', 'a1')]), { thread: thread('a', 'a1'), items: [said('a1', null, 'hello a')] }),
  'a',
);

test('a blank page shows a new thread: nothing listed, nothing on screen, nothing wrong', () => {
  assert.deepEqual(entries(blank), []);
  assert.deepEqual(rows(onScreen(blank)), []);
  assert.equal(busy(blank), false);
  assert.equal(error(blank), undefined);
});

test('a thread that is added to goes to the top of the list, and one never seen before is listed', () => {
  assert.deepEqual(titles(two), ['b', 'a']);
  assert.deepEqual(titles(heard(two, added('a', said('a2', 'a1')))), ['a', 'b']);
  assert.deepEqual(titles(heard(two, added('c', said('c1', null)))), ['c', 'b', 'a']);
});

test('a thread that only went somewhere stays where it is in the list, with where it is kept', () => {
  const page = heard(two, went('a', 'a1'));
  assert.deepEqual(titles(page), ['b', 'a']);
  assert.equal(page.list[1]?.current, 'a1');
});

test('a chunk changes nothing in the list', () => {
  assert.equal(heard(two, chunk('a', 'hi')).list, two.list);
});

test('a thread the page has opened is kept up to date; one it has not opened is only listed', () => {
  const page = hear(two, added('a', said('a2', 'a1', 'more a')), added('b', said('b2', 'b1', 'more b')));
  assert.deepEqual(texts(page), ['user: hello a', 'user: more a']);
  assert.deepEqual(Object.keys(page.known), ['a']);
});

test('a thread answering off screen is whole when it is shown again', () => {
  // `a` is answering; the user looks at a new thread meanwhile, then comes back.
  const away = hear(selected(asked(two, 'a'), undefined), chunk('a', 'bl'), chunk('a', 'ue'));
  assert.deepEqual(texts(away), []);
  assert.equal(busy(away), false);
  const back = selected(away, 'a');
  assert.deepEqual(texts(back), ['user: hello a', 'model: blue']);
  assert.equal(busy(back), true);
});

test('learning a thread the page already knows keeps what it knew, which is newer', () => {
  const ahead = heard(two, added('a', said('a2', 'a1', 'more a')));
  const again = learned(ahead, { thread: thread('a', 'a1'), items: [said('a1', null, 'hello a')] });
  assert.equal(again, ahead);
});

test('only a thread the page knows, or a new one, can be put on screen', () => {
  assert.equal(selected(two, 'b'), two);
  assert.equal(selected(two, undefined).open, undefined);
  const page = selected(learned(two, { thread: thread('b', 'b1'), items: [said('b1', null, 'hello b')] }), 'b');
  assert.deepEqual(texts(page), ['user: hello b']);
});

test('the sidebar says which threads are answering, and the screen whether its own is', () => {
  const page = asked(two, 'b');
  assert.deepEqual(entries(page), [
    { id: 'b', title: 'thread b', answering: true },
    { id: 'a', title: 'thread a', answering: false },
  ]);
  assert.equal(busy(page), false);
  assert.equal(busy(asked(page, 'a')), true);
  assert.equal(busy(settled(asked(page, 'a'), 'a')), false);
});

test('a failure belongs to its thread, drops what was arriving, and is cleared by asking again', () => {
  const failed = settled(hear(asked(two, 'a'), chunk('a', 'bl')), 'a', 'connection lost');
  assert.equal(error(failed), 'connection lost');
  assert.deepEqual(texts(failed), ['user: hello a']);
  assert.equal(busy(failed), false);
  // Another thread on screen shows no error of this one's.
  assert.equal(error(selected(failed, undefined)), undefined);
  assert.equal(error(asked(failed, 'a')), undefined);
});

test('a failure to make a new thread shows on the new thread, until something is asked', () => {
  const page = settled(selected(two, undefined), UNMADE, 'no disk');
  assert.equal(error(page), 'no disk');
  assert.equal(error(selected(page, 'a')), undefined);
  assert.equal(error(asked(page, 'a')), undefined);
  assert.equal(error(selected(asked(page, 'a'), undefined)), undefined);
});

test('a thread that is gone leaves the list, and everything the page knew of it goes too', () => {
  const page = heard(settled(asked(two, 'a'), 'a', 'connection lost'), { type: 'removed', thread: 'a' });
  assert.deepEqual(titles(page), ['b']);
  assert.deepEqual(Object.keys(page.known), []);
  assert.deepEqual(page.failed, {});
  assert.deepEqual(page.answering, []);
  // It was on screen, so a new thread is now.
  assert.equal(page.open, undefined);
  assert.deepEqual(texts(page), []);
});

test('a thread that is gone while another is on screen leaves that one on screen', () => {
  const page = heard(two, { type: 'removed', thread: 'b' });
  assert.deepEqual(titles(page), ['a']);
  assert.equal(page.open, 'a');
  assert.deepEqual(texts(page), ['user: hello a']);
  assert.equal(heard(page, { type: 'removed', thread: 'never there' }).open, 'a');
});

test('a rename shows in the list without moving the thread', () => {
  const page = heard(two, { type: 'changed', thread: { id: 'a', title: 'Renamed', current: 'a1' }, added: [] });
  assert.deepEqual(entries(page).map((entry) => entry.title), ['thread b', 'Renamed']);
});
