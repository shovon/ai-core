// The only file that imports the Anthropic SDK.
import type Anthropic from "@anthropic-ai/sdk";
import {
  answerToolCalls,
  fitSchema,
  fitToolIds,
  isToolCall,
  toolResult,
  type End,
  type FilePart,
  type ModelMessage,
  type NativePart,
  type Part,
  type Reason,
  type ReasoningPart,
  type Request,
  type ShapeSpec,
  type SourcePart,
  type Takes,
  type TextPart,
  type ToolCall,
  type ToolInputPart,
  type ToolResult,
  type ToolSpec,
  type Usage,
  type UserMessage,
} from "@ai-patterns/core";

// The provider calls the SDK's beta namespace, and every SDK type here is that
// namespace's own. A request that names no beta is answered as it is on the
// stable one. One that names a beta, in its settings as `betas`, reaches what
// only that beta has.
//
// It is this namespace's stream that keeps a reply whole. The stable one joins
// only the pieces it knows: read from it, a call an MCP server ran arrives
// with its input missing, and nothing is thrown.

/**
 * What Anthropic's SDK is asked: the body `client.beta.messages.stream` takes.
 * It is the SDK's own type, so a field Anthropic adds later arrives with a
 * newer SDK.
 */
export type AnthropicBody = Parameters<
  Anthropic["beta"]["messages"]["stream"]
>[0];

// Anthropic's own blocks (thinking, server-tool results, ...) travel as native
// parts under this provider's name, so no other provider mistakes them for its own.
export type AnthropicBlock = Exclude<
  Anthropic.Beta.BetaContentBlock,
  Anthropic.Beta.BetaTextBlock | Anthropic.Beta.BetaToolUseBlock
>;
export type AnthropicNative = NativePart<"anthropic", AnthropicBlock>;
/**
 * A source as Anthropic cites one: the shared fields, and in its `details`,
 * under Anthropic's name, the citation as its API gave it, with the document,
 * pages or characters it points at.
 */
export type AnthropicSource = SourcePart & {
  details: { anthropic: Anthropic.Beta.BetaTextCitation };
};
/**
 * A call as Anthropic makes one: the shared fields, and in its `details`,
 * under Anthropic's name, what Anthropic said of the call besides.
 *
 * A call to a member of a toolset, such as the computer's `screenshot`, names
 * the toolset there. A toolset is one entry among the tools and has no name of
 * its own, so this is all that ties the call to it. It goes back to Anthropic
 * on the call and on the call's result. A call to any other tool has no entry.
 */
export type AnthropicToolCall = ToolCall & {
  details?: { anthropic?: { toolset_name?: string } };
};
export type AnthropicOut =
  | TextPart
  | AnthropicSource
  | ReasoningPart
  | ToolInputPart
  | AnthropicToolCall
  | AnthropicNative;

/**
 * Instructions for Anthropic alone, carried in a shared part's `settings`,
 * under Anthropic's name. They change cost, never meaning, so every other
 * provider ignores them. Read on the parts of a message itself and on the
 * parts of the system prompt, not on parts inside a tool result.
 */
export type AnthropicHints = {
  settings?: {
    anthropic?: {
      /** Cache the request up to and including this part. */
      cache_control?: Anthropic.Beta.BetaCacheControlEphemeral;
    };
  };
};

/**
 * Anthropic's own settings for a tool result, carried in the result's
 * `settings`, under Anthropic's name.
 *
 * `browser_state` is the browser as a call to a member of the browser toolset
 * left it: the open tabs, which one is active, and what the call changed. It
 * is the SDK's own block without its `type`, and is sent after the result's
 * other parts. Anthropic writes what the model reads from it. The result of
 * `list_tabs`, `new_tab`, `switch_tab` or `close_tab` is the state and nothing
 * else, so its `content` is empty.
 *
 * Every other provider ignores the entry and is given the result's content.
 */
export type AnthropicResultHints = {
  settings?: {
    anthropic?: {
      /** Cache the request up to and including this result. */
      cache_control?: Anthropic.Beta.BetaCacheControlEphemeral;
      browser_state?: Omit<Anthropic.Beta.BetaBrowserStateBlockParam, "type">;
    };
  };
};

/**
 * Anthropic's own settings for a file, carried in the file's `settings`, under
 * Anthropic's name: every one its API has for a document, such as `citations`,
 * `title`, `context` and `cache_control`. On a PDF or a text file they are
 * sent as they are. An image takes only `cache_control`, and the rest is not
 * read on one.
 *
 * Like any hint, they are read on a file in a message itself, not on one
 * inside a tool result. Every other provider ignores the entry and is given
 * the same file.
 */
