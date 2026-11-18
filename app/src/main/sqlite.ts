/**
 * Opening a SQLite file that carries its own schema history. Knows nothing
 * about what any table is for: each feature hands in its own list.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations. Append only, never edit an entry that has
 * shipped; `PRAGMA user_version` records how many have been applied.
 */
export type Migrations = readonly string[];

/**
 * Opens `file` and brings it up to `migrations`. No handle is kept here: the
 * caller owns what this returns, hands it to whatever needs it, and closes it.
 * `':memory:'` gives a test a fresh, migrated database.
 *
 * If it throws, the file is closed first: the caller never got a handle to
 * close.
 */
export const openMigrated = (file: string, migrations: Migrations): DatabaseSync => {
  const db = new DatabaseSync(file);
  try {
    // WAL survives a hard kill far better than the default rollback journal.
    db.exec('PRAGMA journal_mode = WAL');
    const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    migrations.slice(applied).forEach((migration, i) => {
      db.exec('BEGIN');
      try {
        db.exec(migration);
        // PRAGMA takes no bound parameters, hence the interpolation. The value
        // is a count, never user input.
        db.exec(`PRAGMA user_version = ${applied + i + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};
