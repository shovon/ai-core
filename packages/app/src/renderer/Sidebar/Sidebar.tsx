import { useState } from 'react';

/** One thread in the list. */
export type Entry = {
  id: string;
  /** Empty for a thread nothing has been said in. */
  title: string;
  /** An answer is on its way in it. */
  answering: boolean;
};

type Props = {
  /** Every thread, in the order to list them. */
  entries: readonly Entry[];
  /** The thread on screen; undefined when it is a new one. */
  open: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  /** Removes the thread for good. Only called once the user has said so twice. */
  onRemove: (id: string) => void;
};

const marked = 'aria-[current]:bg-neutral-200 dark:aria-[current]:bg-neutral-800';
const hover = 'hover:bg-neutral-100 dark:hover:bg-neutral-900';
const small = 'rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100';

const Listed = ({ entry, current, onSelect, onRename, onRemove }: { entry: Entry; current: boolean } & Pick<Props, 'onSelect' | 'onRename' | 'onRemove'>) => {
  // What is being done to the entry, if anything: a new name being typed, or a removal waiting to be confirmed.
  const [doing, setDoing] = useState<{ renaming: string } | 'removing'>();
  const name = entry.title === '' ? 'New thread' : entry.title;

  if (doing === 'removing')
    return (
      <li className="flex items-center gap-1 rounded-lg bg-neutral-100 px-3 py-1.5 dark:bg-neutral-900">
        <span className="min-w-0 flex-1 truncate">Delete “{name}”?</span>
        <button type="button" autoFocus className={`${small} font-medium text-red-700 dark:text-red-400`} onClick={() => onRemove(entry.id)}>
          Delete
        </button>
        <button type="button" className={small} onClick={() => setDoing(undefined)}>
          Cancel
        </button>
      </li>
    );

  if (doing)
    return (
      <li>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            // The same name, or none, is no rename.
            const title = doing.renaming.trim();
            if (title !== '' && title !== entry.title) onRename(entry.id, title);
            setDoing(undefined);
          }}
        >
          <input
            aria-label="Thread name"
            autoFocus
            value={doing.renaming}
            onChange={(event) => setDoing({ renaming: event.target.value })}
            onFocus={(event) => event.target.select()}
            onBlur={() => setDoing(undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDoing(undefined);
            }}
            className="w-full rounded-lg border border-neutral-400 bg-white px-3 py-1.5 outline-none dark:border-neutral-600 dark:bg-neutral-900"
          />
        </form>
      </li>
    );

  return (
    // The two small buttons show when the pointer or the keyboard is on the entry.
    <li className="group relative">
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        aria-current={current ? 'page' : undefined}
        title={name}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left ${hover} ${marked}`}
      >
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {entry.answering && (
          <span role="img" aria-label="Answering" className="size-2 shrink-0 animate-pulse rounded-full bg-neutral-500 dark:bg-neutral-400" />
        )}
      </button>
      <span className="absolute inset-y-0 right-1 hidden items-center gap-0.5 rounded-lg bg-neutral-100 pl-1 group-focus-within:flex group-hover:flex dark:bg-neutral-900">
        <button type="button" aria-label={`Rename “${name}”`} className={small} onClick={() => setDoing({ renaming: entry.title })}>
          Rename
        </button>
        <button type="button" aria-label={`Delete “${name}”`} className={small} onClick={() => setDoing('removing')}>
          Delete
        </button>
      </span>
    </li>
  );
};

const Sidebar = ({ entries, open, onSelect, onNew, onRename, onRemove }: Props) => (
  <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 font-sans text-sm text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
    <div className="p-2">
      <button
        type="button"
        onClick={onNew}
        aria-current={open === undefined ? 'page' : undefined}
        className={`w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-left font-medium dark:border-neutral-700 ${hover} ${marked}`}
      >
        New thread
      </button>
    </div>
    <nav aria-label="Threads" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {entries.length === 0 ? (
        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">No threads yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <Listed key={entry.id} entry={entry} current={entry.id === open} onSelect={onSelect} onRename={onRename} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </nav>
  </aside>
);

export default Sidebar;
