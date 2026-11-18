// No dependencies. Everything here is plain values and functions.

// ── Parts: the least a workflow and a UI have to agree on ───────────────────

export type Part = { readonly type: string }; // every part is a subtype of this
export type TextPart = { type: "text"; text: string };
/**
 * What the model says of its own working, as it works. It is for showing,
 * never for sending: what a provider needs back to continue a turn travels as
 * that provider's own NativePart. Taking every reasoning part out of a
 * history changes nothing that any provider sends.
 *
 * One with no text yet says only that the model has started working.
 */
export type ReasoningPart = { type: "reasoning"; text: string };
/**
 * A file, inline or by link. `data` is the bytes in standard base64 (RFC 4648,
 * with padding); `url` is where to fetch them. Both are strings, so a file
 * part is plain JSON like every other part.
 */
export type FilePart =
  | { type: "file"; mediaType: string; data: string }
  | { type: "file"; mediaType: string; url: string };
export type ToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResult = {
  type: "tool_result";
  id: string;
  content: readonly (TextPart | FilePart)[];
  error?: boolean;
};
/**
 * Something only one provider understands, such as its reasoning state. It
 * carries that provider's name, so every other provider can tell it apart.
 */
export type NativePart<Name extends string = string, Value = unknown> = {
  type: "native";
  provider: Name;
  value: Value;
};
/**
 * Why a model turn ended.
 * - stop: the model finished its turn, which may hold tool calls.
 * - length: it was cut off by a limit.
 * - refusal: it declined.
 * - pause: it is not finished and nothing is wrong; send the history back to continue.
 * - unknown: the provider gave a reason this library has no name for.
 * Only `stop` means the turn is complete.
 */
export type Reason = "stop" | "length" | "refusal" | "pause" | "unknown";

/** The tokens one model turn consumed, as the provider counted them. */
export type Usage = {
  /** Every token the model read, including those read from or written to a cache. */
  input: number;
  /** Every token the model wrote, including any reasoning. */
  output: number;
  /** Of `input`, the tokens read from a cache. */
  cacheRead?: number;
  /** Of `input`, the tokens written to a cache. */
  cacheWrite?: number;
};

export type End = { type: "end"; reason: Reason; usage?: Usage };

// ── History: who a message is from decides what it may contain ──────────────
//
// A history is plain data: strings, numbers, booleans, arrays and objects, as
// long as tool inputs and native values are, which is how providers produce
// them. JSON.stringify followed by JSON.parse gives back an equal history, and
// that is the way to store one. Nothing in it needs this library to be read.
//
// The shape grows only by adding fields and part types. A reader skips fields
// it does not know and rejects part types it does not know.

export type UserMessage<P extends Part> = {
  from: "user";
  content: readonly P[];
};
/**
 * `end` is why the turn finished; it is absent while the turn is still arriving.
 * `usage` is what the turn cost, when the provider reported it.
 */
export type ModelMessage<P extends Part> = {
  from: "model";
  content: readonly P[];
  end?: Reason;
  usage?: Usage;
};
export type ToolMessage = { from: "tool"; content: readonly ToolResult[] };

export type Message<User extends Part, Model extends Part> =
  | UserMessage<User>
  | ModelMessage<Model>
  | ToolMessage;
export type AnyMessage = Message<Part, Part>;

/**
 * A history that can be handed to any provider: the shared parts, plus any
 * provider's native parts inside model turns.
 */
export type PortableMessage = Message<
  TextPart | FilePart,
  TextPart | ReasoningPart | ToolCall | NativePart
>;

/** What one call produced: the messages to add to the history, in order. */
export type Reply<Out extends Part> = readonly (
  | ModelMessage<Out>
  | ToolMessage
)[];

