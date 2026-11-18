// The only file that imports the Anthropic SDK.
import type Anthropic from "@anthropic-ai/sdk";
import {
  answerToolCalls,
  fitSchema,
  fitToolIds,
  toolResult,
  type FilePart,
  type ModelMessage,
  type NativePart,
  type Part,
  type Reason,
  type ReasoningPart,
  type Request,
  type ShapeSpec,
  type Takes,
  type TextPart,
  type ToolCall,
  type ToolResult,
  type Usage,
  type UserMessage,
} from "@ai-agent-library/library";

// Anthropic's own blocks (thinking, server-tool results, ...) travel as native
// parts under this provider's name, so no other provider mistakes them for its own.
export type AnthropicBlock = Exclude<
  Anthropic.ContentBlock,
  Anthropic.TextBlock | Anthropic.ToolUseBlock
>;
export type AnthropicNative = NativePart<"anthropic", AnthropicBlock>;
export type AnthropicOut =
  | TextPart
  | ReasoningPart
  | ToolCall
  | AnthropicNative;

/**
 * Instructions for Anthropic alone, carried as an extra field on a shared
 * part. They change cost, never meaning, so every other provider ignores them.
 * Read on the parts of a message itself and on the parts of the system prompt,
 * not on parts inside a tool result.
 */
export type AnthropicHints = {
  anthropic?: {
    /** Cache the request up to and including this part. */
    cache_control?: Anthropic.CacheControlEphemeral;
  };
};

/**
 * Any portable history, optionally with hints. Any provider's native parts are
 * accepted in a model turn; only Anthropic's own are sent.
 */
export type AnthropicMessage =
  | UserMessage<(TextPart | FilePart) & AnthropicHints>
  | ModelMessage<
      ((TextPart | ToolCall) & AnthropicHints) | ReasoningPart | NativePart
    >
  | { from: "tool"; content: readonly (ToolResult & AnthropicHints)[] };

/** A request whose system prompt, given as parts, may carry hints too. */
export type AnthropicRequest = Request<
  AnthropicMessage,
  TextPart & AnthropicHints
>;

type Options = Omit<
  Anthropic.MessageStreamParams,
  "messages" | "system" | "tools"
>;

const unsendable = (part: Part) =>
  new Error(`anthropic: cannot send a "${part.type}" part`);

const images = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const isImage = (mediaType: string): mediaType is (typeof images)[number] =>
  (images as readonly string[]).includes(mediaType);

// A history may come from storage, written by anything. The file's content is
// sent as is, so it is the one thing checked: never send a file with nothing in it.
const source = (part: FilePart) => {
  if ("url" in part && typeof part.url === "string")
    return { type: "url", url: part.url } as const;
  if ("data" in part && typeof part.data === "string")
    return { type: "base64", data: part.data } as const;
  throw new Error(
    'anthropic: a file part needs base64 "data" or a "url", as a string',
  );
};

const fileBlock = (
  part: FilePart,
): Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam => {
  const { mediaType } = part;
  const from = source(part);
  if (isImage(mediaType))
    return {
      type: "image",
      source: from.type === "url" ? from : { ...from, media_type: mediaType },
    };
  if (mediaType === "application/pdf")
    return {
      type: "document",
      source: from.type === "url" ? from : { ...from, media_type: mediaType },
    };
  throw new Error(`anthropic: cannot send a ${mediaType} file`);
};

// One translator per origin, because each origin allows different parts.
// A part none of them recognises is an error here, never forwarded to the API.

/** The one hint this provider knows. Nothing else in the field is forwarded. */
const cache = (part: AnthropicHints) => part.anthropic?.cache_control;

const block = (part: TextPart | FilePart) => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text } as const;
    case "file":
      return fileBlock(part);
    default:
      throw unsendable(part);
  }
};

// The name is the only evidence a stored native part offers about its value.
const isOwn = (part: NativePart): part is AnthropicNative =>
  part.provider === "anthropic";

