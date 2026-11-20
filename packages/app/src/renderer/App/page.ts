// Everything the page knows: the list of threads, each thread it has opened,
// and which one is on screen. Pure: every change is a function from one page
// to the next.
import type { Opened, Thread, ThreadEvent } from '../../shared/threads.ts';
import { dropped, heard as heardIn, loaded, nothing, type Shown } from './shown.ts';

export type Page = {
  /** Every thread, the one most recently added to first. */
  list: readonly Thread[];
  /** Each thread the page has opened, by id. One that is answering stays up to date here while another is on screen. */
  known: Readonly<Record<string, Shown>>;
  /** The thread on screen. Undefined is a new thread, which is made when something is first said. */
  open: string | undefined;
  /** The threads an answer is on its way in. */
  answering: readonly string[];
  /** Why the last thing asked of a thread failed, by thread id. */
  failed: Readonly<Record<string, string>>;
};

/** Where a failure is kept for the thread that is not made yet. */
export const UNMADE = '';

export const blank: Page = { list: [], known: {}, open: undefined, answering: [], failed: {} };

const without = <V>(record: Readonly<Record<string, V>>, ...keys: string[]): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/** The list as main has it. */
export const listed = (page: Page, list: readonly Thread[]): Page => ({ ...page, list });

/**
 * The page after an event from main. A thread the page has opened is kept up
 * to date, on screen or not. In the list, a thread that was added to goes to
 * the top; one that only went somewhere stays where it is.
 */
export const heard = (page: Page, event: ThreadEvent): Page => {
  if (event.type === 'removed') return removed(page, event.thread);
  const id = event.type === 'chunk' ? event.thread : event.thread.id;
  const known = page.known[id];
  const kept = known ? { ...page, known: { ...page.known, [id]: heardIn(known, event) } } : page;
  if (event.type === 'chunk') return kept;
  const listedAlready = page.list.some((thread) => thread.id === id);
  const list =
    event.added.length > 0 || !listedAlready
      ? [event.thread, ...page.list.filter((thread) => thread.id !== id)]
      : page.list.map((thread) => (thread.id === id ? event.thread : thread));
  return { ...kept, list };
};

/** The page without a thread that is gone. If it was on screen, a new thread is. */
const removed = (page: Page, id: string): Page => ({
  list: page.list.filter((thread) => thread.id !== id),
  known: without(page.known, id),
  open: page.open === id ? undefined : page.open,
  answering: page.answering.filter((other) => other !== id),
  failed: without(page.failed, id),
});

/** The page once it has a whole thread from main. What it already knew of that thread is newer, and stays. */
export const learned = (page: Page, opened: Opened): Page =>
  page.known[opened.thread.id] ? page : { ...page, known: { ...page.known, [opened.thread.id]: loaded(opened) } };

/** Puts a thread on screen: one the page knows, or with undefined, a new one. */
export const selected = (page: Page, id: string | undefined): Page =>
  id === undefined || page.known[id] ? { ...page, open: id } : page;

/** Something was asked of a thread, and its answer is on its way. */
export const asked = (page: Page, id: string): Page => ({
  ...page,
  answering: [...page.answering.filter((other) => other !== id), id],
  failed: without(page.failed, id, UNMADE),
});

/** What was asked of a thread is over. With an error, it failed: whatever was arriving is not coming. */
export const settled = (page: Page, id: string, error?: string): Page => {
  const answering = page.answering.filter((other) => other !== id);
  if (error === undefined) return { ...page, answering };
  const known = page.known[id];
  return {
    ...page,
    answering,
    failed: { ...page.failed, [id]: error },
    known: known ? { ...page.known, [id]: dropped(known) } : page.known,
  };
};

// ── What the views are given ────────────────────────────────────────────────

/** What is known of the thread on screen. */
export const onScreen = (page: Page): Shown => (page.open === undefined ? undefined : page.known[page.open]) ?? nothing;

export const busy = (page: Page): boolean => page.open !== undefined && page.answering.includes(page.open);

export const error = (page: Page): string | undefined => page.failed[page.open ?? UNMADE];

/** The sidebar's entries, in the list's order. */
export const entries = (page: Page) =>
  page.list.map(({ id, title }) => ({ id, title, answering: page.answering.includes(id) }));
