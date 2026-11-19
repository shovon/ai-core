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
 *
 * It may be given to a model, come back from a tool, or be made by a model. A
 * provider whose model makes one emits it whole.
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
/**
 * The input of a tool call as the model writes it: its JSON text, in pieces.
 * It is for showing, never for running or sending. The call itself still
 * arrives whole, as a ToolCall with the same id, and takes the place of its
 * pieces in a reply. Taking every tool-input part out of a history changes
 * nothing that any provider sends.
 *
 * Every piece carries the id and name of its call. One with no text yet says
 * only that the model has started writing the call. The text so far is a
 * beginning of JSON, and need not be JSON itself.
 */
export type ToolInputPart = {
  type: "tool_input";
  id: string;
  name: string;
  text: string;
};
/**
 * Where something the model said came from. It follows the text it supports:
 * a source belongs to the text directly before it, and several in a row all
 * support that same text.
 *
 * `span` says how much of that text: its last `span` characters, counted as a
 * string's `length` counts them. With no `span` it is all of the text part
 * before it. Text arrives in pieces and joins whatever text came before, so
 * the span is what keeps a source to its own passage.
 *
 * `quote` is the passage relied on, `title` what it is from, and `url` where
 * that is. Whatever else a provider knows of a source is in a field under the
 * provider's name. A provider sends its own sources back with the text, if its
 * API takes them, and leaves out everyone else's.
 */
export type SourcePart = {
  type: "source";
  span?: number;
  quote?: string;
  title?: string;
  url?: string;
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
  /** Of `output`, the tokens spent reasoning. Absent when the provider did not say. */
  reasoning?: number;
};

/**
 * What closes a turn: why it ended, what it cost, and what the provider said
 * of its own response.
 * - `id` is the provider's name for this response, the one to quote to it.
 * - `model` is the model that answered, as the provider names it, which may
 *   be more exact than the one asked for.
 *
 * It may also carry a field under its provider's name, holding whatever else
 * that provider says of the response. `append` keeps every one of these on
 * the turn, so a stored history holds them too. None of it is ever sent.
 */
export type End = {
  type: "end";
  reason: Reason;
  usage?: Usage;
  id?: string;
  model?: string;
};

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
 * `id` and `model` are the provider's name for the response and the model that
 * gave it, when the provider said.
 *
 * A finished turn holds whatever else its End carried, such as a field under
 * the provider's name. A provider reads only `content` when it sends a turn.
 */
