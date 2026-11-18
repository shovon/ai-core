import { useEffect, useRef, useState } from 'react';
import type { Sent, ThreadsApi } from '../../shared/threads.ts';
import { asked, blank, busy, entries, error, heard, learned, listed, onScreen, selected, settled, UNMADE } from './page.ts';
import { before, landing, prompt, rows } from './shown.ts';

const reason = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** Every thread, kept up to date from the bridge, and the one on screen. */
export const useThreads = (threads: ThreadsApi) => {
  const [page, setPage] = useState(blank);
  // The thread last asked for, so a slow read never puts an older choice on screen.
  const wanted = useRef<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const stop = threads.subscribe((event) => setPage((known) => heard(known, event)));
    void threads.list().then((list) => {
      if (live) setPage((known) => listed(known, list));
    });
    return () => {
      live = false;
      stop();
    };
  }, [threads]);

  /** Asks something of a thread that the model answers, and keeps the page told how it went. */
  const ask = async (id: string, call: () => Promise<Sent>) => {
    setPage((known) => asked(known, id));
    try {
      const sent = await call();
      setPage((known) => settled(known, id, sent.error));
    } catch (failure) {
      setPage((known) => settled(known, id, reason(failure)));
    }
  };

  /** Does something to a thread that the model has no part in. A failure shows on the thread on screen. */
  const tell = async (call: () => Promise<void>) => {
    try {
      await call();
    } catch (failure) {
      setPage((known) => settled(known, known.open ?? UNMADE, reason(failure)));
    }
  };

  /** Says `text` after the item `after`; left out, after where the thread on screen is. */
  const say = async (text: string, after?: string | null) => {
    const at = after === undefined ? (onScreen(page).thread?.current ?? null) : after;
    if (page.open !== undefined) return ask(page.open, () => threads.send(page.open as string, at, text));
    try {
      // A thread is made when something is first said in it.
      const thread = await threads.create();
      wanted.current = thread.id;
      setPage((known) => selected(learned(known, { thread, items: [] }), thread.id));
      await ask(thread.id, () => threads.send(thread.id, at, text));
    } catch (failure) {
      setPage((known) => settled(known, UNMADE, reason(failure)));
    }
  };

  return {
    entries: entries(page),
    open: page.open,
    rows: rows(onScreen(page)),
    busy: busy(page),
    error: error(page),
    send: (text: string) => say(text),
    /** A new version of the item: the same place in the thread, said differently. */
    edit: (id: string, text: string) => say(text, before(onScreen(page), id)),
    /** Another answer to what the item answers; for something the user said, an answer to that. */
    retry: async (id: string) => {
      const thread = page.open;
      if (thread !== undefined) await ask(thread, () => threads.answer(thread, prompt(onScreen(page), id)));
    },
    /** Stops the answer on its way in the thread on screen. */
    stop: async () => {
      const thread = page.open;
      if (thread !== undefined) await tell(() => threads.stop(thread));
    },
    /** Shows a version of an item, where it was last worked on. */
    show: async (id: string) => {
      const thread = page.open;
      if (thread !== undefined) await tell(() => threads.goTo(thread, landing(onScreen(page), id)));
    },
    /** Puts a thread on screen, reading it from main the first time. */
    select: (id: string) => {
      wanted.current = id;
      return tell(async () => {
        if (!page.known[id]) {
          const opened = await threads.read(id);
          if (opened) setPage((known) => learned(known, opened));
        }
        if (wanted.current === id) setPage((known) => selected(known, id));
      });
    },
    /** Shows a new thread. Nothing is made until something is said. */
    startNew: () => {
      wanted.current = undefined;
      setPage((known) => selected(known, undefined));
    },
    rename: (id: string, title: string) => tell(() => threads.rename(id, title)),
    /** Removes a thread for good. The page follows when main says it is gone. */
    remove: (id: string) => tell(() => threads.remove(id)),
  };
};