export type AnthropicFileHints = {
  settings?: {
    anthropic?: Omit<
      Anthropic.Beta.BetaRequestDocumentBlock,
      "source" | "type"
    >;
  };
};

/**
 * What Anthropic said of a response besides its content: the message as its
 * API ended it, with everything but the content, and the id of the request
 * that made it. So it holds, among the rest, which stop sequence matched, why
 * a refusal was made, and usage as Anthropic counts it.
 *
 * It is the API's own object, kept as it came, so whatever Anthropic adds to
 * a message arrives here with a newer SDK and nothing else.
 */
export type AnthropicResponse = Omit<Anthropic.Beta.BetaMessage, "content"> & {
  /** The request's id, for Anthropic's support; null if the response did not carry one. */
  request_id: string | null;
};
/** The End of a turn from this provider: the shared End, and in its `details`, under Anthropic's name, Anthropic's own account of the response. */
export type AnthropicEnd = End & { details?: { anthropic: AnthropicResponse } };

/**
 * Any portable history, optionally with hints. Any provider's native parts are
 * accepted in a model turn; only Anthropic's own are sent.
 *
 * A turn this provider made holds Anthropic's account of the response in its
 * `details`, under Anthropic's name, where `append` put it. It is read here
 * and never sent.
 *
 * Any provider's sources are accepted in a model turn. Anthropic's own go back
 * as citations on the text they support; the rest are left out.
 *
 * A call may say, in its `details` under Anthropic's name, the toolset it
 * belongs to. That goes back on the call and on its result. A result may
 * carry, in its `settings`, the browser's state.
 */
export type AnthropicMessage =
  | UserMessage<(TextPart & AnthropicHints) | (FilePart & AnthropicFileHints)>
  | (ModelMessage<ModelPart> & { details?: { anthropic?: AnthropicResponse } })
  | { from: "tool"; content: readonly (ToolResult & AnthropicResultHints)[] };
type ModelPart =
  | ((TextPart | AnthropicToolCall) & AnthropicHints)
  | (FilePart & AnthropicFileHints)
  | (SourcePart & {
      details?: { anthropic?: Anthropic.Beta.BetaTextCitation };
    })
  | ReasoningPart
  | ToolInputPart
  | NativePart;

/**
 * Anthropic's own settings for a tool, carried in the tool's `settings`,
 * under Anthropic's name: every
 * one its API has for a tool you define, such as `cache_control`, `strict` and
 * `eager_input_streaming`. They are sent as they are. What the tool is, its
 * name, description and schema, is not among them and cannot be set here.
 *
 * Every other provider ignores the entry and is told the same tool.
 */
export type AnthropicToolHints = {
  settings?: {
    anthropic?: Omit<
      Anthropic.Beta.BetaTool,
      "name" | "description" | "input_schema" | "type"
    >;
  };
};
/** A tool, optionally with Anthropic's settings for it. */
export type AnthropicTool = ToolSpec & AnthropicToolHints;

/**
 * A tool Anthropic defines: web search, web fetch, code execution and tool
 * search, which Anthropic runs, and those you run, such as bash, the text
 * editor and memory. It is every tool the SDK knows but one you define, so a
 * tool Anthropic adds later arrives with a newer SDK.
 */
export type AnthropicOwnTool = Exclude<
  Anthropic.Beta.BetaToolUnion,
  Anthropic.Beta.BetaTool
>;

/**
 * Anthropic's own settings for a request: everything its API takes besides
 * what the request itself is. `model` and `max_tokens` have to be there, and
 * the rest, such as `output_config`, `stop_sequences`, `tool_choice` and
 * `thinking`, may be. It is the SDK's own type, so a setting Anthropic adds
 * later arrives with a newer SDK.
 *
 * What only a beta takes goes here too, such as `mcp_servers`, with the beta
 * named in `betas`. The SDK sends `betas` as a header, never in the body.
 *
 * `tools` there holds the tools Anthropic defines, and only those. They are
 * sent as they are, before the request's own tools. A tool you define is the
 * request's own: it goes in the request's `tools`, and where it has the name
 * of one here, it is the one sent.
 */
export type AnthropicSettings = Omit<
  AnthropicBody,
  "messages" | "system" | "tools" | "stream"
> & { tools?: readonly AnthropicOwnTool[] };