export type ModelMessage<P extends Part> = {
  from: "model";
  content: readonly P[];
  end?: Reason;
  usage?: Usage;
  id?: string;
  model?: string;
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
 *
 * A model turn may hold tool input whose call never arrived, because its
 * stream stopped first. Like reasoning, it is kept for showing and never sent.
 *
 * A model turn may hold a file, when a model made one: an image it drew, say.
 * It is what the model said, as its text is, so a provider sends it back if
 * its API takes one there, and says so if it does not.
 *
 * A model turn may hold sources, each after the text it supports.
 */
export type PortableMessage = Message<
  TextPart | FilePart,
  | TextPart
  | FilePart
  | SourcePart
  | ReasoningPart
  | ToolCall
  | ToolInputPart
  | NativePart
>;

/** What one call produced: the messages to add to the history, in order. */
export type Reply<Out extends Part> = readonly (
  | ModelMessage<Out>
  | ToolMessage
)[];

/**
 * What the model is told of a tool. It may carry an extra field under one
 * provider's name, holding that provider's own settings for the tool. Every
 * other provider ignores the field and is told the same tool.
 */
export type ToolSpec = { name: string; description: string; schema: object };
/** What an answer must be: JSON that fits this schema. `parse` checks one, once it is read as JSON. */
export type ShapeSpec = { schema: object };
export type Request<
  M extends AnyMessage,
  S extends TextPart = TextPart,
  T extends ToolSpec = ToolSpec,
> = {
  /**
   * Standing instructions for this call: one string, or text parts in order.
   * Parts concatenate exactly: a list means the same as its texts joined with
   * nothing between them, so any separator belongs in the text. Splitting a
   * prompt into parts, for instance to put a hint on one, never changes it.
   */
  system?: string | readonly S[];
  messages: readonly M[];
  /** What the model may call. An empty list means the same as leaving it out: the model can call nothing. */
  tools?: readonly T[];
  /**
   * Structured output: asks for the final answer as JSON that fits a schema.
   * The answer still arrives as text, for `JSON.parse` and then `parse` to read. A provider that cannot ask
   * for this schema throws; one that does not know the field ignores it.
   */
  shape?: ShapeSpec;
  /**
   * Settings addressed to one provider, under its name: that vendor's own
   * settings for this call, such as which model answers. A provider reads the
   * entry under its own name and ignores every other. Nothing else on a request
   * is a vendor's: this is the one field that holds what the library does not name.
   */
  native?: { readonly [provider: string]: unknown };
  /** Cancels the call. The stream then throws. Tools are yours to run, so give them the same signal to cancel them too. */
  signal?: AbortSignal;
};

// ── The one port ────────────────────────────────────────────────────────────
// Accepts messages of type In. Emits one or more turns: a turn is the model's
// parts followed by one End. Of the parts named here, text, reasoning and tool
// input arrive in pieces, and every other one is emitted whole.
//
// A provider may emit a kind of part of its own in pieces too. How its pieces
// join is then a rule (Join) the provider gives beside itself, for `appending`
// and `collecting`. Folded without the rule, each piece is a part by itself:
// nothing is lost, and nothing is joined.
//
// A provider whose model says where its words came from emits a source
// (SourcePart) directly after the text it supports, whole, with how much of
// that text it speaks for.
//
// A provider may tell of a tool call while the model is still writing it: the
// pieces of its input (ToolInputPart), one after another with nothing between
// them, and then the call itself, whole, directly after. The call is what is
// run and what is sent back; the pieces are only for showing. A provider that
// tells nothing of the kind emits the call alone, and nothing else changes.
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
// A tool may carry a field under one provider's name: that provider's own
// settings for the tool. What sits under a provider's name is addressed to it
// alone, so it may send that on as it is, and every setting its API has for a
// tool stays in reach. What the tool is, its name, description and schema,
// always comes from the tool itself.
//
// A request says a provider's settings in `native`, under that provider's
// name: which model answers, and whatever else its API takes. A provider is
// made with none of its own. It reads its own entry and no other, sends it as
// it is, and never forwards the field. What the library gives a meaning, such
// as a shape, comes from the request itself, so nothing in an entry can
// replace it. A provider that cannot be called without settings refuses a
// request that has none.
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
export const isToolInput = (part: Part): part is ToolInputPart =>
  part.type === "tool_input";
export const isSource = (part: Part): part is SourcePart =>
  part.type === "source";
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
// is of the same kind; text never joins reasoning, nor reasoning text. Tool
// input joins only the input of the same call.
const inPieces = (
  part: Part,
): part is TextPart | ReasoningPart | ToolInputPart =>
  isText(part) || isReasoning(part) || isToolInput(part);
// The call a piece belongs to; text and reasoning belong to none.
const callOf = (part: Part) => (isToolInput(part) ? part.id : undefined);

/**
 * How one more part is added to the parts of a turn still arriving: joined to
 * what is there, or put after it. That is all it means for a kind of part to
 * arrive in pieces, so a rule is what teaches the fold a new kind.
 *
 * A rule is pure: it returns the parts, and leaves those it was given as they
 * were. It keeps one law. However a part is cut into pieces, the turn comes
 * out the same: adding two pieces one after the other gives what adding them
 * as one piece gives.
 *
 * A rule of your own speaks for the kinds it knows and hands every other part
 * to `join`. It is given the whole turn, so it may join a piece to a part that
 * is not the last.
 */
export type Join<P extends Part> = (
  parts: readonly P[],
  part: P,
) => readonly P[];

/**
 * The rule for the parts this library names, and the one `append` and
 * `collect` go by. Text joins the text directly before it, and reasoning the
 * reasoning; tool input joins the input of the same call. A tool call takes
 * the place of the tool input directly before it, when that is its own. Every
 * other part is put after the rest, whole.
 */
export const join = <P extends Part>(
  parts: readonly P[],
  part: P,
): readonly P[] => {
  const last = parts.at(-1);
  const before = parts.slice(0, -1);
  // The whole call takes the place of the pieces of its input.
  if (last && isToolInput(last) && isToolCall(part) && last.id === part.id)
    return [...before, part];
  return last &&
    inPieces(last) &&
    inPieces(part) &&
    last.type === part.type &&
    callOf(last) === callOf(part)
    ? [...before, { ...last, text: last.text + part.text }]
    : [...parts, part];
};

/**
 * `append` with a rule of your own for joining the parts of a turn. Turns,
 * Ends and tool results are folded as `append` folds them; only how a part
 * joins the parts before it is the rule's to say. Every part of a turn goes
 * through the rule, the first one too, onto no parts at all.
 *
 * `append` is `appending(join)`.
 */
export const appending =
  <Out extends Part>(rule: Join<Out>) =>
  (reply: Reply<Out>, chunk: Out | ToolResult | End): Reply<Out> => {
    const last = reply.at(-1);
    const rest = reply.slice(0, -1);
    if (isToolResult(chunk))
      return last?.from === "tool"
        ? [...rest, { from: "tool", content: [...last.content, chunk] }]
        : [...reply, { from: "tool", content: [chunk] }];
    const arriving = last?.from === "model" && !last.end ? last : undefined;
    if (isEnd(chunk)) {
      // Everything the End says goes on the turn: the reason as `end`, the rest as it is.
      const { type, reason, ...said } = chunk;
      return arriving
        ? [...rest, { ...arriving, end: reason, ...said }]
        : [...reply, { from: "model", content: [], end: reason, ...said }];
    }
    return arriving
      ? [...rest, { ...arriving, content: rule(arriving.content, chunk) }]
      : [...reply, { from: "model", content: rule([], chunk) }];
  };

/**
 * Add one chunk to a reply. Pure: returns a new reply.
 * A model part joins the turn still arriving, or starts a new one. An End
 * finishes that turn, and all it carries is kept on it. A tool result joins
 * the tool message in progress.
 *
 * A tool call takes the place of the tool input directly before it, when that
 * is its own. So a stream that tells of each call's input as it is written
 * comes to the same reply as one that does not.
 *
 * The parts of a turn are joined as `join` says. For a kind of part of your
 * own that arrives in pieces, `appending` makes this fold from your rule.
 */
export const append: <Out extends Part>(
  reply: Reply<Out>,
  chunk: Out | ToolResult | End,
) => Reply<Out> = appending(join);

/**
 * `collect` with a rule of your own for joining the parts of a turn: every
 * message a stream produced, folded by `appending(rule)`.
 *
 * `collect` is `collecting(join)`.
 */
export const collecting =
  <Out extends Part>(rule: Join<Out>) =>
  async (
    stream: AsyncIterable<Out | ToolResult | End>,
  ): Promise<Reply<Out>> => {
    const add = appending(rule);
    let reply: Reply<Out> = [];
    for await (const chunk of stream) reply = add(reply, chunk);
    const last = reply.at(-1);
    if (!last || (last.from === "model" && !last.end))
      throw new Error("stream finished without an end chunk");
    return reply;
  };

/** Every message a stream produced. Throws if it stops in the middle of a turn. */
export const collect: <Out extends Part>(
  stream: AsyncIterable<Out | ToolResult | End>,
) => Promise<Reply<Out>> = collecting(join);

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

/**
 * What the model turns in a history cost, added up. A turn with no usage
 * counts as nothing, and so does a count a turn does not report: `reasoning`
 * is then the least it can have been.
 */
export const totalUsage = (messages: readonly AnyMessage[]): Required<Usage> =>
  messages.reduce(
    (sum, message) => {
      const {
        input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        reasoning = 0,
      } = (message.from === "model" && message.usage) || {};
      return {
        input: sum.input + input,
        output: sum.output + output,
        cacheRead: sum.cacheRead + cacheRead,
        cacheWrite: sum.cacheWrite + cacheWrite,
        reasoning: sum.reasoning + reasoning,
      };
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
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

// ── Tools: pieces for your own loop ─────────────────────────────────────────
//
// Nothing here runs a tool, and there is no loop. A request says what the
// model may call (ToolSpec), a reply holds what it called (ToolCall), and the
// next request carries what came of each call (ToolResult). Those three are
// what a provider has a say in. What a call does is your code.
//
// A loop is the same call made again with a longer history, so it is a few
// lines of your own:
//
//   for (;;) {
//     messages.push(...(await collect(provider({ messages, tools }))));
//     const last = messages.at(-1);
//     if (last?.from === "model" && last.end === "pause") continue;
//     const calls = pendingToolCalls(messages);
//     if (calls.length === 0) break;
//     messages.push({ from: "tool", content: await Promise.all(calls.map(answer)) });
//   }
//
// and so is `answer`, which makes the result of one call. `run` is whatever
// you have that does what a call names:
//
//   const answer = async (call: ToolCall): Promise<ToolResult> => {
//     try {
//       return toolResult(call, await run(call));
//     } catch (error) {
//       if (isSchemaError(error)) throw error;
//       signal?.throwIfAborted();
//       return toolFailure(call, error);
//     }
//   };
//
// A paused turn is not an answer and asks for nothing: it goes back as it is.
// A turn that was cut off may hold calls, the last of them perhaps half
// written. They are not pending and are never run; the provider answers them
// itself when the history is next sent. A call you cancelled is not something
// for the model to read about, and neither is a mistake in a schema of yours,
// so `answer` throws for those instead of making a result. What becomes of a call to a tool that is not there, which failures
// the model reads and which stop the loop, running calls one at a time, asking
// before one runs, and stopping after so many turns are all changes to those
// lines.

// ── Schemas: one description of a tool's input, or of an answer ─────────────
//
// A tool's schema is JSON Schema, because that is what a model is told. The
// same schema types the input of a call (Infer) and is what that input is
// checked against (parse), so the three cannot disagree. An answer's schema
// works the same way. They read one subset:
//
//   type (a single name), properties, required, additionalProperties (true or
//   false), items, enum and const (of strings, numbers, booleans and null),
//   anyOf, minLength, maxLength, minimum, maximum, minItems, maxItems.
//
// A keyword constrains only the kind of value it is about, as JSON Schema
// says: `minLength` says nothing of a number. description, title, default,
// examples, $schema and $comment are for the reader and assert nothing. Any
// other keyword is refused when something is parsed against the schema,
// because the model would be told something that is never enforced. That is a
// mistake in the schema, not in what the model sent, and `isSchemaError` tells
// the two apart. A tool that needs more has its input checked your own way.

type Needed<S> = S extends { required: readonly (infer K)[] } ? K : never;
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * The type of every value a schema accepts. Where the schema says more than
 * this can follow, the type is wider, never wrong.
 *
 * It reads the schema's literal types. Written where it is parsed against, a
 * schema keeps them; held in a variable it needs `as const`, or the type is
 * `unknown`.
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

const named = (at: string) => at || "value";
const within = (at: string, key: string) => (at ? `${at}.${key}` : key);
// A mistake in a schema itself. It goes by its own name, so it can be told from what a model got wrong.
const schemaError = (says: string) =>
  Object.assign(new Error(`schema: ${says}`), { name: "SchemaError" });
const malformed = (keyword: string, wants: string) =>
  schemaError(`the keyword "${keyword}" must be ${wants}`);

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

/** The check a schema stands for. Throws a schema error if the schema says anything that would go unenforced. */
const checker = (schema: unknown): Check => {
  if (!isRecord(schema)) throw schemaError("a schema must be an object");
  const checks = Object.entries(schema)
    .filter(([keyword]) => !notes.has(keyword))
    .map(([keyword, given]) => {
      const make = Object.hasOwn(keywords, keyword)
        ? keywords[keyword]
        : undefined;
      if (!make)
        throw schemaError(`the keyword "${keyword}" is not one this enforces`);
      return make(given, schema);
    });
  return (value, at) => checks.flatMap((check) => check(value, at));
};

/**
 * Whether an error says that a schema cannot be enforced as it is written: it
 * is malformed, or uses a keyword outside the subset. That is a mistake in the
 * code that wrote the schema, never in what a model sent, so it is not for the
 * model to read.
 *
 * It goes by the error's name, "SchemaError". Anything by that name will do,
 * so it does not matter which copy of this library threw it.
 */
export const isSchemaError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "SchemaError";

/**
 * A value, checked against a schema and typed by it. Throws unless the value
 * fits the schema as it was given, naming everything wrong with it. Given back
 * to the model, that lets it correct what it sent.
 *
 * It reads the input of a tool call, `parse(schema, call.input)`, and an
 * answer that was asked for as a `shape`, `parse(schema, JSON.parse(answer))`.
 * It is exact: a `null` where the schema does not accept one is wrong, so a
 * value that may be missing is best written as required and either itself or
 * null.
 *
 * Throws a schema error, whatever the value, if the schema uses a keyword that
 * would not be enforced.
 */
export const parse = <const S extends object>(
  schema: S,
  value: unknown,
): Infer<S> => {
  const wrong = checker(schema)(value, "");
  if (wrong.length > 0) throw new Error(wrong.join("; "));
  // Checked just above: the one place the schema's type is taken on trust.
  return value as Infer<S>;
};

// ── JSON that is still being written ────────────────────────────────────────
//
// A tool call's input and an answer asked for in a shape both arrive as the
// text of a JSON document, a piece at a time. Until the last piece, that text
// is only the beginning of one, and JSON.parse has nothing to say of it.

const escapes = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);
// A number, and every beginning of one.
const numeral = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numeralSoFar =
  /^-?(?:(?:0|[1-9]\d*)(?:\.(?:\d+(?:[eE][+-]?\d*)?)?|[eE][+-]?\d*)?)?$/;

/**
 * The value that the beginning of a JSON document holds so far: what can be
 * read of a tool call's input, or of an answer asked for in a shape, while it
 * is still being written. It is for showing. Nothing checks it against a
 * schema, and it may lack what the finished value must have, so it is
 * `unknown`; the finished text is still read with `JSON.parse` and `parse`.
 *
 * - A whole document reads exactly as `JSON.parse` reads it.
 * - A string still being written is there as far as it goes. Anything else
 *   unfinished is left out until it is whole: a property with no value yet, a
 *   number that may gain digits, half of `true`. With nothing to read yet,
 *   the value is `undefined`.
 * - It only grows. As text is added, strings get longer and objects and arrays
 *   gain entries; nothing already there changes or goes away. The one
 *   exception is a document that is a bare number, which is read as it stands.
 * - Text that no JSON document begins with throws a SyntaxError, as
 *   `JSON.parse` does.
 */
export const partial = (text: string): unknown => {
  let at = 0;
  const ended = () => at >= text.length;
  const wrong = (where = at) =>
    new SyntaxError(
      `not the beginning of JSON: unexpected ${JSON.stringify(text[where])} at ${where}`,
    );
  const space = () => {
    while (!ended() && " \t\n\r".includes(text[at]!)) at++;
  };

  // Where plain text in a string stops: its end, an escape, or what may not be in one.
  const stop = /["\\\u0000-\u001f]/g;
  // A string as far as it is written, and whether its closing quote was reached.
  const string = (): { said: string; whole: boolean } => {
    at++;
    let said = "";
    for (;;) {
      stop.lastIndex = at;
      const to = stop.exec(text)?.index ?? text.length;
      said += text.slice(at, to);
      at = to;
      if (ended()) return { said, whole: false };
      if (text[at] === '"') {
        at++;
        return { said, whole: true };
      }
      if (text[at] !== "\\") throw wrong();
      // An escape cut short says nothing yet.
      const escape = text[at + 1];
      if (escape === undefined) {
        at = text.length;
        return { said, whole: false };
      }
      if (escape === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]*$/.test(hex)) throw wrong(at + 2);
        if (hex.length < 4) {
          at = text.length;
          return { said, whole: false };
        }
        said += String.fromCharCode(parseInt(hex, 16));
        at += 6;
        continue;
      }
      const meant = escapes.get(escape);
      if (meant === undefined) throw wrong(at + 1);
      said += meant;
      at += 2;
    }
  };

  // A number is whole once something follows it. The document itself may be a
  // number with nothing after it, and then it is read as it stands.
  const number = (root: boolean): number | undefined => {
    const from = at;
    while (!ended() && "-+.eE0123456789".includes(text[at]!)) at++;
    const seen = text.slice(from, at);
    if (!ended() || root) {
      if (numeral.test(seen)) return Number(seen);
      if (!ended()) throw wrong(from);
    }
    if (!numeralSoFar.test(seen)) throw wrong(from);
    return undefined;
  };

  const word = (name: string, value: unknown): unknown => {
    const seen = text.slice(at, at + name.length);
    if (!name.startsWith(seen)) throw wrong();
    at += seen.length;
    return seen === name ? value : undefined;
  };

  const array = (): unknown[] => {
    at++;
    const items: unknown[] = [];
    space();
    if (text[at] === "]") {
      at++;
      return items;
    }
    for (;;) {
      space();
      if (ended()) return items;
      const item = value(false);
      if (item !== undefined) items.push(item);
      space();
      if (ended()) return items;
      if (text[at] === "]") {
        at++;
        return items;
      }
      if (text[at] !== ",") throw wrong();
      at++;
    }
  };

  const object = (): object => {
    at++;
    const entries: [string, unknown][] = [];
    // As JSON.parse makes one: a name given twice keeps its place and its last value.
    const made = () => Object.fromEntries(entries);
    space();
    if (text[at] === "}") {
      at++;
      return made();
    }
    for (;;) {
      space();
      if (ended()) return made();
      if (text[at] !== '"') throw wrong();
      const name = string();
      if (!name.whole) return made();
      space();
      if (ended()) return made();
      if (text[at] !== ":") throw wrong();
      at++;
      space();
      if (ended()) return made();
      const held = value(false);
      if (held !== undefined) entries.push([name.said, held]);
      space();
      if (ended()) return made();
      if (text[at] === "}") {
        at++;
        return made();
      }
      if (text[at] !== ",") throw wrong();
      at++;
    }
  };

  // Called only where there is text left. What is left out comes back undefined.
  const value = (root: boolean): unknown => {
    const first = text[at]!;
    if (first === "{") return object();
    if (first === "[") return array();
    if (first === '"') return string().said;
    if (first === "t") return word("true", true);
    if (first === "f") return word("false", false);
    if (first === "n") return word("null", null);
    if (first === "-" || (first >= "0" && first <= "9")) return number(root);
    throw wrong();
  };

  space();
  if (ended()) return undefined;
  const read = value(true);
  space();
  if (!ended()) throw wrong();
  return read;
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
