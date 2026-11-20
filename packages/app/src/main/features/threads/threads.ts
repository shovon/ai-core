// What a thread does, written against what it needs: somewhere to keep items,
// a model to ask, a source of ids, and someone to tell. No Electron in here.
import {
  append,
  collect,
  isSchemaError,
  isText,
  isToolCall,
  isToolInput,
  pendingToolCalls,
  toolFailure,
  toolResult,
  user,
  type Output,
  type PortableMessage,
  type Provider,
  type Reply,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
} from "@ai-agent-library/library";
import { path, type Tree } from "@ai-agent-library/tree";
import type {
  Item,
  ModelPart,
  Opened,
  Thread,
  ThreadEvent,
} from "../../../shared/threads.ts";

/**
 * Where threads are kept. Anything that can do these six things will do: a
 * map in memory, a file, a database. What it is given is plain JSON.
 */
export type ThreadStore = {
  thread(id: string): Promise<Thread | undefined>;
  /** Every thread, the one most recently added to first. A thread with no items comes after those with some. */
  threads(): Promise<readonly Thread[]>;
  /** Keeps the thread, in place of any thread with the same id. */
  putThread(thread: Thread): Promise<void>;
  /** Forgets the thread and every item of it. Nothing happens if it is not there. */
  removeThread(id: string): Promise<void>;
  /** The thread's items in the order they were added. None for a thread that is not there. */
  items(thread: string): Promise<Tree<Item>>;
  /**
   * Adds an item to the end of a thread. An item is never changed, and goes
   * only when its thread does. Refuses an id already in use in any thread,
   * and a parent that is not in this one.
   */
  addItem(thread: string, item: Item): Promise<void>;
};

/**
 * Something the model may call while it answers: what the model is told of
 * it, and what a call to it does. The call's input is whatever the model sent,
 * so `run` checks it. What `run` throws is told to the model. The signal is
 * aborted if the answer is stopped.
 */
export type Tool = ToolSpec & {
  run: (call: ToolCall, signal: AbortSignal) => Output | Promise<Output>;
};

export type Ports = {
  store: ThreadStore;
  provider: Provider<PortableMessage, ModelPart>;
  /** What the model may call while it answers. Left out, it can call nothing. */
  tools?: readonly Tool[];
  newId: () => string;
  emit: (event: ThreadEvent) => void;
};

export type Threads = {
  /** Every thread, the one most recently added to first. */
  list(): Promise<readonly Thread[]>;
  /** The whole of one thread, or undefined if there is none by that id. */
  read(thread: string): Promise<Opened | undefined>;
  create(): Promise<Thread>;
  /**
   * Says `text` after the item `after`, or at the very start with null, and
   * has the model answer. There is no separate way to fork: saying something
   * after an item that already has something after it is one. Throws if the
   * model call fails.
   */
  send(thread: string, after: string | null, text: string): Promise<void>;
  /**
   * Has the model answer what was said in the item `after`, which is not a
   * model turn. If it has been answered before, this answer is a fork beside
   * the others. Throws if the model call fails.
   */
  answer(thread: string, after: string): Promise<void>;
  /**
   * Stops the answer on its way in the thread, if there is one. Whatever is
   * waiting on that answer then settles without an error.
   */
  stop(thread: string): Promise<void>;
  /** Puts the thread at `item`. */
  goTo(thread: string, item: string): Promise<void>;
  /** Names the thread. A name with nothing in it is refused. */
  rename(thread: string, title: string): Promise<void>;
  /** Removes the thread and everything in it. An answer on its way in it is stopped first. */
  remove(thread: string): Promise<void>;
};

/** The same stream, with each value shown to `each` as it passes. */
const tap = async function* <T>(
  stream: AsyncIterable<T>,
  each: (value: T) => void,
) {
  for await (const value of stream) {
    each(value);
    yield value;
  }
};

const TITLE_LENGTH = 60;

