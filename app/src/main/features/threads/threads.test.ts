import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tool, type AnyMessage, type End, type PortableMessage, type Provider, type Tool } from '@ai-agent-library/library';
import { children, path } from '@ai-agent-library/tree';
import { createThreads, titleOf, TOOL_ROUNDS } from './threads.ts';
import { memoryStore } from './memory-store.ts';
import type { ModelPart, ThreadEvent } from '../../../shared/threads.ts';

const say = (text: string): ModelPart => ({ type: 'text', text });
const stop: End = { type: 'end', reason: 'stop' };
const pause: End = { type: 'end', reason: 'pause' };

// A provider that plays back one scripted turn per call, and records the
// history it was given each time. An Error in a turn is thrown when reached.
const scripted = (...turns: (ModelPart | End | Error)[][]) => {
  const seen: (readonly PortableMessage[])[] = [];
  const provider: Provider<PortableMessage, ModelPart> = async function* ({ messages }) {
    seen.push([...messages]);
    for (const chunk of turns[seen.length - 1] ?? [new Error('nothing scripted')]) {
      if (chunk instanceof Error) throw chunk;
      yield chunk;
    }
  };
  return Object.assign(provider, { seen });
};

const setup = (provider: Provider<PortableMessage, ModelPart>, tools?: readonly Tool[]) => {
  const events: ThreadEvent[] = [];
  const store = memoryStore();
  let n = 0;
  const threads = createThreads({ store, provider, tools, newId: () => `id${++n}`, emit: (event) => events.push(event) });
  const current = async (id: string) => (await store.thread(id))?.current ?? null;
  // Says it where the thread is, as the composer does.
  const go = async (id: string, text: string) => threads.send(id, await current(id), text);
  // The history on screen: the path to where the thread is.
  const shown = async (id: string) => {
    const at = await current(id);
    return at === null ? [] : lines(path(await store.items(id), at).map((item) => item.message));
  };
  return { threads, store, events, current, go, shown };
};

// An event in a line.
const told = (event: ThreadEvent) => {
  if (event.type === 'chunk') return `chunk ${JSON.stringify(event.chunk)}`;
  if (event.type === 'removed') return `removed ${event.thread}`;
  return `added ${event.added.map((item) => item.id)} now at ${event.thread.current}`;
};

// Each message as "who: what", the text only.
const lines = (messages: readonly AnyMessage[]) =>
  messages.map((m) => `${m.from}: ${m.content.map((part) => ('text' in part ? part.text : `[${part.type}]`)).join('')}`);

test('a new thread has nothing in it and is nowhere yet', async () => {
  const { threads, store } = setup(scripted());
  const thread = await threads.create();
  assert.deepEqual(thread, { id: 'id1', title: '', current: null });
  assert.deepEqual(await store.thread('id1'), thread);
  assert.deepEqual(await store.items('id1'), []);
});

test('send() stores what was said, then the answer, each following the one before', async () => {
  const provider = scripted([say('bl'), say('ue'), stop]);
  const { threads, store } = setup(provider);
  const { id } = await threads.create();
  await threads.send(id, null, 'name a colour');

  const items = await store.items(id);
  assert.deepEqual(
    items.map((item) => [item.id, item.parent]),
    [['id2', null], ['id3', 'id2']],
  );
  assert.deepEqual(items[1]?.message, { from: 'model', content: [{ type: 'text', text: 'blue' }], end: 'stop' });
  assert.deepEqual(await store.thread(id), { id, title: 'name a colour', current: 'id3' });
  // The model was asked with what had been said, and nothing else.
  assert.deepEqual(provider.seen.map(lines), [['user: name a colour']]);
});

test('the model is given the path to where the thread is, which grows with each send', async () => {
  const provider = scripted([say('blue'), stop], [say('green'), stop]);
  const { threads, go, shown } = setup(provider);
  const { id } = await threads.create();
  await go(id, 'name a colour');
  await go(id, 'another');

  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: name a colour', 'model: blue', 'user: another']);
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue', 'user: another', 'model: green']);
});