export type ToolSpec = { name: string; description: string; schema: object };
/** What an answer must be: JSON that fits this schema. `shape()` makes one that also reads the answer. */
export type ShapeSpec = { schema: object };
export type Request<M extends AnyMessage, S extends TextPart = TextPart> = {
  /**
   * Standing instructions for this call: one string, or text parts in order.
   * Parts concatenate exactly: a list means the same as its texts joined with
   * nothing between them, so any separator belongs in the text. Splitting a
   * prompt into parts, for instance to put a hint on one, never changes it.
   */
  system?: string | readonly S[];
  messages: readonly M[];
  /** What the model may call. An empty list means the same as leaving it out: the model can call nothing. */
  tools?: readonly ToolSpec[];
  /**
   * Asks for the final answer as JSON that fits a schema. The answer still
   * arrives as text, for `shape().parse` to read. A provider that cannot ask
   * for this schema throws; one that does not know the field ignores it.
   */
  shape?: ShapeSpec;
  /** Cancels the call. The stream then throws. Give the same signal to `runToolCall()` to cancel running tools. */
  signal?: AbortSignal;
};

// ── The one port ────────────────────────────────────────────────────────────
// Accepts messages of type In. Emits one or more turns: a turn is the model's
// parts followed by one End. Text and reasoning arrive in pieces; every other
// part is emitted whole.
//
// Anything provider-specific travels as a NativePart carrying the provider's
// name. A provider sends its own native parts back to its API and leaves out
// everyone else's, so one history can pass between providers without losing
// what each of them needs.
//
// A shared part may carry extra fields meant for one provider, such as a
// caching hint. A provider builds what it sends from the fields it knows and
// ignores the rest; it never forwards a part whole.
//
// A tool call's id is whatever the provider that made the call chose, and it
// must be unique within a history. Providers disagree about what an id may
// look like, so a provider rewrites the ids it cannot accept on the way out
// (fitToolIds). The history keeps the originals.
//
// A history may hold a tool call that was never answered: its turn was cut
// off, or stopped, or the call was simply not run. A provider that needs every
// call answered gives such a call a result on the way out (answerToolCalls). The
// history keeps what happened.
//
// A request may ask for the answer in a shape. Each API takes a schema in its
// own dialect, so a provider fits the schema on the way out (fitSchema). It may
// send a looser one, dropping a bound its API cannot enforce and saying it in
// the description instead, or a tighter one, closing an object its API needs
// closed. It never sends one whose answers would have to be rewritten on the
// way back: what is read is what the model wrote, checked against the schema
// as it was given. A schema it cannot fit that way, it refuses by throwing.

/** Anything with a provider's shape, whatever request it takes. */
export type Takes<R, Out extends Part> = (
  request: R,
) => AsyncIterable<Out | End>;

export type Provider<In extends AnyMessage, Out extends Part> = Takes<
  Request<In>,
  Out
>;

// ── Narrowing and building ──────────────────────────────────────────────────

export const isText = (part: Part): part is TextPart => part.type === "text";
export const isReasoning = (part: Part): part is ReasoningPart =>
  part.type === "reasoning";
export const isToolCall = (part: Part): part is ToolCall =>
  part.type === "tool_call";
export const isToolResult = (part: Part): part is ToolResult =>
  part.type === "tool_result";
export const isEnd = (part: Part): part is End => part.type === "end";

const textPart = (text: string): TextPart => ({ type: "text", text });

export const user = <const C extends readonly (string | Part)[]>(
  ...content: C
): UserMessage<Exclude<C[number], string> | TextPart> => ({
  from: "user",
  content: content.map((c: string | Part) =>
    typeof c === "string" ? textPart(c) : (c as Exclude<C[number], string>),
  ),
});

/** Standard base64 with padding, built without Node's Buffer so it runs anywhere. */
const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  // In slices, because one call cannot take a large file's bytes as arguments.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** A file part from bytes or from a link. Bytes are kept as base64, so the part stays plain JSON. */
export const file = (mediaType: string, from: Uint8Array | URL): FilePart =>
  from instanceof URL
    ? { type: "file", mediaType, url: from.href }
    : { type: "file", mediaType, data: base64(from) };

/** What a tool gives back: text, or text and files in order. */
export type Output = string | readonly (TextPart | FilePart)[];

