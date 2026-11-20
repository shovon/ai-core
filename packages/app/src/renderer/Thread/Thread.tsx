import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, SubmitEvent } from 'react';
import { isReasoning, isText, isToolCall, isToolInput, type AnyMessage, type Part, type ToolCall, type ToolResult } from '@ai-idioms/core';
import Markdown from '../Markdown/Markdown.tsx';

/** One message on screen. */
export type Row = {
  /** A model message with no `end` is still arriving, or if it is stored, was stopped. */
  message: AnyMessage;
  /** What the message is stored as; left out while it is arriving. */
  id?: string;
  /** Every version of it by id, this one among them, oldest first. */
  versions?: readonly string[];
};

type Props = {
  /** The history on screen, oldest first. */
  rows: readonly Row[];
  /** An answer is on its way, so nothing can be said or shown differently yet. It can be stopped. */
  busy: boolean;
  /** Why the last thing asked for failed, as it should be shown. */
  error?: string;
  onSend: (text: string) => void;
  /** Says `text` in place of the message stored as `id`, as a new version of it. */
  onEdit: (id: string, text: string) => void;
  /** Has what the message stored as `id` answers answered again; for something the user said, has that answered. */
  onRetry: (id: string) => void;
  /** Stops the answer on its way. */
  onStop: () => void;
  /** Shows the version stored as `id`. */
  onShow: (id: string) => void;
};

type Acts = Pick<Props, 'busy' | 'onEdit' | 'onRetry' | 'onShow'>;

const textOf = (message: AnyMessage) => {
  const parts: readonly Part[] = message.content;
  return parts
    .filter(isText)
    .map((part) => part.text)
    .join('');
};

/** What to say of a model turn that did not simply finish. */
const ending = ({ message, id }: Row) => {
  if (message.from !== 'model') return undefined;
  // No `end`: still arriving, unless it is stored, in which case it never will.
  if (message.end === undefined) return id === undefined ? undefined : 'Stopped';
  return message.end === 'stop' || message.end === 'pause' ? undefined : `Stopped early: ${message.end}`;
};

/**
 * Whether a part of a model turn has anything to show. `active` is when it is
 * the newest part of a turn still arriving: reasoning then shows even with
 * nothing in it yet, because that the model is working is itself worth showing.
 * Native parts are a provider's own, and a kind not known here is not this
 * view's to draw.
 */
const shows = (part: Part, active: boolean) => {
  if (isText(part)) return part.text !== '';
  if (isReasoning(part)) return active || part.text.trim() !== '';
  // A call still being written shows only while it is: the call itself takes its place.
  if (isToolInput(part)) return active;
  return isToolCall(part);
};

/** The result of each tool call on screen, by the call's id. */
type Results = ReadonlyMap<string, ToolResult>;

/** What a tool was asked, in a few words: its one piece of text if that is all it was given, or its input as written. */
const brief = (input: unknown) => {
  const values: unknown[] = typeof input === 'object' && input !== null ? Object.values(input) : [];
  const [only] = values;
  const said = values.length === 1 && typeof only === 'string' ? only : (JSON.stringify(input) ?? '');
  return said.length > 120 ? `${said.slice(0, 119)}…` : said;
};

/** What the model is doing while an answer is on its way: thinking, until there is something else to show. */
const doing = (rows: readonly Row[]) => {
  const newest = rows.at(-1);
  const parts: readonly Part[] = newest?.message.content ?? [];
  const part = parts.at(-1);
  return newest?.id === undefined && part !== undefined && isReasoning(part) ? 'Thinking…' : 'Answering…';
};

/** Enter sends; Shift+Enter is a new line. Not while an input method is composing. */
const sends = (event: KeyboardEvent<HTMLTextAreaElement>) =>
  event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing;

const quiet = 'text-xs text-neutral-500 dark:text-neutral-400';
const plain = 'rounded px-1 hover:text-neutral-900 disabled:opacity-40 disabled:hover:text-inherit dark:hover:text-neutral-100';
const filled = 'rounded-xl bg-neutral-900 px-3 py-1.5 font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900';

