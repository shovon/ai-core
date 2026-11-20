import type { DatabaseSync } from 'node:sqlite';
import type { Migrations } from '../../sqlite.ts';
import type { Item, Thread } from '../../../shared/threads.ts';
import type { ThreadStore } from './threads.ts';

/**
 * What the thread store keeps in a database it is handed. A thread and an item
 * are each stored whole, as the JSON they already are, so a field added to
 * either needs no migration. The columns beside the JSON are only what is
 * looked up by. `seq` is the order items were added, across every thread: the
 * one sequence there is.
 */
export const THREAD_MIGRATIONS: Migrations = [
  `CREATE TABLE threads (
     id   TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );
   CREATE TABLE items (
     seq    INTEGER PRIMARY KEY AUTOINCREMENT,
     id     TEXT NOT NULL UNIQUE,
     thread TEXT NOT NULL,
     data   TEXT NOT NULL
   );
   CREATE INDEX items_by_thread ON items (thread, seq);`,
];

type Stored = { data: string };

/** Threads kept in a database opened with `THREAD_MIGRATIONS`. The caller owns the handle and closes it. */
export const sqliteStore = (db: DatabaseSync): ThreadStore => {
  const thread = db.prepare('SELECT data FROM threads WHERE id = ?');
  // Rowid breaks the tie between threads with nothing in them: newest made first.
  const threads = db.prepare(
    `SELECT threads.data FROM threads
       LEFT JOIN (SELECT thread, MAX(seq) AS newest FROM items GROUP BY thread) AS added ON added.thread = threads.id
      ORDER BY added.newest DESC NULLS LAST, threads.rowid DESC`,
  );
  const putThread = db.prepare(
    'INSERT INTO threads (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data',
  );
  const removeThread = db.prepare('DELETE FROM threads WHERE id = ?');
  const removeItems = db.prepare('DELETE FROM items WHERE thread = ?');
  const items = db.prepare('SELECT data FROM items WHERE thread = ? ORDER BY seq');
  const inThread = db.prepare('SELECT 1 FROM items WHERE thread = ? AND id = ?');
  const anywhere = db.prepare('SELECT 1 FROM items WHERE id = ?');
  const addItem = db.prepare('INSERT INTO items (id, thread, data) VALUES (?, ?, ?)');

  const parsed = <T>(row: unknown): T => JSON.parse((row as Stored).data) as T;

  return {
    thread: async (id) => {
      const row = thread.get(id);
      return row === undefined ? undefined : parsed<Thread>(row);
    },
    threads: async () => threads.all().map((row) => parsed<Thread>(row)),
    putThread: async (value) => {
      putThread.run(value.id, JSON.stringify(value));
    },
    removeThread: async (id) => {
      // Both or neither: a thread never outlives its items, nor they it.
      db.exec('BEGIN');
      try {
        removeItems.run(id);
        removeThread.run(id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    items: async (id) => items.all(id).map((row) => parsed<Item>(row)),
    addItem: async (id, item) => {
      if (anywhere.get(item.id) !== undefined) throw new Error(`item id already in use: ${item.id}`);
      if (item.parent !== null && inThread.get(id, item.parent) === undefined)
        throw new Error(`no such parent in this thread: ${item.parent}`);
      addItem.run(item.id, id, JSON.stringify(item));
    },
  };
};