/** The result of a call. `error` marks it as a failure, for the model to read and act on. */
export const toolResult = (
  call: ToolCall,
  output: Output,
  { error = false }: { error?: boolean } = {},
): ToolResult => ({
  type: "tool_result",
  id: call.id,
  content: typeof output === "string" ? [textPart(output)] : output,
  ...(error && { error }),
});

// ── Folding a stream into messages ──────────────────────────────────────────

// The parts that arrive in pieces. A piece joins the part before it when that
// is of the same kind; text never joins reasoning, nor reasoning text.
const inPieces = (part: Part): part is TextPart | ReasoningPart =>
  isText(part) || isReasoning(part);

const join = <P extends Part>(parts: readonly P[], part: P): readonly P[] => {
  const last = parts.at(-1);
  return last && inPieces(last) && inPieces(part) && last.type === part.type
    ? [...parts.slice(0, -1), { ...last, text: last.text + part.text }]
    : [...parts, part];
};

/**
 * Add one chunk to a reply. Pure: returns a new reply.
 * A model part joins the turn still arriving, or starts a new one. An End
 * finishes that turn. A tool result joins the tool message in progress.
 */
export const append = <Out extends Part>(
  reply: Reply<Out>,
  chunk: Out | ToolResult | End,
): Reply<Out> => {
  const last = reply.at(-1);
  const rest = reply.slice(0, -1);
  if (isToolResult(chunk))
    return last?.from === "tool"
      ? [...rest, { from: "tool", content: [...last.content, chunk] }]
      : [...reply, { from: "tool", content: [chunk] }];
  const arriving = last?.from === "model" && !last.end ? last : undefined;
  if (isEnd(chunk))
    return arriving
      ? [
          ...rest,
          {
            ...arriving,
            end: chunk.reason,
            ...(chunk.usage && { usage: chunk.usage }),
          },
        ]
      : [
          ...reply,
          {
            from: "model",
            content: [],
            end: chunk.reason,
            ...(chunk.usage && { usage: chunk.usage }),
          },
        ];
  return arriving
    ? [...rest, { ...arriving, content: join(arriving.content, chunk) }]
    : [...reply, { from: "model", content: [chunk] }];
};

/** Every message a stream produced. Throws if it stops in the middle of a turn. */
export const collect = async <Out extends Part>(
  stream: AsyncIterable<Out | ToolResult | End>,
): Promise<Reply<Out>> => {
  let reply: Reply<Out> = [];
  for await (const chunk of stream) reply = append(reply, chunk);
  const last = reply.at(-1);
  if (!last || (last.from === "model" && !last.end))
    throw new Error("stream finished without an end chunk");
  return reply;
};

const isPaused = (message: AnyMessage | undefined) =>
  message?.from === "model" && message.end === "pause";

/** The text of the final answer. Throws unless the last message is a finished model turn. */
export const text = async (stream: AsyncIterable<Part>): Promise<string> => {
  const reply = await collect(stream);
  const last = reply.at(-1);
  if (last?.from !== "model")
    throw new Error("no final answer: the reply ended on tool results");
  if (last.end !== "stop") throw new Error(`model stopped early: ${last.end}`);
  // A paused turn and the turns that continue it are one answer.
  let first = reply.length - 1;
  while (isPaused(reply[first - 1])) first--;
  const parts = reply
    .slice(first)
    .flatMap((message): readonly Part[] => message.content);
  return parts
    .filter(isText)
    .map((part) => part.text)
    .join("");
};