test('the page is told in order: what was said, each piece as it arrives, then the stored answer', async () => {
  const { threads, events } = setup(scripted([say('bl'), say('ue'), stop]));
  const { id } = await threads.create();
  await threads.send(id, null, 'name a colour');

  assert.deepEqual(
    events.map(told),
    [
      'added id2 now at id2',
      'chunk {"type":"text","text":"bl"}',
      'chunk {"type":"text","text":"ue"}',
      'chunk {"type":"end","reason":"stop"}',
      'added id3 now at id3',
    ],
  );
  assert.ok(events.every((event) => (event.type === 'changed' ? event.thread.id : event.thread) === id));
});

test('a paused turn is stored and sent back as it is, until the model is done', async () => {
  const provider = scripted([say('let me look'), pause], [say('blue'), stop]);
  const { threads, shown } = setup(provider);
  const { id } = await threads.create();
  await threads.send(id, null, 'name a colour');

  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: name a colour', 'model: let me look']);
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: let me look', 'model: blue']);
});

test('a turn that fails part-way is not stored: what was said stays, and the thread can go on', async () => {
  const provider = scripted([say('bl'), new Error('connection lost')], [say('blue'), stop]);
  const { threads, store, go, shown } = setup(provider);
  const { id } = await threads.create();
  await assert.rejects(threads.send(id, null, 'name a colour'), /connection lost/);

  assert.deepEqual(await shown(id), ['user: name a colour']);
  assert.deepEqual(await store.thread(id), { id, title: 'name a colour', current: 'id2' });

  await go(id, 'are you there?');
  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: name a colour', 'user: are you there?']);
});

test('a turn that ends without saying it ended is a failure, not an answer', async () => {
  const { threads, store } = setup(scripted([say('bl')]));
  const { id } = await threads.create();
  await assert.rejects(threads.send(id, null, 'name a colour'), /without an end chunk/);
  assert.equal((await store.items(id)).length, 1);
});

test('a thread answers one thing at a time, and stays where it is until it has', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const provider: Provider<PortableMessage, ModelPart> = async function* () {
    await held;
    yield say('blue');
    yield stop;
  };
  const { threads, shown } = setup(provider);
  const { id } = await threads.create();
  const first = threads.send(id, null, 'name a colour');
  await assert.rejects(threads.send(id, null, 'hurry up'), /still answering/);
  await assert.rejects(threads.goTo(id, 'id2'), /still answering/);
  release();
  await first;
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue']);
});

test('send() to a thread that does not exist fails, and asks the model nothing', async () => {
  const provider = scripted([say('blue'), stop]);
  const { threads } = setup(provider);
  await assert.rejects(threads.send('nope', null, 'hello'), /no such thread: nope/);
  assert.equal(provider.seen.length, 0);
});

test('two threads keep their own histories', async () => {
  const provider = scripted([say('blue'), stop], [say('square'), stop]);
  const { threads } = setup(provider);
  const one = await threads.create();
  const two = await threads.create();
  await threads.send(one.id, null, 'name a colour');
  await threads.send(two.id, null, 'name a shape');
  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: name a shape']);
});

// ── Forks ───────────────────────────────────────────────────────────────────

// A thread two exchanges long:  id2 user ─ id3 model ─ id4 user ─ id5 model
const twoExchanges = async () => {
  const provider = scripted([say('blue'), stop], [say('green'), stop], [say('red'), stop], [say('pink'), stop]);
  const made = setup(provider);
  const { id } = await made.threads.create();
  await made.go(id, 'name a colour');
  await made.go(id, 'another');
  return { ...made, provider, id };
};