/**
 * A request as this provider takes one. Its system prompt, given as parts,
 * and its tools may carry hints too.
 *
 * It holds Anthropic's settings, in `settings` under Anthropic's name, and they
 * are sent as they are. The provider is made with none of its own: settings
 * are plain data, so the ones every request shares are filled in by whatever
 * builds the request.
 */
export type AnthropicRequest = Request<
  AnthropicMessage,
  TextPart & AnthropicHints,
  AnthropicTool
> & { settings: { anthropic: AnthropicSettings } };

const unsendable = (part: Part) =>
  new Error(`anthropic: cannot send a "${part.type}" part`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

// Anthropic takes a text document as the text itself, never as base64 or by link.
const plainText = (part: FilePart): Anthropic.Beta.BetaPlainTextSource => {
  const from = source(part);
  if (from.type === "url")
    throw new Error("anthropic: cannot send a text/plain file by link");
  const bytes = Uint8Array.from(atob(from.data), (c) => c.charCodeAt(0));
  return {
    type: "text",
    media_type: "text/plain",
    data: new TextDecoder().decode(bytes),
  };
};

/**
 * A file as Anthropic takes it: an image, or a document. `settings` is what
 * the file's hint says, if it is read where the file sits. A document's
 * settings are addressed to Anthropic by name, so they go as they are; what
 * the document is comes after, so nothing there can replace it.
 */
const fileBlock = (
  part: FilePart,
  settings?: NonNullable<AnthropicFileHints["settings"]>["anthropic"],
):
  | Anthropic.Beta.BetaImageBlockParam
  | Anthropic.Beta.BetaRequestDocumentBlock => {
  const { mediaType } = part;
  if (isImage(mediaType)) {
    const from = source(part);
    return {
      type: "image",
      source: from.type === "url" ? from : { ...from, media_type: mediaType },
      cache_control: settings?.cache_control,
    };
  }
  if (mediaType === "application/pdf") {
    const from = source(part);
    return {
      ...settings,
      type: "document",
      source: from.type === "url" ? from : { ...from, media_type: mediaType },
    };
  }
  if (mediaType === "text/plain")
    return { ...settings, type: "document", source: plainText(part) };
  throw new Error(`anthropic: cannot send a ${mediaType} file`);
};

// One translator per origin, because each origin allows different parts.
// A part none of them recognises is an error here, never forwarded to the API.

/** The one hint read on a part that is not a file. Nothing else in the entry is forwarded. */
const cache = (part: AnthropicHints) =>
  part.settings?.anthropic?.cache_control;

/** A part of a tool result. No hint is read here. */
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

/** A part of a user message, with what its hint says. */
const given = (
  part: (TextPart & AnthropicHints) | (FilePart & AnthropicFileHints),
) => {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text,
        cache_control: cache(part),
      } as const;
    case "file":
      return fileBlock(part, part.settings?.anthropic);
    default:
      throw unsendable(part);
  }
};

// The name is the only evidence a stored native part offers about its value.
const isOwn = (part: NativePart): part is AnthropicNative =>
  part.provider === "anthropic";

// The toolset a call belongs to, as Anthropic said when it made the call. A
// history may come from storage, written by anything, so it is read with care:
// a name that is no string is no name.
const toolsetOf = (call: ToolCall): string | undefined => {
  const said = call.details?.anthropic;
  return isRecord(said) && typeof said.toolset_name === "string"
    ? said.toolset_name
    : undefined;
};

/**
 * The toolset of each call in a history that has one, by the call's id. A
 * result holds the id of its call and no more, and Anthropic takes a toolset's
 * name on a call and its result together or on neither. So a result's is read
 * from its call, here, and the caller writes it nowhere.
 */
const toolsets = (
  messages: readonly AnthropicMessage[],
): ReadonlyMap<string, string> =>
  new Map(
    messages.flatMap((m) =>
      m.from === "model"
        ? m.content.filter(isToolCall).flatMap((call) => {
            const toolset = toolsetOf(call);
            return toolset === undefined ? [] : [[call.id, toolset] as const];
          })
        : [],
    ),
  );

/**
 * A model-turn part as Anthropic takes it back, where that depends on the part
 * alone. Another provider's native part is left out. A source depends on the
 * text before it, and is put back by `turn`.
 */