/** What the model turns in a history cost, added up. A turn with no usage counts as nothing. */
export const totalUsage = (messages: readonly AnyMessage[]): Required<Usage> =>
  messages.reduce(
    (sum, message) => {
      const {
        input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
      } = (message.from === "model" && message.usage) || {};
      return {
        input: sum.input + input,
        output: sum.output + output,
        cacheRead: sum.cacheRead + cacheRead,
        cacheWrite: sum.cacheWrite + cacheWrite,
      };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );

// ── For provider authors: ids another provider issued ──────────────────────

/**
 * A copy of the history in which every tool-call id satisfies `fits`. An id
 * that does not is replaced by one from `fresh`, the same one in the call and
 * in its result. Ids that already fit are kept, and a history that needs no
 * change is returned as is.
 *
 * The replacement for an id depends only on the messages before it, so the
 * same history always produces the same output, however much is added later.
 *
 * `fresh(n)` must return a fitting id, and a different one for each n.
 */
export const fitToolIds = <M extends AnyMessage>(
  messages: readonly M[],
  fits: (id: string) => boolean,
  fresh: (n: number) => string,
): readonly M[] => {
  const sent = new Map<string, string>(); // id in the history -> id to send
  const taken = new Set<string>();
  let n = 0;
  const fit = (id: string): string => {
    let to = sent.get(id);
    if (to === undefined) {
      to = id;
      for (let tries = 0; !fits(to) || taken.has(to); tries++) {
        if (tries > taken.size + 1)
          throw new Error(
            "fitToolIds: fresh() must return distinct ids that fit",
          );
        to = fresh(n++);
      }
      sent.set(id, to);
      taken.add(to);
    }
    return to;
  };
  const refit = (part: Part): Part => {
    if (!isToolCall(part) && !isToolResult(part)) return part;
    const refitted: ToolCall | ToolResult = { ...part, id: fit(part.id) };
    return refitted.id === part.id ? part : refitted;
  };
  const fitted = messages.map((message) => {
    const content: readonly Part[] = message.content.map(refit);
    // Only id strings were replaced, so the message is still an M.
    return content.some((part, i) => part !== message.content[i])
      ? ({ ...message, content } as M)
      : message;
  });
  return fitted.some((message, i) => message !== messages[i])
    ? fitted
    : messages;
};

// ── For provider authors: calls that were never answered ───────────────────

/**
 * A copy of the history in which every tool call has a result. A call with
 * none is given `missing(call)`, which must be a result for that call. It goes
 * directly after the call's turn: into the tool message there, or into a new
 * one. A history that needs no change is returned as is.
 *
 * A result counts only in the tool message directly after the turn, which is
 * where a provider looks for it. Nothing is ever taken out or changed, and a
 * history already put right comes back unchanged.
 */
export const answerToolCalls = <M extends AnyMessage>(
  messages: readonly M[],
  missing: (call: ToolCall) => ToolResult,
): readonly (M | ToolMessage)[] => {
  // The results a turn's calls are still owed, given the results that follow it.
  const owed = (
    turn: AnyMessage | undefined,
    results: readonly ToolResult[] = [],
  ): ToolResult[] => {
    if (turn?.from !== "model") return [];
    const answered = new Set(results.map((given) => given.id));
    return turn.content
      .filter(isToolCall)
      .filter((call) => !answered.has(call.id))
      .map(missing);
  };
  const put = messages.flatMap((message, i): (M | ToolMessage)[] => {
    const said: AnyMessage = message;
    if (said.from === "tool") {
      const added = owed(messages[i - 1], said.content);
      // Only tool results were added, so the message is still an M.
      return added.length > 0
        ? [{ ...message, content: [...said.content, ...added] } as M]
        : [message];
    }
    const added = messages[i + 1]?.from === "tool" ? [] : owed(said);
    return added.length > 0
      ? [message, { from: "tool", content: added }]
      : [message];
  });
  return put.length === messages.length &&
    put.every((message, i) => message === messages[i])
    ? messages
    : put;
};

// ── Sugar: prompt with a bare string ────────────────────────────────────────

// The provider must accept a plain text user message, whatever else it accepts.
// The result takes the provider's own request type, R, so nothing it declares is lost.
export const model =
  <R extends Request<AnyMessage>, Out extends Part>(
    provider: Takes<R, Out> & Provider<UserMessage<TextPart>, Out>,
  ) =>
  (input: string | R): AsyncIterable<Out | End> =>
    typeof input === "string"
      ? provider({ messages: [user(input)] })
      : provider(input);

// ── Tools: pieces for your own loop ─────────────────────────────────────────
//
// There is no loop here. A loop is the same call made again with a longer
// history, so it is a few lines of your own:
//
//   for (;;) {
//     messages.push(...(await collect(provider({ messages, tools }))));
//     const last = messages.at(-1);
//     if (last?.from === "model" && last.end === "pause") continue;
//     const calls = pendingToolCalls(messages);
//     if (calls.length === 0) break;
//     messages.push({ from: "tool", content: await Promise.all(calls.map((call) => runToolCall(tools, call))) });
//   }
//
// A paused turn is not an answer and asks for nothing: it goes back as it is.
// A turn that was cut off may hold calls, the last of them perhaps half
// written. They are not pending and are never run; the provider answers them
// itself when the history is next sent. Logging a tool's failure, or letting
// a mistake in its code stop the loop, is `runToolCall` written out with
// `attemptToolCall`, `toolResult` and `toolFailure`. Running calls one at a
// time, asking before one runs, and stopping after so many turns are all
// changes to those lines.

export type ToolContext = { signal?: AbortSignal };
/** `input` is whatever the model sent. It is unchecked here; `tool()` builds one that checks it against its schema. */
export type Tool = ToolSpec & {
  run: (input: unknown, context: ToolContext) => Output | Promise<Output>;
};

// ── Schemas: one description of a tool's input, or of an answer ─────────────
//
// A tool's schema is JSON Schema, because that is what a model is told. The
// same schema gives `run` its input type (Infer) and is enforced before `run`
// is called (tool), so the three cannot disagree. An answer's schema works the
// same way (shape): told to the model, typing what `parse` returns, enforced
// by `parse`. They read one subset:
//
//   type (a single name), properties, required, additionalProperties (true or
//   false), items, enum and const (of strings, numbers, booleans and null),
//   anyOf, minLength, maxLength, minimum, maximum, minItems, maxItems.
//
// A keyword constrains only the kind of value it is about, as JSON Schema
// says: `minLength` says nothing of a number. description, title, default,
// examples, $schema and $comment are for the reader and assert nothing. Any
// other keyword is refused when the tool or shape is made, because the model
// would be told something that is never enforced. A tool that needs more is a
// `Tool` written out, with a `run` that checks its own input.

type Needed<S> = S extends { required: readonly (infer K)[] } ? K : never;
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * The type of every value a schema accepts. Where the schema says more than
 * this can follow, the type is wider, never wrong.
 *
 * It reads the schema's literal types. Written inside `tool()` a schema keeps
 * them; held in a variable it needs `as const`, or the type is `unknown`.
 */
export type Infer<S> = S extends { const: infer C }
  ? C
  : S extends { enum: readonly (infer E)[] }
    ? E
    : S extends { anyOf: readonly (infer A)[] }
      ? A extends unknown
        ? Infer<A>
        : never
      : S extends { type: "string" }
        ? string
        : S extends { type: "number" | "integer" }
          ? number
          : S extends { type: "boolean" }
            ? boolean
            : S extends { type: "null" }
              ? null
              : S extends { type: "array" }
                ? S extends { items: infer I }
                  ? Infer<I>[]
                  : unknown[]
                : S extends { type: "object" }
                  ? S extends { properties: infer P }
                    ? Flat<
                        {
                          -readonly [K in keyof P as K extends Needed<S>
                            ? K
                            : never]: Infer<P[K]>;
                        } & {
                          -readonly [K in keyof P as K extends Needed<S>
                            ? never
                            : K]?: Infer<P[K]>;
                        }
                      >
                    : { [key: string]: unknown }
                  : unknown;

/** What is wrong with a value, in words for the model; nothing if it fits. `at` is where the value sits. */
type Check = (value: unknown, at: string) => readonly string[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isPlain = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

const named = (at: string) => at || "input";
const within = (at: string, key: string) => (at ? `${at}.${key}` : key);
const malformed = (keyword: string, wants: string) =>
  new Error(`schema: the keyword "${keyword}" must be ${wants}`);

const kinds: Record<
  string,
  { called: string; is: (value: unknown) => boolean }
> = {
  string: { called: "a string", is: (value) => typeof value === "string" },
  number: {
    called: "a number",
    is: (value) => typeof value === "number" && Number.isFinite(value),
  },
  integer: { called: "an integer", is: Number.isInteger },
  boolean: { called: "a boolean", is: (value) => typeof value === "boolean" },
  null: { called: "null", is: (value) => value === null },
  array: { called: "an array", is: Array.isArray },
  object: { called: "an object", is: isRecord },
};

// What a bound measures. Each is undefined for a value of another kind, which the bound then leaves alone.
const length = (value: unknown) =>
  typeof value === "string" ? [...value].length : undefined; // characters, not UTF-16 units
const amount = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const count = (value: unknown) =>
  Array.isArray(value) ? value.length : undefined;
const least = (size: number, limit: number) => size >= limit;
const most = (size: number, limit: number) => size <= limit;

const bound =
  (
    keyword: string,
    measure: (value: unknown) => number | undefined,
    fits: (size: number, limit: number) => boolean,
    says: (limit: number) => string,
  ) =>
  (limit: unknown): Check => {
    if (typeof limit !== "number") throw malformed(keyword, "a number");
    return (value, at) => {
      const size = measure(value);
      return size === undefined || fits(size, limit)
        ? []
        : [`${named(at)} must ${says(limit)}`];
    };
  };

const oneOf =
  (options: readonly unknown[]): Check =>
  (value, at) =>
    options.includes(value)
      ? []
      : [
          `${named(at)} must be ${options.map((option) => JSON.stringify(option)).join(" or ")}`,
        ];

// Every keyword that is enforced: given what the schema says for it, the check it stands for.
const keywords: Record<
  string,
  (given: unknown, schema: Record<string, unknown>) => Check
> = {
  type: (name) => {
    const kind =
      typeof name === "string" && Object.hasOwn(kinds, name)
        ? kinds[name]
        : undefined;
    if (!kind)
      throw malformed("type", `one of ${Object.keys(kinds).join(", ")}`);
    return (value, at) =>
      kind.is(value) ? [] : [`${named(at)} must be ${kind.called}`];
  },
  properties: (properties) => {
    if (!isRecord(properties))
      throw malformed("properties", "an object of schemas");
    const checks = Object.entries(properties).map(
      ([key, schema]) => [key, checker(schema)] as const,
    );
    return (value, at) =>
      isRecord(value)
        ? checks.flatMap(([key, check]) =>
            Object.hasOwn(value, key) ? check(value[key], within(at, key)) : [],
          )
        : [];
  },
  required: (keys) => {
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string"))
      throw malformed("required", "a list of names");
    return (value, at) =>
      isRecord(value)
        ? keys
            .filter((key) => !Object.hasOwn(value, key))
            .map((key) => `${within(at, key)} is missing`)
        : [];
  },
  additionalProperties: (allowed, schema) => {
    if (typeof allowed !== "boolean")
      throw malformed("additionalProperties", "true or false");
    const known = isRecord(schema.properties) ? schema.properties : {};
    return (value, at) =>
      allowed || !isRecord(value)
        ? []
        : Object.keys(value)
            .filter((key) => !Object.hasOwn(known, key))
            .map((key) => `${within(at, key)} is not expected`);
  },
  items: (schema) => {
    const check = checker(schema);
    return (value, at) =>
      Array.isArray(value)
        ? value.flatMap((item, i) => check(item, `${named(at)}[${i}]`))
        : [];
  },
  enum: (options) => {
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every(isPlain)
    )
      throw malformed("enum", "a list of strings, numbers, booleans or null");
    return oneOf(options);
  },
  const: (only) => {
    if (!isPlain(only))
      throw malformed("const", "a string, a number, a boolean or null");
    return oneOf([only]);
  },
  anyOf: (schemas) => {
    if (!Array.isArray(schemas) || schemas.length === 0)
      throw malformed("anyOf", "a list of schemas");
    const checks = schemas.map(checker);
    return (value, at) => {
      const tried = checks.map((check) => check(value, at));
      return tried.some((wrong) => wrong.length === 0)
        ? []
        : [tried.map((wrong) => wrong.join(" and ")).join(", or ")];
    };
  },
  minLength: bound(
    "minLength",
    length,
    least,
    (limit) => `be ${limit} or more characters long`,
  ),
  maxLength: bound(
    "maxLength",
    length,
    most,
    (limit) => `be ${limit} or fewer characters long`,
  ),
  minimum: bound("minimum", amount, least, (limit) => `be ${limit} or more`),
  maximum: bound("maximum", amount, most, (limit) => `be ${limit} or less`),
  minItems: bound(
    "minItems",
    count,
    least,
    (limit) => `have ${limit} or more items`,
  ),
  maxItems: bound(
    "maxItems",
    count,
    most,
    (limit) => `have ${limit} or fewer items`,
  ),
};

const notes = new Set([
  "description",
  "title",
  "default",
  "examples",
  "$schema",
  "$comment",
]);

/** The check a schema stands for. Throws if the schema says anything that would go unenforced. */
const checker = (schema: unknown): Check => {
  if (!isRecord(schema)) throw new Error("schema: a schema must be an object");
  const checks = Object.entries(schema)
    .filter(([keyword]) => !notes.has(keyword))
    .map(([keyword, given]) => {
      const make = Object.hasOwn(keywords, keyword)
        ? keywords[keyword]
        : undefined;
      if (!make)
        throw new Error(
          `schema: the keyword "${keyword}" is not one this enforces`,
        );
      return make(given, schema);
    });
  return (value, at) => checks.flatMap((check) => check(value, at));
};

/**
 * A tool whose input is checked against its schema before it runs, and typed
 * by it. Input that does not fit goes back to the model as an error result
 * that names everything wrong with it, so it can correct the call.
 *
 * Throws, when the tool is made, if the schema uses a keyword that would not
 * be enforced.
 */
export const tool = <const S extends object>(spec: {
  name: string;
  description: string;
  schema: S;
  run: (input: Infer<S>, context: ToolContext) => Output | Promise<Output>;
}): Tool => {
  const check = checker(spec.schema);
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    run: (input, context) => {
      const wrong = check(input, "");
      if (wrong.length > 0) throw new Error(wrong.join("; "));
      // Checked just above: the one place the schema's type is taken on trust.
      return spec.run(input as Infer<S>, context);
    },
  };
};