/** Steps through the versions of a message. */
const Pager = ({ id, versions, busy, onShow }: { id: string; versions: readonly string[]; busy: boolean; onShow: (id: string) => void }) => {
  const at = versions.indexOf(id);
  const earlier = versions[at - 1];
  const later = versions[at + 1];
  return (
    <span className="flex items-center gap-1">
      <button type="button" aria-label="Previous version" className={plain} disabled={busy || earlier === undefined} onClick={() => earlier !== undefined && onShow(earlier)}>
        ‹
      </button>
      <span aria-label={`Version ${at + 1} of ${versions.length}`} className="tabular-nums">
        {at + 1} / {versions.length}
      </span>
      <button type="button" aria-label="Next version" className={plain} disabled={busy || later === undefined} onClick={() => later !== undefined && onShow(later)}>
        ›
      </button>
    </span>
  );
};

/** What can be done with a stored message: step through its versions, then whatever its kind allows. */
const Actions = ({ row, busy, onShow, children }: { row: Row; children: React.ReactNode } & Pick<Acts, 'busy' | 'onShow'>) =>
  row.id === undefined ? null : (
    <div className={`flex items-center gap-2 ${quiet}`}>
      {(row.versions?.length ?? 0) > 1 && <Pager id={row.id} versions={row.versions ?? []} busy={busy} onShow={onShow} />}
      {children}
    </div>
  );

/**
 * What the user said. Editing it says something else in its place, and keeps
 * both. `unanswered` is when nothing follows it: it can then be answered.
 */
const Said = ({ row, text, unanswered, busy, onEdit, onRetry, onShow }: { row: Row; text: string; unanswered: boolean } & Acts) => {
  // Undefined when the message is not being edited.
  const [draft, setDraft] = useState<string>();
  const { id } = row;

  if (draft !== undefined && id !== undefined) {
    const ready = !busy && draft.trim() !== '';
    const save = () => {
      if (!ready) return;
      onEdit(id, draft);
      setDraft(undefined);
    };
    return (
      <li className="ml-auto w-full max-w-[80%]">
        <form
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            save();
          }}
          className="rounded-2xl border border-neutral-300 p-2 focus-within:border-neutral-500 dark:border-neutral-700 dark:focus-within:border-neutral-400"
        >
          <textarea
            aria-label="Edit message"
            autoFocus
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraft(undefined);
              if (!sends(event)) return;
              event.preventDefault();
              save();
            }}
            className="w-full resize-none bg-transparent px-2 py-1 outline-none"
          />
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="rounded-xl px-3 py-1.5" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button type="submit" disabled={!ready} className={filled}>
              Save
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
      <p className="rounded-2xl bg-neutral-100 px-4 py-2 whitespace-pre-wrap dark:bg-neutral-800">{text}</p>
      <Actions row={row} busy={busy} onShow={onShow}>
        {unanswered && id !== undefined && (
          <button type="button" className={plain} disabled={busy} onClick={() => onRetry(id)}>
            Retry
          </button>
        )}
        <button type="button" className={plain} disabled={busy} onClick={() => setDraft(text)}>
          Edit
        </button>
      </Actions>
    </li>
  );
};

/**
 * The model's own account of its working. Open while it goes on, so there is
 * something to read during the wait; folded away once the answer begins.
 */
const Reasoning = ({ text, active }: { text: string; active: boolean }) =>
  text.trim() === '' ? (
    <p className={quiet}>Thinking…</p>
  ) : (
    <details open={active} className={quiet}>
      <summary className="cursor-pointer select-none hover:text-neutral-900 dark:hover:text-neutral-100">
        {active ? 'Thinking…' : 'Thought process'}
      </summary>
      <div className="mt-1 border-l-2 border-neutral-200 pl-3 dark:border-neutral-800">
        <Markdown text={text} />
      </div>
    </details>
  );

/**
 * A tool the model called: what it asked for, and once it is back, what came
 * of it, folded away. With no result yet it is running, or if nothing is on
 * its way any more, it never ran.
 */
const Called = ({ call, result, busy }: { call: ToolCall; result: ToolResult | undefined; busy: boolean }) => {
  const what = `${call.name.replaceAll('_', ' ')}: ${brief(call.input)}`;
  if (!result) return <p className={quiet}>{busy ? `Running ${what}…` : `Did not run ${what}`}</p>;
  const parts: readonly Part[] = result.content;
  return (
    <details className={quiet}>
      <summary className="cursor-pointer select-none hover:text-neutral-900 dark:hover:text-neutral-100">
        {result.error ? 'Failed' : 'Used'} {what}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto border-l-2 border-neutral-200 pl-3 font-sans whitespace-pre-wrap dark:border-neutral-800">
        {parts
          .filter(isText)
          .map((part) => part.text)
          .join('')}
      </pre>
    </details>
  );
};