test('saying something after an item that already has something after it is a fork', async () => {
  const { threads, store, provider, id, shown } = await twoExchanges();
  // A new version of the second prompt, id4: it follows what id4 followed.
  await threads.send(id, 'id3', 'a warmer one');

  // The model was given the history up to the fork, then the new version.
  assert.deepEqual(lines(provider.seen[2] ?? []), ['user: name a colour', 'model: blue', 'user: a warmer one']);
  // The thread is on the new branch.
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue', 'user: a warmer one', 'model: red']);
  // Both versions follow the same item, oldest first, and the old branch is all still there.
  const items = await store.items(id);
  assert.deepEqual(children(items, 'id3').map((item) => item.id), ['id4', 'id6']);
  assert.deepEqual(lines(path(items, 'id5').map((item) => item.message)), [
    'user: name a colour',
    'model: blue',
    'user: another',
    'model: green',
  ]);
  assert.equal(items.length, 6);
});

test('a new version of the very first prompt begins the thread a second way', async () => {
  const { threads, store, provider, id, shown } = await twoExchanges();
  await threads.send(id, null, 'name a shape');

  assert.deepEqual(lines(provider.seen[2] ?? []), ['user: name a shape']);
  assert.deepEqual(await shown(id), ['user: name a shape', 'model: red']);
  assert.deepEqual(children(await store.items(id), null).map((item) => item.id), ['id2', 'id6']);
});

test('goTo() puts the thread at an item, and the next thing said goes on from there', async () => {
  const { threads, events, provider, id, go, shown } = await twoExchanges();
  await threads.send(id, 'id3', 'a warmer one'); // now on the new branch, at id7
  events.length = 0;

  await threads.goTo(id, 'id5'); // back to the older branch
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue', 'user: another', 'model: green']);
  // The page is told where the thread is; nothing was added, and the model was not asked.
  assert.deepEqual(events, [{ type: 'changed', thread: { id, title: 'name a colour', current: 'id5' }, added: [] }]);
  assert.equal(provider.seen.length, 3);

  await go(id, 'why green?');
  assert.deepEqual(lines(provider.seen[3] ?? []), [
    'user: name a colour',
    'model: blue',
    'user: another',
    'model: green',
    'user: why green?',
  ]);
});

test('send() after, and goTo(), an item that is not in the thread fail and change nothing', async () => {
  const { threads, store, provider, id } = await twoExchanges();
  const other = await threads.create();
  await threads.send(other.id, null, 'elsewhere'); // id7, id8: another thread's items

  await assert.rejects(threads.send(id, 'nope', 'hello'), /no such item in this thread: nope/);
  await assert.rejects(threads.send(id, 'id7', 'hello'), /no such item in this thread: id7/);
  await assert.rejects(threads.goTo(id, 'id8'), /no such item in this thread: id8/);
  await assert.rejects(threads.goTo('nope', 'id5'), /no such thread: nope/);

  assert.equal((await store.items(id)).length, 4);
  assert.deepEqual(await store.thread(id), { id, title: 'name a colour', current: 'id5' });
  assert.equal(provider.seen.length, 3);
});

// ── The list ────────────────────────────────────────────────────────────────

test('a thread is named by the first thing said in it, and keeps that name', async () => {
  const { threads, store, id } = await twoExchanges();
  assert.equal((await store.thread(id))?.title, 'name a colour');
  // Not by a later version of the first prompt either.
  await threads.send(id, null, 'name a shape');
  assert.equal((await store.thread(id))?.title, 'name a colour');
});

test('titleOf() is the first line with anything on it, on one line, cut to fit a list', () => {
  assert.equal(titleOf('name a colour'), 'name a colour');
  assert.equal(titleOf('\n\n  name   a\tcolour  \nand say why'), 'name a colour');
  assert.equal(titleOf('   '), '');
  const long = titleOf('word '.repeat(40));
  assert.equal([...long].length <= 60, true);
  assert.match(long, /^word word .* word…$/);
  // Cut between characters, never inside one.
  assert.equal(titleOf('😀'.repeat(80)), '😀'.repeat(59) + '…');
});

