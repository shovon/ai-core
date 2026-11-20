import type { Item, Thread } from '../../../shared/threads.ts';
import type { ThreadStore } from './threads.ts';

/** Threads kept in memory: gone when the app quits. For tests, and for running without a disk. */
export const memoryStore = (): ThreadStore => {
  const threads = new Map<string, Thread>();
  // Every item of every thread, in the order added: the one sequence there is.
  let items: { thread: string; item: Item }[] = [];
  const of = (thread: string) => items.filter((entry) => entry.thread === thread).map((entry) => entry.item);
  const newest = (thread: string) => items.findLastIndex((entry) => entry.thread === thread);
  return {
    thread: async (id) => threads.get(id),
    threads: async () => {
      // A stable sort: threads with nothing in them stay in the order they were made, newest first.
      const made = [...threads.values()].reverse();
      return made.sort((a, b) => newest(b.id) - newest(a.id));
    },
    putThread: async (thread) => {
      threads.set(thread.id, thread);
    },
    removeThread: async (id) => {
      threads.delete(id);
      items = items.filter((entry) => entry.thread !== id);
    },
    items: async (thread) => of(thread),
    addItem: async (thread, item) => {
      if (items.some((entry) => entry.item.id === item.id)) throw new Error(`item id already in use: ${item.id}`);
      if (item.parent !== null && !of(thread).some((known) => known.id === item.parent))
        throw new Error(`no such parent in this thread: ${item.parent}`);
      items.push({ thread, item });
    },
  };
};