/** A thread's title, from the first thing said in it: its first line with anything on it, cut to fit a list. */
export const titleOf = (text: string): string => {
  const line = (
    text.split("\n").find((candidate) => candidate.trim() !== "") ?? ""
  )
    .trim()
    .replace(/\s+/g, " ");
  // By code point, so a cut never lands inside one.
  const letters = [...line];
  return letters.length <= TITLE_LENGTH
    ? line
    : `${letters
        .slice(0, TITLE_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
};

/** Whether a turn that was stopped is worth keeping: only if there is something in it to read. */
const readable = (message: PortableMessage) =>
  message.from === "model" && message.content.some(isText);

/**
 * A stopped turn without the calls it made, or the input of one it was still
 * writing. They were never run, and a call left in a history with no result
 * after it cannot be sent to the model again.
 */
const uncalled = (message: PortableMessage): PortableMessage =>
  message.from === "model"
    ? {
        ...message,
        content: message.content.filter(
          (part) => !isToolCall(part) && !isToolInput(part),
        ),
      }
    : message;

/** How many times in one answer the model may call tools and be asked to go on. A stop for a loop that will not end. */
export const TOOL_ROUNDS = 8;

export const createThreads = ({
  store,
  provider,
  tools = [],
  newId,
  emit,
}: Ports): Threads => {
  // The answer on its way in each thread, and how to stop it.
  const answering = new Map<
    string,
    { stop: () => void; done: Promise<void> }
  >();

  /**
   * Does the one thing that may be going on in a thread at a time: the thread
   * can only be in one place. `work` is given a signal that `stop` aborts.
   */
  const alone = async (
    id: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    if (answering.has(id)) throw new Error("this thread is still answering");
    const controller = new AbortController();
    const done = work(controller.signal);
    answering.set(id, { stop: () => controller.abort(), done });
    try {
      await done;
    } finally {
      answering.delete(id);
    }
  };

  const existing = async (id: string): Promise<Thread> => {
    const thread = await store.thread(id);
    if (!thread) throw new Error(`no such thread: ${id}`);
    return thread;
  };

  /** The thread put at `item`, which must be one of its own; nothing is stored. */
  const at = async (thread: Thread, item: string | null): Promise<Thread> => {
    if (
      item !== null &&
      !(await store.items(thread.id)).some((known) => known.id === item)
    )
      throw new Error(`no such item in this thread: ${item}`);
    return { ...thread, current: item };
  };

  /**
   * Adds the messages one after another from where the thread is, and moves
   * the thread to the last. Only where the thread is changes: whatever else
   * is kept of it, such as its name, is read again and left as it is.
   */
  const extend = async (
    thread: Thread,
    messages: readonly PortableMessage[],
  ): Promise<Thread> => {
    const added: Item[] = [];
    let current = thread.current;
    for (const message of messages) {
      const item = { id: newId(), parent: current, message };
      await store.addItem(thread.id, item);
      added.push(item);
      current = item.id;
    }
    const moved = { ...(await existing(thread.id)), current };
    await store.putThread(moved);
    emit({ type: "changed", thread: moved, added });
    return moved;
  };

  const history = async (
    thread: Thread,
  ): Promise<readonly PortableMessage[]> =>
    thread.current === null
      ? []
      : path(await store.items(thread.id), thread.current).map(
          (item) => item.message,
        );

  /**
   * Has the model go on from where the thread is. A turn is stored once it
   * has finished: one that fails part-way leaves nothing behind. A paused turn
   * is not an answer, so it goes back as it is until the model is done.
   *
   * A finished turn may ask for tools. Each call is run, the results are
   * stored after the turn, and the model is asked again with them, until it
   * asks for nothing more. A tool that fails is a result too: the model reads
   * the failure and decides what to do.
   *
   * A turn that was stopped is kept if there is anything in it to read. It is
   * stored without an `end`, which is what it is: a turn that never ended.
   */
  const answer = async (from: Thread, signal: AbortSignal): Promise<void> => {
    let thread = from;
    let rounds = 0;
    for (;;) {
      let arrived: Reply<ModelPart> = [];
      // No tools is said by leaving them out: an empty list is not the same to every provider.
      const request = {
        messages: await history(thread),
        signal,
        ...(tools.length > 0 && { tools }),
      };
      const turn = tap(provider(request), (chunk) => {
        emit({ type: "chunk", thread: from.id, chunk });
        arrived = append(arrived, chunk);
      });
      let reply: Reply<ModelPart>;
      try {
        reply = await collect(turn);
      } catch (error) {
        if (!signal.aborted) throw error;
        // With nothing kept, this still tells the page that nothing is arriving any more.
        await extend(thread, arrived.filter(readable).map(uncalled));
        return;
      }
      thread = await extend(thread, reply);
      const last = reply.at(-1);
      if (last?.from === "model" && last.end === "pause") continue;

      const calls = pendingToolCalls(reply);
      if (calls.length === 0) return;
      // Each call gets a result even when it is not run, so the history can always be sent again.
      const unrun = (why: string) =>
        extend(thread, [
          {
            from: "tool",
            content: calls.map((call) =>
              toolResult(call, why, { error: true }),
            ),
          },
        ]);
      if (rounds++ >= TOOL_ROUNDS) {
        await unrun("Not run: too many rounds of tool calls in one answer.");
        throw new Error(`stopped after ${TOOL_ROUNDS} rounds of tool calls`);
      }
      // What one call comes to. A tool that is not there, input that does not fit and a failure are all
      // told to the model. A call that was stopped is not: it throws, and no result is made up for it.
      // Nor is a schema that cannot be enforced, which is a mistake in the tool and fails the answer.
      const resultOf = async (call: ToolCall): Promise<ToolResult> => {
        try {
          const called = tools.find((tool) => tool.name === call.name);
          if (!called) throw new Error(`unknown tool: ${call.name}`);
          return toolResult(call, await called.run(call, signal));
        } catch (error) {
          if (isSchemaError(error)) throw error;
          signal.throwIfAborted();
          return toolFailure(call, error);
        }
      };
      let results: readonly ToolResult[];
      try {
        results = await Promise.all(calls.map(resultOf));
      } catch (error) {
        if (!signal.aborted) throw error;
        // Stopped while the tools ran.
        await unrun("Stopped before this finished.");
        return;
      }
      thread = await extend(thread, [{ from: "tool", content: results }]);
    }
  };

  return {
    list: () => store.threads(),
    read: async (id) => {
      const thread = await store.thread(id);
      return thread && { thread, items: await store.items(id) };
    },
    create: async () => {
      const thread: Thread = { id: newId(), title: "", current: null };
      await store.putThread(thread);
      return thread;
    },
    send: (id, after, text) =>
      alone(id, async (signal) => {
        const thread = await at(await existing(id), after);
        // Named once, by the first thing said in it.
        if (thread.title === "")
          await store.putThread({ ...thread, title: titleOf(text) });
        await answer(await extend(thread, [user(text)]), signal);
      }),
    answer: (id, after) =>
      alone(id, async (signal) => {
        const thread = await at(await existing(id), after);
        const asked = (await store.items(id)).find((item) => item.id === after);
        // A model turn is an answer, not something to answer.
        if (asked?.message.from === "model")
          throw new Error(`nothing to answer in a model turn: ${after}`);
        await answer(await extend(thread, []), signal);
      }),
    stop: async (id) => {
      answering.get(id)?.stop();
    },
    // Not while an answer is on its way: storing it would move the thread back.
    goTo: (id, item) =>
      alone(id, async () => {
        await extend(await at(await existing(id), item), []);
      }),
    rename: async (id, title) => {
      const named = titleOf(title);
      if (named === "") throw new Error("a thread needs a name");
      const thread = { ...(await existing(id)), title: named };
      await store.putThread(thread);
      emit({ type: "changed", thread, added: [] });
    },
    remove: async (id) => {
      await existing(id);
      // Stop the answer on its way and let it settle, so nothing is added to a thread that is gone.
      const run = answering.get(id);
      run?.stop();
      await run?.done.catch(() => undefined);
      await store.removeThread(id);
      emit({ type: "removed", thread: id });
    },
  };
};