test('list() is every thread, the one most recently added to first', async () => {
  const provider = scripted([say('blue'), stop], [say('square'), stop], [say('green'), stop]);
  const { threads, go } = setup(provider);
  const one = await threads.create();
  const two = await threads.create();
  await go(one.id, 'name a colour');
  await go(two.id, 'name a shape');
  assert.deepEqual((await threads.list()).map((thread) => thread.title), ['name a shape', 'name a colour']);

  await go(one.id, 'another');
  assert.deepEqual((await threads.list()).map((thread) => thread.title), ['name a colour', 'name a shape']);

  // Going somewhere in a thread is not adding to it.
  await threads.goTo(two.id, (await threads.read(two.id))?.items[0]?.id ?? '');
  assert.deepEqual((await threads.list()).map((thread) => thread.title), ['name a colour', 'name a shape']);
});

test('read() is the whole thread, every branch of it, or undefined', async () => {
  const { threads, id } = await twoExchanges();
  await threads.send(id, 'id3', 'a warmer one');
  const opened = await threads.read(id);
  assert.deepEqual(opened?.thread, { id, title: 'name a colour', current: 'id7' });
  assert.deepEqual(opened?.items.map((item) => [item.id, item.parent]), [
    ['id2', null], ['id3', 'id2'], ['id4', 'id3'], ['id5', 'id4'], ['id6', 'id3'], ['id7', 'id6'],
  ]);
  assert.equal(await threads.read('nope'), undefined);
});

// ── Stopping ────────────────────────────────────────────────────────────────

// A provider that says each of the given pieces and then waits, as a slow
// answer does, until it is stopped: then it throws, as an aborted call does.
const stalling = (...pieces: string[]) => {
  let calls = 0;
  const provider: Provider<PortableMessage, ModelPart> = async function* ({ signal }) {
    calls++;
    for (const piece of pieces) yield say(piece);
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(new Error('aborted'));
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  return Object.assign(provider, { calls: () => calls });
};
// Lets what is already under way get as far as it can.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('stop() keeps what had arrived as a turn that never ended, and the send settles without an error', async () => {
  const { threads, store, events, shown } = setup(stalling('bl', 'ue is'));
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.stop(id);
  await sending;

  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue is']);
  // No `end`: it did not finish, and nothing says it did.
  assert.deepEqual((await store.items(id))[1]?.message, { from: 'model', content: [{ type: 'text', text: 'blue is' }] });
  // The page is told it is stored, so it is no longer arriving.
  const last = events.at(-1);
  assert.equal(last?.type === 'changed' && last.added.length, 1);
});

test('stop() before anything to read has arrived keeps nothing, and still tells the page', async () => {
  const { threads, events, shown, current } = setup(stalling());
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.stop(id);
  await sending;

  assert.deepEqual(await shown(id), ['user: name a colour']);
  assert.deepEqual(events.at(-1), { type: 'changed', thread: { id, title: 'name a colour', current: await current(id) }, added: [] });
});

test('a stopped thread goes on from what was kept, and stop() with nothing on its way is nothing', async () => {
  let stalled = true;
  const seen: (readonly PortableMessage[])[] = [];
  const stall = stalling('blue is');
  const provider: Provider<PortableMessage, ModelPart> = async function* (request) {
    seen.push([...request.messages]);
    if (stalled) return yield* stall(request);
    yield say('sorry, blue');
    yield stop;
  };
  const { threads, go, shown } = setup(provider);
  const { id } = await threads.create();
  await threads.stop(id); // nothing to stop
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.stop(id);
  await sending;

  stalled = false;
  await go(id, 'go on');
  assert.deepEqual(lines(seen[1] ?? []), ['user: name a colour', 'model: blue is', 'user: go on']);
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue is', 'user: go on', 'model: sorry, blue']);
});

// ── Answering again ─────────────────────────────────────────────────────────