const echoed = (
  part: Exclude<ModelPart, SourcePart>,
): Anthropic.Beta.BetaContentBlockParam[] => {
  switch (part.type) {
    // A file a model made, in another provider's turn: Claude writes none
    // into its own. It goes as a file does anywhere, and whether one may sit
    // in a model turn is Anthropic's to say.
    case "file":
      return [fileBlock(part, part.settings?.anthropic)];
    // Shown, never sent. The thinking block itself goes back as a native part.
    case "reasoning":
      return [];
    // Shown, never sent. It is the input of a call that never arrived.
    case "tool_input":
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
          toolset_name: toolsetOf(part),
          cache_control: cache(part),
        },
      ];
    case "native":
      return isOwn(part) ? [part.value] : [];
    default:
      throw unsendable(part);
  }
};

/**
 * A model turn as Anthropic takes it back. A source of Anthropic's own goes
 * back as a citation on the text it supports, which is the text block before
 * it: all of it, or only its last `span` characters when that text had joined
 * text the source says nothing of. Another provider's source is left out, and
 * so is one with no text before it.
 */
const turn = (
  content: readonly ModelPart[],
): Anthropic.Beta.BetaContentBlockParam[] =>
  content.reduce<Anthropic.Beta.BetaContentBlockParam[]>((blocks, part) => {
    if (part.type !== "source") return [...blocks, ...echoed(part)];
    // The name is the only evidence a stored source offers about whose it is.
    const citation = part.details?.anthropic;
    const last = blocks.at(-1);
    if (!citation || last?.type !== "text") return blocks;
    const before = blocks.slice(0, -1);
    const span = part.span ?? last.text.length;
    if (!last.citations && span > 0 && span < last.text.length) {
      // A cache breakpoint is up to and including its part, so it stays on the end.
      const { cache_control, ...uncited } = last;
      return [
        ...before,
        { ...uncited, text: last.text.slice(0, -span) },
        { ...last, text: last.text.slice(-span), citations: [citation] },
      ];
    }
    return [
      ...before,
      { ...last, citations: [...(last.citations ?? []), citation] },
    ];
  }, []);

/**
 * A tool result as Anthropic takes it. `toolset` is the toolset of the call it
 * answers, if that call has one. The browser's state is addressed to Anthropic
 * by name, so it goes as it is, after the result's other parts; what the block
 * is comes after, so nothing there can replace it.
 */
const answered = (
  part: ToolResult & AnthropicResultHints,
  toolset: string | undefined,
): Anthropic.Beta.BetaToolResultBlockParam => {
  const state = part.settings?.anthropic?.browser_state;
  return {
    type: "tool_result",
    tool_use_id: part.id,
    toolset_name: toolset,
    is_error: part.error,
    content: [
      ...part.content.map(block),
      ...(state ? [{ ...state, type: "browser_state" } as const] : []),
    ],
    cache_control: cache(part),
  };
};