/** A shape that also reads the answer it asked for. */
export type Shape<T> = ShapeSpec & { parse: (answer: string) => T };

/**
 * The shape of an answer: one schema that is told to the model, types what
 * `parse` returns, and is enforced by `parse`. Give it to a request as `shape`
 * and read the reply with `parse(await text(...))`.
 *
 * `parse` throws unless the answer is JSON that fits the schema as it was
 * given, naming everything wrong with it. It is exact: a `null` where the
 * schema does not accept one is wrong, so a value that may be missing is best
 * written as required and either itself or null.
 *
 * Throws, when the shape is made, if the schema uses a keyword that would not
 * be enforced.
 */
export const shape = <const S extends object>(schema: S): Shape<Infer<S>> => {
  const check = checker(schema);
  return {
    schema,
    parse: (answer) => {
      let value: unknown;
      try {
        value = JSON.parse(answer);
      } catch (cause) {
        throw new Error("the answer is not JSON", { cause });
      }
      const wrong = check(value, "answer");
      if (wrong.length > 0) throw new Error(wrong.join("; "));
      // Checked just above: the one place the schema's type is taken on trust.
      return value as Infer<S>;
    },
  };
};

// ── For provider authors: a schema as one API takes it ─────────────────────

// A copy with every value through `to`; the same list or record back if none changed.
const mapList = (
  list: readonly unknown[],
  to: (item: unknown) => unknown,
): readonly unknown[] => {
  const mapped = list.map(to);
  return mapped.every((item, i) => item === list[i]) ? list : mapped;
};
const mapRecord = (
  record: Record<string, unknown>,
  to: (value: unknown, key: string) => unknown,
): Record<string, unknown> => {
  const mapped = Object.entries(record).map(
    ([key, value]) => [key, to(value, key)] as const,
  );
  return mapped.every(([key, value]) => value === record[key])
    ? record
    : Object.fromEntries(mapped);
};