test('answer() answers what was said again: the new answer is a fork beside the old one', async () => {
  const { threads, store, provider, id, shown } = await twoExchanges();
  // The second prompt is id4, and id5 answered it.
  await threads.answer(id, 'id4');

  assert.deepEqual(lines(provider.seen[2] ?? []), ['user: name a colour', 'model: blue', 'user: another']);
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue', 'user: another', 'model: red']);
  const items = await store.items(id);
  assert.deepEqual(children(items, 'id4').map((item) => item.id), ['id5', 'id6']);
  // Nothing was said: only the answer was added.
  assert.equal(items.length, 5);
});

test('answer() is also how a prompt left without an answer gets one', async () => {
  const provider = scripted([say('bl'), new Error('connection lost')], [say('blue'), stop]);
  const { threads, shown } = setup(provider);
  const { id } = await threads.create();
  await assert.rejects(threads.send(id, null, 'name a colour'), /connection lost/);
  await threads.answer(id, 'id2');
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue']);
  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: name a colour']);
});

test('answer() refuses a model turn and an item that is not in the thread, and asks the model nothing', async () => {
  const { threads, store, provider, id } = await twoExchanges();
  await assert.rejects(threads.answer(id, 'id5'), /nothing to answer in a model turn: id5/);
  await assert.rejects(threads.answer(id, 'nope'), /no such item in this thread: nope/);
  assert.equal(provider.seen.length, 2);
  assert.deepEqual(await store.thread(id), { id, title: 'name a colour', current: 'id5' });
});

// ── Renaming and removing ───────────────────────────────────────────────────

test('rename() names the thread, tells the page, and the name outlasts what is said next', async () => {
  const { threads, store, events, id, go } = await twoExchanges();
  events.length = 0;
  await threads.rename(id, '  Colours,\n and more ');
  assert.deepEqual(events, [{ type: 'changed', thread: { id, title: 'Colours,', current: 'id5' }, added: [] }]);
  await go(id, 'a third');
  assert.equal((await store.thread(id))?.title, 'Colours,');
  await assert.rejects(threads.rename(id, '  \n '), /a thread needs a name/);
  await assert.rejects(threads.rename('nope', 'x'), /no such thread: nope/);
});

test('a thread renamed while it is answering keeps the new name when the answer is stored', async () => {
  const { threads, store, shown } = setup(stalling('blue'));
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.rename(id, 'Colours');
  await threads.stop(id);
  await sending;
  assert.equal((await store.thread(id))?.title, 'Colours');
  assert.deepEqual(await shown(id), ['user: name a colour', 'model: blue']);
});

test('remove() takes the thread and everything in it, tells the page, and leaves the others', async () => {
  const { threads, store, events, id } = await twoExchanges();
  const other = await threads.create();
  await threads.send(other.id, null, 'elsewhere');
  events.length = 0;

  await threads.remove(id);
  assert.deepEqual(events, [{ type: 'removed', thread: id }]);
  assert.equal(await threads.read(id), undefined);
  assert.deepEqual(await store.items(id), []);
  assert.deepEqual((await threads.list()).map((thread) => thread.id), [other.id]);
  await assert.rejects(threads.remove(id), /no such thread/);
  await assert.rejects(threads.send(id, null, 'hello'), /no such thread/);
});

test('remove() of a thread that is answering stops the answer first, and nothing is left behind', async () => {
  const { threads, store, events } = setup(stalling('bl'));
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.remove(id);
  await sending;

  assert.equal(await store.thread(id), undefined);
  assert.deepEqual(await store.items(id), []);
  assert.deepEqual(events.at(-1), { type: 'removed', thread: id });
  assert.deepEqual(await threads.list(), []);
});

// ── Reasoning ───────────────────────────────────────────────────────────────

const thinks = (text: string): ModelPart => ({ type: 'reasoning', text });