const message = (
  m: AnthropicMessage,
  toolsetOfCall: ReadonlyMap<string, string>,
):
  | Anthropic.Beta.BetaUserMessageParam
  | Anthropic.Beta.BetaAssistantMessageParam => {
  switch (m.from) {
    case "user":
      return { role: "user", content: m.content.map(given) };
    case "model":
      return { role: "assistant", content: turn(m.content) };
    case "tool":
      return {
        role: "user",
        content: m.content.map((part) =>
          answered(part, toolsetOfCall.get(part.id)),
        ),
      };
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
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [];
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
 * Anthropic's settings for a request. The name is the only evidence a request
 * offers about whose settings they are. A request may come from storage, or
 * from code that knows nothing of Anthropic, so one with no settings is
 * refused here: there is no model to send it to.
 */
const settingsOf = (
  settings: { readonly [provider: string]: unknown } | undefined,
): AnthropicSettings => {
  const own = settings?.anthropic;
  if (!isRecord(own))
    throw new Error(
      "anthropic: a request needs Anthropic's settings, in settings.anthropic: a model and max_tokens at least",
    );
  return own as AnthropicSettings;
};

/**
 * The tools Anthropic defines, as a request's settings give them. They are
 * addressed to Anthropic by name, so each goes as it is. The settings may come
 * from storage, so what is there is checked for the one thing that would
 * change what the request is: a tool of the caller's own, which has no `type`
 * or the type "custom", is refused, and so is anything that is no tool at all.
 */
const ownTools = (given: unknown): AnthropicOwnTool[] => {
  if (given === undefined) return [];
  if (!Array.isArray(given))
    throw new Error("anthropic: settings.anthropic.tools has to be a list");
  return given.map((tool: unknown) => {
    if (isRecord(tool) && typeof tool.type === "string" && tool.type !== "custom")
      return tool as unknown as AnthropicOwnTool;
    const named =
      isRecord(tool) && typeof tool.name === "string" ? ` "${tool.name}"` : "";
    throw new Error(
      `anthropic: settings.anthropic.tools holds only tools Anthropic defines; a tool of your own${named} goes in the request's tools`,
    );
  });
};

/**
 * The tools a request is sent with: Anthropic's own from the settings, then
 * the request's, each in the order given, so the list is the same every time.
 * Where one of each has the same name, the request's is the one sent: what the
 * request says comes after the settings, so nothing there can replace it.
 *
 * A request tool's settings for Anthropic are addressed to it by name, so they
 * go as they are. What the tool is comes after, for the same reason.
 *
 * No tools at all is said by leaving the field out, as an empty list is.
 */
const toolsSent = (
  theirs: readonly AnthropicOwnTool[],
  yours: readonly AnthropicTool[] = [],
): Anthropic.Beta.BetaToolUnion[] | undefined => {
  const taken = new Set(yours.map((tool) => tool.name));
  const sent: Anthropic.Beta.BetaToolUnion[] = [
    ...theirs.filter((tool) => !("name" in tool && taken.has(tool.name))),
    ...yours.map(({ name, description, schema, settings }) => ({
      ...settings?.anthropic,
      name,
      description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    })),
  ];
  return sent.length > 0 ? sent : undefined;
};

/**
 * The `output_config` a request is sent with, with the shape it asks for put
 * in as its format. The two share one object: the settings may hold `effort`
 * there. A shape on the request is used in place of a format in the settings.
 */
const outputConfig = (
  config: AnthropicSettings["output_config"],
  shape: ShapeSpec | undefined,
): AnthropicSettings["output_config"] =>
  shape
    ? {
        ...config,
        // Built from the schema alone: the shape itself is never forwarded.
        format: {
          type: "json_schema",
          schema: fitSchema(
            shape.schema,
            fitted,
          ) as Anthropic.Beta.BetaJSONOutputFormat["schema"],
        },
      }
    : config;

// Every stop reason the SDK knows, by name. When the SDK gains one, this stops
// compiling until it is given a meaning. One the SDK does not know yet arrives
// as "unknown", never as "stop".
const reasons: Record<Anthropic.Beta.BetaStopReason, Reason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "refusal",
  pause_turn: "pause",
  // The reply to a request to summarise a conversation. It holds the summary
  // and no answer, and the library has no name for that.
  compaction: "unknown",
};
const reason = (stop: string | null): Reason =>
  stop !== null && Object.hasOwn(reasons, stop)
    ? reasons[stop as Anthropic.Beta.BetaStopReason]
    : "unknown";

// A citation as a source: what every provider can say of one, and Anthropic's
// own citation in its `details`, under Anthropic's name. `span` is the length
// of the text block it was on.
const cited = (
  citation: Anthropic.Beta.BetaTextCitation,
  span: number,
): AnthropicSource => {
  const title =
    "document_title" in citation ? citation.document_title : citation.title;
  return {
    type: "source",
    span,
    quote: citation.cited_text,
    ...(title != null && { title }),
    ...("url" in citation && { url: citation.url }),
    details: { anthropic: citation },
  };
};

// The same value as plain JSON. The SDK leaves fields it was not sent as
// undefined, and a history has to come back equal from JSON.stringify and JSON.parse.
const plain = <T extends object>(value: T): T =>
  JSON.parse(JSON.stringify(value));

// Anthropic counts cached tokens apart from input_tokens; `input` here is all three.
// Thinking is counted within output_tokens, and told apart only when Anthropic says how much it was.
const spent = (usage: Anthropic.Beta.BetaUsage): Usage => {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const details = usage.output_tokens_details;
  return {
    input: usage.input_tokens + cacheRead + cacheWrite,
    output: usage.output_tokens,
    cacheRead,
    cacheWrite,
    ...(details && { reasoning: details.thinking_tokens }),
  };
};

/**
 * What Anthropic's SDK is asked, made from a request: the first half of the
 * provider. It is what `client.beta.messages.stream` takes as its body.
 *
 * The settings are addressed to Anthropic by name, so they go as they are.
 * What the request is comes after, so nothing there can replace it. A request's
 * `signal` is no part of this: it is one of the SDK's request options, beside
 * the body.
 */
export const params = ({
  system,
  messages,
  tools,
  shape,
  settings,
}: AnthropicRequest): AnthropicBody => {
  const { tools: theirs, ...own } = settingsOf(settings);
  const history = fitToolIds(
    answerToolCalls(messages, unrun),
    fitsAnthropic,
    freshId,
  );
  // Read once the ids are the ones sent, so a result still finds its call.
  const toolsetOfCall = toolsets(history);
  return {
    ...own,
    output_config: outputConfig(own.output_config, shape),
    system: instructions(system),
    // Anthropic has no empty turn; one can be left after foreign parts are dropped.
    messages: history
      .map((m) => message(m, toolsetOfCall))
      .filter((m) => m.content.length > 0),
    tools: toolsSent(ownTools(theirs), tools),
  };
};

/**
 * What `read` needs of the SDK's stream: its events, the message as far as it
 * has come, the message once it is whole, and the id of the request. What
 * `client.beta.messages.stream` returns is one, and so is anything else with
 * these.
 *
 * The stable namespace's stream is not one: its events are another type. It
 * joins only the pieces it knows, so a reply that holds a beta's block would
 * come out of it incomplete.
 */
export type AnthropicStream =
  AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
    readonly currentMessage: Anthropic.Beta.BetaMessage | undefined;
    finalMessage(): Promise<
      Anthropic.Beta.BetaMessage & { parsed_output?: unknown }
    >;
    readonly request_id: string | null | undefined;
  };