/**
 * A copy of the schema in which every schema inside it, innermost first, has
 * been through `fit`: each property's, an array's items, each alternative of
 * an `anyOf`, and last the schema itself. Where `fit` gives back the schema it
 * was handed, nothing is copied, and a schema that needs no change is returned
 * as is.
 *
 * `at` is where the value a schema describes sits: "" for the whole of it,
 * `a.b` for a property, `a[]` for an array's items. An alternative sits where
 * its `anyOf` does.
 *
 * `fit` may loosen or tighten what a schema accepts. It must not give back one
 * whose values would have to be rewritten to fit the original; it throws
 * instead. It must give the same output for the same schema every time.
 */
export const fitSchema = (
  schema: object,
  fit: (schema: Record<string, unknown>, at: string) => object,
): object => {
  const inside = (child: unknown, at: string): unknown =>
    isRecord(child) ? fitted(child, at) : child;
  const fitted = (node: Record<string, unknown>, at: string): object => {
    const { properties, items, anyOf } = node;
    const inner: Record<string, unknown> = {
      ...(isRecord(properties) && {
        properties: mapRecord(properties, (child, key) =>
          inside(child, within(at, key)),
        ),
      }),
      ...(isRecord(items) && { items: inside(items, `${at}[]`) }),
      ...(Array.isArray(anyOf) && {
        anyOf: mapList(anyOf, (child) => inside(child, at)),
      }),
    };
    const unchanged = Object.keys(inner).every(
      (keyword) => inner[keyword] === node[keyword],
    );
    return fit(unchanged ? node : { ...node, ...inner }, at);
  };
  return isRecord(schema) ? fitted(schema, "") : schema;
};