test('reasoning reaches the page as it arrives, and is stored with the turn it led to', async () => {
  const { threads, store, events } = setup(scripted([thinks(''), thinks('The sky, '), thinks('perhaps.'), say('Blue.'), stop]));
  const { id } = await threads.create();
  await threads.send(id, null, 'name a colour');

  assert.deepEqual(events.map(told).slice(1, 4), [
    'chunk {"type":"reasoning","text":""}',
    'chunk {"type":"reasoning","text":"The sky, "}',
    'chunk {"type":"reasoning","text":"perhaps."}',
  ]);
  assert.deepEqual((await store.items(id))[1]?.message, {
    from: 'model',
    content: [{ type: 'reasoning', text: 'The sky, perhaps.' }, { type: 'text', text: 'Blue.' }],
    end: 'stop',
  });
});

test('a turn stopped while the model was still only thinking keeps nothing: there is no answer in it', async () => {
  const stall = stalling();
  const provider: Provider<PortableMessage, ModelPart> = async function* (request) {
    yield thinks('');
    yield thinks('The sky, perhaps.');
    yield* stall(request);
  };
  const { threads, shown } = setup(provider);
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'name a colour');
  await settle();
  await threads.stop(id);
  await sending;
  assert.deepEqual(await shown(id), ['user: name a colour']);
});

// ── Tools ───────────────────────────────────────────────────────────────────

const calls = (id: string, name: string, input: unknown = {}): ModelPart => ({ type: 'tool_call', id, name, input });
// A tool that looks a word up in a small book, and records what it was asked.
const lookup = (book: Record<string, string>) => {
  const asked: string[] = [];
  const made = tool({
    name: 'look_up',
    description: 'Looks a word up.',
    schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
    run: ({ word }) => {
      asked.push(word);
      const found = book[word];
      if (found === undefined) throw new Error(`no entry for ${word}`);
      return found;
    },
  });
  return Object.assign(made, { asked });
};
// What a tool message holds, as "id: text" with a mark on a failure.
const results = (message: PortableMessage | undefined) =>
  message?.from === 'tool' ? message.content.map((r) => `${r.id}: ${r.error ? 'ERROR ' : ''}${r.content.map((p) => ('text' in p ? p.text : '')).join('')}`) : [];

test('a turn that asks for a tool gets it run, and the model is asked again with the result', async () => {
  const provider = scripted([say('Let me look.'), calls('c1', 'look_up', { word: 'azure' }), stop], [say('A shade of blue.'), stop]);
  const book = lookup({ azure: 'the blue of a clear sky' });
  const { threads, store, events } = setup(provider, [book]);
  const { id } = await threads.create();
  await threads.send(id, null, 'what is azure?');

  assert.deepEqual(book.asked, ['azure']);
  // What was said, the turn that asked, the result, and the answer: each follows the one before.
  const items = await store.items(id);
  assert.deepEqual(items.map((item) => [item.id, item.parent, item.message.from]), [
    ['id2', null, 'user'], ['id3', 'id2', 'model'], ['id4', 'id3', 'tool'], ['id5', 'id4', 'model'],
  ]);
  assert.deepEqual(results(items[2]?.message), ['c1: the blue of a clear sky']);
  // The second request holds the call and its result.
  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: what is azure?', 'model: Let me look.[tool_call]', 'tool: [tool_result]']);
  // The page is told of each as it is stored.
  assert.deepEqual(events.filter((event) => event.type === 'changed').map(told), [
    'added id2 now at id2', 'added id3 now at id3', 'added id4 now at id4', 'added id5 now at id5',
  ]);
});

test('several calls in one turn are all run, and their results go back together', async () => {
  const provider = scripted([calls('c1', 'look_up', { word: 'azure' }), calls('c2', 'look_up', { word: 'ochre' }), stop], [say('Blue and yellow.'), stop]);
  const { threads, store } = setup(provider, [lookup({ azure: 'blue', ochre: 'yellow' })]);
  const { id } = await threads.create();
  await threads.send(id, null, 'azure and ochre?');
  assert.deepEqual(results((await store.items(id))[2]?.message), ['c1: blue', 'c2: yellow']);
});