/** A model-turn part as Anthropic takes it back. Another provider's native part is left out. */
const echoed = (
  part: ((TextPart | ToolCall) & AnthropicHints) | ReasoningPart | NativePart,
): Anthropic.ContentBlockParam[] => {
  switch (part.type) {
    // Shown, never sent. The thinking block itself goes back as a native part.
    case "reasoning":
      return [];
    case "text":
      return [{ type: "text", text: part.text, cache_control: cache(part) }];
    case "tool_call":
      return [
        {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input,
          cache_control: cache(part),
        },
      ];
    case "native":
      return isOwn(part) ? [part.value] : [];
    default:
      throw unsendable(part);
  }
};

const answered = (
  part: ToolResult & AnthropicHints,
): Anthropic.ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: part.id,
  is_error: part.error,
  content: part.content.map(block),
  cache_control: cache(part),
});

const message = (m: AnthropicMessage): Anthropic.MessageParam => {
  switch (m.from) {
    case "user":
      return {
        role: "user",
        content: m.content.map((part) => ({
          ...block(part),
          cache_control: cache(part),
        })),
      };
    case "model":
      return { role: "assistant", content: m.content.flatMap(echoed) };
    case "tool":
      return { role: "user", content: m.content.map(answered) };
    default:
      throw new Error(
        `anthropic: cannot send a message from "${(m as { from: string }).from}"`,
      );
  }
};

/**
 * The system prompt as Anthropic takes it. Parts concatenate exactly, so they
 * are joined here and a block ends only where a hint needs one; with no hints
 * the prompt goes out as a single string, the same as if it had been given as one.
 *
 * Between blocks the joining is Anthropic's. Whether it puts anything there is
 * not documented and has not been checked against the live API.
 */
const instructions = (system: AnthropicRequest["system"]) => {
  if (system === undefined || typeof system === "string") return system;
  const blocks: Anthropic.TextBlockParam[] = [];
  let text = "";
  for (const part of system) {
    if (part.type !== "text") throw unsendable(part);
    text += part.text;
    const cache_control = cache(part);
    if (cache_control) {
      blocks.push({ type: "text", text, cache_control });
      text = "";
    }
  }
  if (text !== "") blocks.push({ type: "text", text });
  if (blocks.length === 0) return undefined;
  return blocks.some((block) => block.cache_control) ? blocks : text;
};

// Anthropic rejects a tool-call id holding anything but letters, digits, "_" and "-".
// The rule is taken from the API's own validation error; it is not in the reference.
const fitsAnthropic = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);
const freshId = (n: number) => `toolu_fitted_${n}`;

// Anthropic rejects a history in which a tool call is not answered in the very
// next message. A call left without a result is given this one on the way out.
const unrun = (call: ToolCall) =>
  toolResult(call, "Not run: this call was never given a result.", {
    error: true,
  });

// ── A shape, as Anthropic takes it ──────────────────────────────────────────
//
// Anthropic compiles the schema and holds the model to it, but takes a
// narrower schema than the library does. The rules are from its structured
// outputs guide. Two limits there are left to the API to report: 24 optional
// properties and 16 properties with alternatives in one request.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The bounds Anthropic does not enforce, each with what the model is told in its place.
const bounds: Record<string, (limit: unknown) => string> = {
  minimum: (limit) => `Must be ${limit} or more.`,
  maximum: (limit) => `Must be ${limit} or less.`,
  minLength: (limit) => `Must be ${limit} or more characters long.`,
  maxLength: (limit) => `Must be ${limit} or fewer characters long.`,
  minItems: (limit) => `Must have ${limit} or more items.`,
  maxItems: (limit) => `Must have ${limit} or fewer items.`,
};
// The one exception: a list may be required to be non-empty.
const enforced = (keyword: string, limit: unknown) =>
  keyword === "minItems" && (limit === 0 || limit === 1);

/**
 * One schema as Anthropic takes it. A bound it does not enforce is left out
 * and said in the description, so the model is still told; the reader checks
 * it. An object is closed, which Anthropic requires: the model then writes
 * only the listed properties, all of which the schema as given accepts.
 *
 * An open object with no listed properties is refused. Anthropic could only
 * answer `{}` for it, which is not what a schema for any object asks for.
 *
 * Whether Anthropic accepts a schema whose whole is not an object is not
 * documented and has not been checked against the live API; one is sent as is.
 */