/** The tool calls a history is waiting on: those in a final, finished model turn. */
export const pendingToolCalls = (
  messages: readonly AnyMessage[],
): ToolCall[] => {
  const last = messages.at(-1);
  return last?.from === "model" && last.end === "stop"
    ? last.content.filter(isToolCall)
    : [];
};

/**
 * Run one call and give back what the tool returned. Throws if there is no
 * such tool, and throws whatever the tool throws, as it was thrown: bad input,
 * a failure of the tool's own, and a mistake in its code all arrive here.
 */
export const attemptToolCall = async (
  tools: readonly Tool[],
  call: ToolCall,
  signal?: AbortSignal,
): Promise<Output> => {
  const found = tools.find((t) => t.name === call.name);
  if (!found) throw new Error(`unknown tool: ${call.name}`);
  return found.run(call.input, { signal });
};

// What went wrong, in the thrower's own words. Anything with a `message` will do, so an error from elsewhere reads the same.
const told = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  error.message !== ""
    ? error.message
    : String(error);

/** The error result for a call that failed: what the model reads of the failure. */
export const toolFailure = (call: ToolCall, error: unknown): ToolResult =>
  toolResult(call, told(error), { error: true });

/**
 * Run one call. A missing or throwing tool becomes an error result. If the
 * signal was aborted, the failure is thrown instead: a cancelled call is not
 * something for the model to read about.
 *
 * It is `attemptToolCall`, with `toolResult` for what comes back and
 * `toolFailure` for what is thrown. To see a failure before the model does,
 * put the three together yourself.
 */
export const runToolCall = async (
  tools: readonly Tool[],
  call: ToolCall,
  signal?: AbortSignal,
): Promise<ToolResult> => {
  try {
    return toolResult(call, await attemptToolCall(tools, call, signal));
  } catch (error) {
    signal?.throwIfAborted();
    return toolFailure(call, error);
  }
};