test('a tool that fails, and a tool that is not there, are results too: the model reads them and goes on', async () => {
  const provider = scripted([calls('c1', 'look_up', { word: 'mauve' }), calls('c2', 'fly'), stop], [say('I could not find it.'), stop]);
  const { threads, store, shown } = setup(provider, [lookup({})]);
  const { id } = await threads.create();
  await threads.send(id, null, 'what is mauve?');
  assert.deepEqual(results((await store.items(id))[2]?.message), ['c1: ERROR no entry for mauve', 'c2: ERROR unknown tool: fly']);
  assert.equal((await shown(id)).at(-1), 'model: I could not find it.');
});

test('with no tools, none are offered: the request does not mention them', async () => {
  const requests: object[] = [];
  const provider: Provider<PortableMessage, ModelPart> = async function* (request) {
    requests.push(request);
    yield say('blue');
    yield stop;
  };
  const without = setup(provider);
  await without.threads.send((await without.threads.create()).id, null, 'name a colour');
  const withOne = setup(provider, [lookup({})]);
  await withOne.threads.send((await withOne.threads.create()).id, null, 'name a colour');
  assert.equal('tools' in (requests[0] ?? {}), false);
  assert.deepEqual((requests[1] as { tools: Tool[] }).tools.map((offered) => offered.name), ['look_up']);
});

test('stopped while a tool runs: every call still gets a result, so the thread can go on', async () => {
  const slow = tool({
    name: 'look_up',
    description: 'Looks a word up, slowly.',
    schema: { type: 'object' },
    run: (_input, { signal }) => new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const provider = scripted([calls('c1', 'look_up'), calls('c2', 'look_up'), stop], [say('Never mind.'), stop]);
  const { threads, store, go } = setup(provider, [slow]);
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'what is azure?');
  await settle();
  await threads.stop(id);
  await sending;

  assert.deepEqual(results((await store.items(id))[2]?.message), ['c1: ERROR Stopped before this finished.', 'c2: ERROR Stopped before this finished.']);
  // What is sent next has a result for each call.
  await go(id, 'never mind');
  assert.deepEqual(lines(provider.seen[1] ?? []), ['user: what is azure?', 'model: [tool_call][tool_call]', 'tool: [tool_result][tool_result]', 'user: never mind']);
});

test('a turn stopped after it asked for a tool is kept without the call, which was never run', async () => {
  const stall = stalling();
  const provider: Provider<PortableMessage, ModelPart> = async function* (request) {
    yield say('Let me look.');
    yield calls('c1', 'look_up', { word: 'azure' });
    yield* stall(request);
  };
  const book = lookup({ azure: 'blue' });
  const { threads, store } = setup(provider, [book]);
  const { id } = await threads.create();
  const sending = threads.send(id, null, 'what is azure?');
  await settle();
  await threads.stop(id);
  await sending;

  assert.deepEqual(book.asked, []);
  assert.deepEqual((await store.items(id))[1]?.message, { from: 'model', content: [{ type: 'text', text: 'Let me look.' }] });
});

test('a model that never stops asking for tools is stopped, with every call it made answered', async () => {
  let n = 0;
  const provider: Provider<PortableMessage, ModelPart> = async function* () {
    yield calls(`c${++n}`, 'look_up', { word: 'azure' });
    yield stop;
  };
  const book = lookup({ azure: 'blue' });
  const { threads, store } = setup(provider, [book]);
  const { id } = await threads.create();
  await assert.rejects(threads.send(id, null, 'what is azure?'), new RegExp(`stopped after ${TOOL_ROUNDS} rounds of tool calls`));

  assert.equal(book.asked.length, TOOL_ROUNDS);
  // The last calls were not run, and are told so: no call is left without a result.
  const items = await store.items(id);
  assert.deepEqual(results(items.at(-1)?.message), [`c${TOOL_ROUNDS + 1}: ERROR Not run: too many rounds of tool calls in one answer.`]);
  assert.equal(items.filter((item) => item.message.from === 'tool').length, TOOL_ROUNDS + 1);
});