const fitted = (schema: Record<string, unknown>, at: string): object => {
  const dropped = Object.keys(bounds).filter(
    (keyword) =>
      Object.hasOwn(schema, keyword) && !enforced(keyword, schema[keyword]),
  );
  const { properties, description } = schema;
  const isObject = schema.type === "object" || isRecord(properties);
  const closed = schema.additionalProperties === false;
  if (isObject && !closed) {
    const listed = isRecord(properties) && Object.keys(properties).length > 0;
    if (!listed)
      throw new Error(
        `anthropic: cannot ask for an object with no listed properties (${at || "the whole answer"})`,
      );
  }
  if (dropped.length === 0 && (!isObject || closed)) return schema;
  const kept = Object.fromEntries(
    Object.entries(schema).filter(([keyword]) => !dropped.includes(keyword)),
  );
  const told = [
    ...(typeof description === "string" ? [description] : []),
    ...dropped.map((keyword) => bounds[keyword]!(schema[keyword])),
  ];
  return {
    ...kept,
    ...(dropped.length > 0 && { description: told.join(" ") }),
    ...(isObject && { additionalProperties: false }),
  };
};

/**
 * The provider's own `output_config`, with the shape a request asks for put in
 * as its format. The two share one object: the options may set `effort` there.
 * A shape on the request is used in place of a format in the options.
 */
const outputConfig = (
  config: Options["output_config"],
  shape: ShapeSpec | undefined,
): Options["output_config"] =>
  shape
    ? {
        ...config,
        // Built from the schema alone: the shape itself is never forwarded.
        format: {
          type: "json_schema",
          schema: fitSchema(
            shape.schema,
            fitted,
          ) as Anthropic.JSONOutputFormat["schema"],
        },
      }
    : config;

// Every stop reason the SDK knows, by name. When the SDK gains one, this stops
// compiling until it is given a meaning. One the SDK does not know yet arrives
// as "unknown", never as "stop".
const reasons: Record<Anthropic.StopReason, Reason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "refusal",
  pause_turn: "pause",
};
const reason = (stop: string | null): Reason =>
  stop !== null && Object.hasOwn(reasons, stop)
    ? reasons[stop as Anthropic.StopReason]
    : "unknown";

// Anthropic counts cached tokens apart from input_tokens; `input` here is all three.
const spent = (usage: Anthropic.Usage): Usage => {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    input: usage.input_tokens + cacheRead + cacheWrite,
    output: usage.output_tokens,
    cacheRead,
    cacheWrite,
  };
};

export const anthropic = (
  client: Anthropic,
  options: Options,
): Takes<AnthropicRequest, AnthropicOut> =>
  async function* ({ system, messages, tools, shape, signal }) {
    const stream = client.messages.stream(
      {
        ...options,
        output_config: outputConfig(options.output_config, shape),
        system: instructions(system),
        // Anthropic has no empty turn; one can be left after foreign parts are dropped.
        messages: fitToolIds(
          answerToolCalls(messages, unrun),
          fitsAnthropic,
          freshId,
        )
          .map(message)
          .filter((m) => m.content.length > 0),
        // An empty list is the same as none, and none is said by leaving the field out.
        tools: tools?.length
          ? tools.map(({ name, description, schema }) => ({
              name,
              description,
              input_schema: schema as Anthropic.Tool.InputSchema,
            }))
          : undefined,
      },
      { signal },
    );
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      )
        yield { type: "text", text: event.delta.text };
      // Thinking is told as it happens: that it has begun, then whatever of it
      // Anthropic shows, which is nothing unless a summary was asked for. The
      // block itself still arrives whole, below, as a native part.
      if (
        event.type === "content_block_start" &&
        (event.content_block.type === "thinking" ||
          event.content_block.type === "redacted_thinking")
      )
        yield { type: "reasoning", text: "" };
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "thinking_delta" &&
        event.delta.thinking !== ""
      )
        yield { type: "reasoning", text: event.delta.thinking };
      if (event.type === "content_block_stop") {
        const done = stream.currentMessage?.content[event.index];
        if (done?.type === "tool_use")
          yield {
            type: "tool_call",
            id: done.id,
            name: done.name,
            input: done.input,
          };
        else if (done && done.type !== "text")
          yield { type: "native", provider: "anthropic", value: done };
      }
    }
    // One End per turn, once the whole message is in, with what it cost.
    const { stop_reason, usage } = await stream.finalMessage();
    yield { type: "end", reason: reason(stop_reason), usage: spent(usage) };
  };
