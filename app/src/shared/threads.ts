/**
 * The threads contract: channel names, the data both sides agree on, and the
 * surface on `window.agent.threads`. Bundled into the page too, so it stays
 * free of `node:` imports. Everything here crosses the bridge as plain JSON.
 */
import type { End, NativePart, PortableMessage, ReasoningPart, TextPart, ToolCall } from '@ai-agent-library/library';

export const THREAD_CHANNELS = {
  list: 'threads:list',
  read: 'threads:read',
  create: 'threads:create',
  send: 'threads:send',
  answer: 'threads:answer',
  stop: 'threads:stop',
  goTo: 'threads:go-to',
  rename: 'threads:rename',
  remove: 'threads:remove',
  event: 'threads:event',
} as const;

/** What a model turn in a stored history is made of. */
export type ModelPart = TextPart | ReasoningPart | ToolCall | NativePart;

/** One message of a thread, and the item it follows; null when it follows nothing. */
export type Item = { id: string; parent: string | null; message: PortableMessage };

/**
 * A thread is a tree of items. `current` is the item it is at: the history on
 * screen, and the history the model is given, is the path to it. Null until
 * something has been said. `title` is taken from the first thing said, and is
 * empty until then.
 */
export type Thread = { id: string; title: string; current: string | null };

/** A whole thread: every item of it, on screen or not, in the order added. */
export type Opened = { thread: Thread; items: readonly Item[] };

export type ThreadEvent =
  /** A piece of the turn that is arriving. Nothing is stored yet. */
  | { type: 'chunk'; thread: string; chunk: ModelPart | End }
  /**
   * The thread as it is now, and the items stored since the last event, which
   * may be none. Whatever was arriving is among them.
   */
  | { type: 'changed'; thread: Thread; added: readonly Item[] }
  /** The thread is gone, with everything in it. */
  | { type: 'removed'; thread: string };

/** How a send went. A model call that fails is an outcome, not an exception. */
export type Sent = { error?: string };

/** The surface exposed on `window.agent.threads` by the preload bridge. */
export type ThreadsApi = {
  /** Every thread, the one most recently added to first. */
  list(): Promise<readonly Thread[]>;
  /** The whole of one thread, or undefined if there is none by that id. */
  read(thread: string): Promise<Opened | undefined>;
  /** A new thread with nothing in it. */
  create(): Promise<Thread>;
  /**
   * Says `text` after the item `after`, or at the very start with null, and
   * has the model answer. Saying a second thing after the same item is a fork:
   * both stay in the thread. Settles when the answer is stored, or has failed.
   */
  send(thread: string, after: string | null, text: string): Promise<Sent>;
  /**
   * Has the model answer what was said in the item `after`, again if it has
   * been answered already: another answer is another fork.
   */
  answer(thread: string, after: string): Promise<Sent>;
  /**
   * Stops the answer on its way in the thread, if there is one. What has
   * arrived of it is kept, as a turn that never ended.
   */
  stop(thread: string): Promise<void>;
  /** Puts the thread at `item`, so the history on screen is the path to it. */
  goTo(thread: string, item: string): Promise<void>;
  /** Names the thread. The name is kept on one line, and cut if it is long. */
  rename(thread: string, title: string): Promise<void>;
  /** Removes the thread and everything in it, for good. An answer on its way in it is stopped. */
  remove(thread: string): Promise<void>;
  /** Hears every thread's events. Returns the way to stop hearing them. */
  subscribe(listener: (event: ThreadEvent) => void): () => void;
};
