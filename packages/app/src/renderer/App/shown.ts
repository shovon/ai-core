// What the page knows of one thread, and how each event from main changes it.
// Pure: the page's state is a fold of the events it has heard.
import { append, type Part, type Reply } from '@ai-idioms/core';
import { add, path, tip, type Tree } from '@ai-agent-library/tree';
import type { Item, Opened, Thread, ThreadEvent } from '../../shared/threads.ts';
import type { Row } from '../Thread/Thread.tsx';

export type Shown = {
  /** The thread on screen; undefined before there is one. */
  thread: Thread | undefined;
  /** Every item of the thread, on screen or not, in the order added. */
  items: Tree<Item>;
  /** The turn that is arriving and not stored yet. */
  arriving: Reply<Part>;
};

export const nothing: Shown = { thread: undefined, items: [], arriving: [] };

/** A thread as main has it, with nothing arriving. */
export const loaded = ({ thread, items }: Opened): Shown => ({ thread, items, arriving: [] });

/** What the page knows after an event. An event for another thread changes nothing, nor does a thread's removal: that is the page's to act on. */
export const heard = (shown: Shown, event: ThreadEvent): Shown => {
  if (event.type === 'removed') return shown;
  const id = event.type === 'chunk' ? event.thread : event.thread.id;
  if (shown.thread?.id !== id) return shown;
  if (event.type === 'chunk') return { ...shown, arriving: append(shown.arriving, event.chunk) };
  // Stored now, so no longer arriving.
  return {
    thread: event.thread,
    items: event.added.reduce((tree, item) => add(tree, item), shown.items),
    arriving: [],
  };
};

/** The turn that was arriving is not coming: the call failed. */
export const dropped = (shown: Shown): Shown => ({ ...shown, arriving: [] });

/**
 * The history on screen: the path to where the thread is, then whatever is
 * arriving. Each stored row knows its versions: every item that follows what
 * it follows, itself among them, oldest first.
 */
export const rows = (shown: Shown): readonly Row[] => {
  const current = shown.thread?.current;
  const following = Map.groupBy(shown.items, (item) => item.parent);
  const stored = current
    ? path(shown.items, current).map((item) => ({
        id: item.id,
        message: item.message,
        versions: (following.get(item.parent) ?? []).map((version) => version.id),
      }))
    : [];
  return [...stored, ...shown.arriving.map((message) => ({ message }))];
};

/** What a new version of an item is said after: whatever the item itself follows. */
export const before = (shown: Shown, id: string): string | null => {
  const item = shown.items.find((known) => known.id === id);
  if (!item) throw new Error(`no such item: ${id}`);
  return item.parent;
};

/**
 * What an item is an answer to: the nearest thing the user said at or above
 * it. Answering that again is how an answer is retried, and how a prompt left
 * without one gets one.
 */
export const prompt = (shown: Shown, id: string): string => {
  const asked = path(shown.items, id).findLast((item) => item.message.from === 'user');
  if (!asked) throw new Error(`nothing was said before: ${id}`);
  return asked.id;
};

/** Where the thread goes to show a version: where that version was last worked on. */
export const landing = (shown: Shown, id: string): string => tip(shown.items, id).id;