/** One part of a model turn, by its kind. */
const PartView = ({ part, active, busy, results }: { part: Part; active: boolean; busy: boolean; results: Results }) => {
  if (!shows(part, active)) return null;
  if (isText(part)) return <Markdown text={part.text} />;
  if (isReasoning(part)) return <Reasoning text={part.text} active={active} />;
  if (isToolInput(part)) return <p className={quiet}>Calling {part.name.replaceAll('_', ' ')}…</p>;
  if (isToolCall(part)) return <Called call={part} result={results.get(part.id)} busy={busy} />;
  return null;
};

const Message = ({ row, unanswered, results, ...acts }: { row: Row; unanswered: boolean; results: Results } & Acts) => {
  const { message, id } = row;
  const note = ending(row);
  if (message.from === 'user') {
    const text = textOf(message);
    return text === '' ? null : <Said row={row} text={text} unanswered={unanswered} {...acts} />;
  }
  const parts: readonly Part[] = message.content;
  // Still arriving: not stored yet, and not ended.
  const arriving = id === undefined && message.from === 'model' && message.end === undefined;
  const active = (i: number) => arriving && i === parts.length - 1;
  // Tool results, and turns that hold only what the model keeps to itself.
  if (!note && !parts.some((part, i) => shows(part, active(i)))) return null;
  return (
    <li className="flex flex-col gap-2">
      {parts.map((part, i) => (
        // A turn's parts only ever grow at the end, so a place in it is a stable key.
        <PartView key={i} part={part} active={active(i)} busy={acts.busy} results={results} />
      ))}
      {note && <p className={quiet}>{note}</p>}
      <Actions row={row} busy={acts.busy} onShow={acts.onShow}>
        {/* Not on a turn that only asked for tools: the answer is the turn after their results. */}
        {id !== undefined && !parts.some(isToolCall) && (
          <button type="button" className={plain} disabled={acts.busy} onClick={() => acts.onRetry(id)}>
            Retry
          </button>
        )}
      </Actions>
    </li>
  );
};

const Thread = ({ rows, busy, error, onSend, onEdit, onRetry, onStop, onShow }: Props) => {
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // Keep the newest of it in view as it grows. In a block, so the effect
  // returns nothing: newer Chromium has `scrollIntoView` return a promise,
  // which React would take for a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [rows]);

  // A tool's result is stored after the turn that called it; each call is shown with its own.
  const results: Results = new Map(
    rows.flatMap(({ message }) => (message.from === 'tool' ? message.content.map((result) => [result.id, result] as const) : [])),
  );

  const ready = !busy && draft.trim() !== '';
  const send = () => {
    if (!ready) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-white font-sans text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="grid h-full place-items-center text-neutral-500 dark:text-neutral-400">
            Say something to start a thread.
          </p>
        ) : (
          <ol className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
            {rows.map((row, i) => (
              // A stored message by what it is stored as, so one version's
              // state never carries over to another. One still arriving has
              // only its place, which holds: the list grows at its end.
              <Message
                key={row.id ?? `arriving ${i}`}
                row={row}
                unanswered={!busy && i === rows.length - 1}
                results={results}
                busy={busy}
                onEdit={onEdit}
                onRetry={onRetry}
                onShow={onShow}
              />
            ))}
          </ol>
        )}
        <div ref={end} />
      </div>

      <div className="mx-auto w-full max-w-2xl px-4 pb-4">
        <p role="status" className={`min-h-5 pb-1 ${quiet}`}>
          {busy ? doing(rows) : ''}
        </p>
        {error !== undefined && (
          <p role="alert" className="pb-2 text-xs text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <form
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            send();
          }}
          className="flex items-end gap-2 rounded-2xl border border-neutral-300 p-2 focus-within:border-neutral-500 dark:border-neutral-700 dark:focus-within:border-neutral-400"
        >
          <textarea
            aria-label="Message"
            placeholder="Message"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (!sends(event)) return;
              event.preventDefault();
              send();
            }}
            className="flex-1 resize-none bg-transparent px-2 py-1 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
          />
          {busy ? (
            // In Send's place while there is something to stop. What is typed meanwhile stays for after.
            <button type="button" onClick={onStop} className={filled}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!ready} className={filled}>
              Send
            </button>
          )}
        </form>
      </div>
    </main>
  );
};

export default Thread;