/**
 * The library's parts, read from the SDK's stream: the second half of the
 * provider. One turn, closed by one End.
 *
 * It takes nothing from the stream that a listener on it would miss. So a
 * caller who makes the call, and keeps hold of the stream, reaches what is not
 * passed on here: every event as Anthropic sent it, and the response.
 */
export const read = async function* (
  stream: AnthropicStream,
): AsyncIterable<AnthropicOut | AnthropicEnd> {
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
    // A call is told as it is written: that it has begun, then each piece
    // of its input as Anthropic sends it. The call itself still arrives
    // whole, below, directly after its pieces, and takes their place.
    if (
      event.type === "content_block_start" &&
      event.content_block.type === "tool_use"
    )
      yield {
        type: "tool_input",
        id: event.content_block.id,
        name: event.content_block.name,
        text: "",
      };
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "input_json_delta" &&
      event.delta.partial_json !== ""
    ) {
      const writing = stream.currentMessage?.content[event.index];
      if (writing?.type === "tool_use")
        yield {
          type: "tool_input",
          id: writing.id,
          name: writing.name,
          text: event.delta.partial_json,
        };
    }
    if (event.type === "content_block_stop") {
      const done = stream.currentMessage?.content[event.index];
      // A call to a member of a toolset says which toolset, and it is kept:
      // Anthropic takes it back on the call and on the call's result.
      if (done?.type === "tool_use")
        yield {
          type: "tool_call",
          id: done.id,
          name: done.name,
          input: done.input,
          ...(done.toolset_name && {
            details: { anthropic: { toolset_name: done.toolset_name } },
          }),
        };
      // The passages a text block rests on are told once it is whole,
      // directly after its text, each saying how much text is its own.
      else if (done?.type === "text")
        for (const citation of done.citations ?? [])
          yield cited(citation, done.text.length);
      else if (done)
        yield { type: "native", provider: "anthropic", value: done };
    }
  }
  // One End per turn, once the whole message is in: why it ended, what it
  // cost, and the message itself without its content, as Anthropic's account
  // of it. `parsed_output` is the SDK's own reading of that content, so it goes too.
  const { content, parsed_output, ...ended } = await stream.finalMessage();
  const end: AnthropicEnd = {
    type: "end",
    reason: reason(ended.stop_reason),
    usage: spent(ended.usage),
    id: ended.id,
    model: ended.model,
    details: {
      anthropic: plain({ ...ended, request_id: stream.request_id ?? null }),
    },
  };
  yield end;
};

/**
 * Anthropic's API behind the library's one port. It is made with a client and
 * nothing else: which model answers, and how, is said by each request.
 *
 * It is `params` and `read` put together, around the SDK's call. The SDK sends
 * a request when its stream is made. This sends nothing until its own stream is
 * first read, which is why it is a generator and not the two put end to end.
 */
export const anthropic = (
  client: Anthropic,
): Takes<AnthropicRequest, AnthropicOut> =>
  async function* (request) {
    yield* read(
      client.beta.messages.stream(params(request), { signal: request.signal }),
    );
  };
