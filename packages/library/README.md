# @ai-agent-library/library

Plain values and functions for talking to a model. A conversation is an array you own, a provider is a function that streams a reply, and an agent is a `for` loop you write. Nothing here has dependencies, and nothing here needs the library to be read back: a history is plain JSON.

## Setup

The packages are TypeScript source with no build step, so run them with a Node that executes TypeScript directly, or through a bundler. Inside this workspace, add them to a package's dependencies as `"*"`.

A provider comes from `@ai-agent-library/providers`, one import per vendor. You install the vendor's SDK yourself and hand the provider a client.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, type AnthropicRequest, type AnthropicSettings } from "@ai-agent-library/providers/anthropic";

const claude = anthropic(new Anthropic());
```

A client is all a provider is made with. Which model answers, and how, is said by each request, in `native` under the provider's name. Settings are plain data, so the ones every request shares are filled in by a function of your own:

```ts
const opus = { model: "claude-opus-5-5", max_tokens: 64000 } satisfies AnthropicSettings;

const provider = (request: Omit<AnthropicRequest, "native">) =>
  claude({ ...request, native: { anthropic: opus } });
```

The examples below call this `provider`. The settings are anything Anthropic's `messages.stream` accepts, except `messages`, `system` and `tools`, which are the request's own. See [Settings](#settings).

## Ask once

```ts
import { text, user } from "@ai-agent-library/library";

const answer = await text(provider({ messages: [user("Write a haiku about rain.")] }));
```

`user` makes a message from a bare string. `text` reads the stream to its end and returns the answer. It throws unless the model finished, so a reply that was cut off or refused never comes back looking like an answer.

A request can also carry standing instructions:

```ts
import { text, user } from "@ai-agent-library/library";

const answer = await text(provider({ system: "Answer in French.", messages: [user("Hello.")] }));
```

## Stream

A provider returns an async iterable. Text arrives in pieces; print each as it comes.

```ts
import { isText, user } from "@ai-agent-library/library";

for await (const chunk of provider({ messages: [user("Tell me a story.")] })) {
  if (isText(chunk)) process.stdout.write(chunk.text);
}
```

To show a reply while it grows, fold the chunks with `append`. It is pure: each call returns a new reply, and a turn still arriving has no `end` yet.

```ts
import { append, user, type Reply } from "@ai-agent-library/library";
import type { AnthropicOut } from "@ai-agent-library/providers/anthropic";

let reply: Reply<AnthropicOut> = [];
for await (const chunk of provider({ messages: [user("Tell me a story.")] })) {
  reply = append(reply, chunk);
  // render `reply` here
}
```

`collect` is the same fold run to the end: it returns every message the stream produced.

A provider may also tell of a tool call while the model is still writing it. The input then arrives as `tool_input` parts, and `isToolInput` picks them out.

```ts
import { isText, isToolInput, user } from "@ai-agent-library/library";

for await (const chunk of provider({ messages: [user("What does package.json depend on?")], tools })) {
  if (isText(chunk)) process.stdout.write(chunk.text);
  if (isToolInput(chunk)) process.stdout.write(chunk.text === "" ? `\n${chunk.name}: ` : chunk.text);
}
```

- Each piece carries the id and name of its call, and a piece of the input's JSON text. The first has no text: it says only that the call has begun.
- The text so far is a beginning of JSON and need not be JSON itself. It is for showing, and `partial` reads what it holds so far (see [Read JSON as it is written](#read-json-as-it-is-written)).
- The call still arrives whole, directly after its pieces. It is the call that is run.
- `append` joins the pieces of one call into one part, and the call takes that part's place when it arrives. So `collect` returns the same history whether a provider tells of the input or not.
- A stream that stops in the middle of a call leaves its input behind in the turn. Kept in a history, it is shown and never sent.

The Anthropic provider does this for every tool you define. Anthropic may hold a call's input back and send it in a few large pieces; to have it sent as the model writes it, set `eager_input_streaming` on the tool:

```ts
const writeFileTool = {
  name: "write_file",
  description: "Write a UTF-8 text file.",
  schema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
  anthropic: { eager_input_streaming: true },
} as const satisfies AnthropicTool;
```

## Keep a conversation

The history is an array of messages, and it is the whole state. To continue, add to it and call again.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { collect, user } from "@ai-agent-library/library";
import type { AnthropicMessage } from "@ai-agent-library/providers/anthropic";

const messages: AnthropicMessage[] = [user("My name is Ada.")];
messages.push(...(await collect(provider({ messages }))));
messages.push(user("What is my name?"));
messages.push(...(await collect(provider({ messages }))));

// Storing a history is JSON.stringify; loading it is JSON.parse.
await writeFile("thread.json", JSON.stringify(messages));
const loaded: AnthropicMessage[] = JSON.parse(await readFile("thread.json", "utf8"));
```

A message is from `"user"`, `"model"` or `"tool"`, and who it is from decides what it may contain. A model message records why its turn ended (`end`), what it cost (`usage`), and what the provider said of the response (`id`, `model` and more).

## Give the model tools

To the library, a tool is plain data: a name, a description and a JSON Schema for its input. That is what the model is told. What a call does is your code. The library never runs a tool.

```ts
import type { ToolSpec } from "@ai-agent-library/library";

const readFileTool = {
  name: "read_file",
  description: "Read a UTF-8 text file.",
  schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const satisfies ToolSpec;
const tools = [readFileTool];
```

When the model calls one, `parse(schema, call.input)` reads the call's input. The one schema is told to the model, types what `parse` returns, and is what the input is checked against.

- It throws unless the input fits the schema, naming everything wrong with it. Given to the model as an error result, that lets it correct the call.
- The schema may use `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems` and `maxItems`. Any other keyword that asserts something is a mistake in the schema, because it would be told to the model and never enforced. `parse` then throws a schema error whatever the input, and `isSchemaError` tells it from what a model got wrong.
- A schema held in a variable needs `as const` to type the input, as above.
- For a schema outside that subset, check the input your own way.

## The loop

There is no agent loop in the library. A loop is the same call made again with a longer history, and running the tools is part of it:

```ts
import { readFile } from "node:fs/promises";
import {
  collect,
  isSchemaError,
  isText,
  parse,
  pendingToolCalls,
  toolFailure,
  toolResult,
  user,
  type ToolCall,
  type ToolResult,
} from "@ai-agent-library/library";
import type { AnthropicMessage } from "@ai-agent-library/providers/anthropic";

// What each call does: a switch here, but a table of functions or a queue would do.
const run = async (call: ToolCall) => {
  switch (call.name) {
    case "read_file":
      return readFile(parse(readFileTool.schema, call.input).path, "utf8");
    default:
      throw new Error(`unknown tool: ${call.name}`);
  }
};

// The result of one call. What was thrown becomes an error the model reads,
// unless it is a mistake in a schema of yours, which the model can do nothing about.
const answer = async (call: ToolCall): Promise<ToolResult> => {
  try {
    return toolResult(call, await run(call));
  } catch (error) {
    if (isSchemaError(error)) throw error;
    return toolFailure(call, error);
  }
};

const messages: AnthropicMessage[] = [user("What does package.json depend on?")];

for (;;) {
  messages.push(...(await collect(provider({ messages, tools }))));
  const last = messages.at(-1);
  if (last?.from === "model" && last.end === "pause") continue;
  const calls = pendingToolCalls(messages);
  if (calls.length === 0) break;
  messages.push({ from: "tool", content: await Promise.all(calls.map(answer)) });
}

const final = messages.at(-1);
if (final?.from !== "model" || final.end !== "stop") throw new Error("the run did not end on an answer");
console.log(final.content.filter(isText).map((part) => part.text).join(""));
```

- `pendingToolCalls` returns the tool calls in a final, finished model turn. When it returns none, the loop is over.
- `toolResult` makes the result of a call from a string, or from text and file parts in order. `toolFailure` makes an error result from whatever was thrown, in the thrower's own words.
- Here a missing tool, bad input and a thrown error all become an error result the model reads, so the loop keeps going. A schema the library cannot enforce stops it. Both are `answer`'s choice, and so yours.
- A paused turn is unfinished and asks for nothing: it goes back as it is.
- The loop also ends on a turn that was cut off or refused. Only `end === "stop"` means there is an answer, so check it after the loop.

## How a turn ends

| `end` | Meaning | What to do |
|---|---|---|
| `stop` | The model finished its turn. | Run its tool calls if it made any; otherwise this is the answer. |
| `pause` | Unfinished, and nothing is wrong. | Send the history back unchanged. |
| `length` | Cut off by a limit. | Not an answer. Its tool calls are never run. |
| `refusal` | The model declined. | Not an answer. |
| `unknown` | The provider gave a reason the library has no name for. | Not an answer. |

A history may hold tool calls that were never answered, from a turn that was cut off or a call you chose not to run. The provider gives each of them a result on the way out; the history keeps what happened.

## Change the loop

Every policy is an edit to those few lines.

Stop after so many requests:

```ts
for (let requests = 0; ; requests++) {
  if (requests >= 20) throw new Error("gave up after 20 requests");
  // ...the same body
}
```

Ask before a call runs, and run calls one at a time:

```ts
const results: ToolResult[] = [];
for (const call of calls) {
  const allowed = call.name !== "delete_file" || (await confirm(call));
  results.push(allowed ? await answer(call) : toolResult(call, "The user said no.", { error: true }));
}
messages.push({ from: "tool", content: results });
```

See a failure before the model does, and let a mistake in your own code stop the loop:

```ts
const answer = async (call: ToolCall): Promise<ToolResult> => {
  try {
    return toolResult(call, await run(call));
  } catch (error) {
    console.error(call.name, error);
    if (isSchemaError(error) || error instanceof TypeError) throw error;
    return toolFailure(call, error);
  }
};
```

## Structured outputs

To get the answer as JSON that fits a schema, which vendors call structured outputs, put the schema on the request as `shape`. It is plain data. The answer comes back as text: `JSON.parse` reads it, and `parse(schema, value)`, the same function that reads a tool call's input, checks it and types it. The one schema is told to the model, types what `parse` returns, and is what the answer is checked against.

```ts
import { parse, text, user } from "@ai-agent-library/library";

const triage = {
  type: "object",
  properties: {
    category: { enum: ["billing", "bug", "other"] },
    urgent: { type: "boolean" },
    orderId: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["category", "urgent", "orderId"],
  additionalProperties: false,
} as const;

const ticket = parse(
  triage,
  JSON.parse(await text(provider({ system: "Triage the support ticket.", messages: [user(email)], shape: { schema: triage } }))),
);
// ticket: { category: "billing" | "bug" | "other"; urgent: boolean; orderId: string | null }
```

- The answer is ordinary text that happens to be JSON. It streams, ends and is stored like any other answer, so one from a stored history reads just the same.
- `parse` throws unless the value fits the schema as you wrote it, and the error names everything wrong. Text that is not JSON throws from `JSON.parse` before that. Sending either back to the model and asking again is your loop.
- `parse` is exact about `null`: where the schema does not accept one, it is wrong.
- The schema uses the same keywords as a tool's, and needs `as const` to type the answer. Any other keyword that asserts something makes `parse` throw a schema error, whatever the answer.
- A shape and tools go in one request. The model calls its tools first, and its final answer is the JSON.
- A call can fail in three places. The stream throws if the request fails or the provider cannot ask for the schema, `text` throws if the turn did not finish, and `JSON.parse` or `parse` throws if the answer is not JSON or does not fit.

Vendors take different schemas. One written this way can be asked of any of them:

- The whole answer is an object.
- Every object lists its properties and is closed with `additionalProperties: false`.
- Every property is required. One that may be missing is itself or `null`, like `orderId` above.

Nothing enforces that style. Each provider sends what its vendor takes and refuses the rest with an error that says where. The Anthropic provider:

- Leaves out `minimum`, `maximum`, `minLength`, `maxLength`, `maxItems` and a `minItems` above 1, which Anthropic does not enforce, and says each in the schema's description so the model is still told. `parse` still checks them.
- Closes every object, as Anthropic requires. The model then writes only the properties you listed.
- Refuses an open object with no listed properties, because Anthropic could only answer `{}` for it.

## Read JSON as it is written

A tool call's input and an answer asked for in a shape both arrive as the text of a JSON document, a piece at a time. `partial` reads what the text holds so far, where `JSON.parse` would throw until the last piece.

```ts
import { isText, partial, user } from "@ai-agent-library/library";

let written = "";
for await (const chunk of provider({ messages: [user(email)], shape: { schema: triage } })) {
  if (!isText(chunk)) continue;
  written += chunk.text;
  render(partial(written)); // {} then { category: "bil" } then { category: "billing", urgent: true } ...
}
const ticket = parse(triage, JSON.parse(written));
```

For a tool call, fold the stream with `append` and read the one `tool_input` part as it grows:

```ts
import { append, isToolInput, partial, type Reply } from "@ai-agent-library/library";

let reply: Reply<AnthropicOut> = [];
for await (const chunk of provider({ messages, tools })) {
  reply = append(reply, chunk);
  const part = reply.at(-1)?.content.at(-1);
  if (part && isToolInput(part)) render(part.name, partial(part.text)); // { path: "rain.txt", text: "Soft rain on" }
}
```

- A whole document reads exactly as `JSON.parse` reads it.
- A string still being written is there as far as it goes. Anything else unfinished is left out until it is whole: a property with no value yet, a number that may gain digits, half of `true`. With nothing to read yet, the value is `undefined`.
- It only grows. As text arrives, strings get longer and objects and arrays gain entries; nothing already there changes or goes away. The one exception is a document that is a bare number, which is read as it stands.
- Text that no JSON document begins with throws a `SyntaxError`, as `JSON.parse` does.
- The value is `unknown`. Nothing checks it against a schema, and it may lack what the finished value must have. It is for showing: the finished text is still read with `JSON.parse` and `parse`.
- It reads the text from its start each time. That is quick, but for a very long document read it less often than every piece.

## Files

`file` makes a part from bytes or from a link. Bytes are kept as base64, so the part stays plain JSON.

```ts
import { readFile } from "node:fs/promises";
import { file, text, user } from "@ai-agent-library/library";

const seen = await text(provider({ messages: [user("What is in this picture?", file("image/png", await readFile("cat.png")))] }));
```

The Anthropic provider sends JPEG, PNG, GIF and WebP images, PDFs and plain text files. Any other type is an error, never a silent drop. A text file goes as the text itself, so it cannot be given by link.

A file may carry Anthropic's own settings for it, in a field under Anthropic's name: every one its API has for a document, such as `citations`, `title`, `context` and `cache_control`. On a PDF or a text file they are sent as they are. An image takes only `cache_control`.

### A link the provider cannot follow

A file given by link is fetched by the vendor, not by you. That fails when the link is private, local or needs credentials, and some files cannot be given by link at all: Anthropic takes a text file only as its text. The library does no fetching. Fetch the file yourself and give its bytes:

```ts
import { file, user, type FilePart, type TextPart, type UserMessage } from "@ai-agent-library/library";

// A linked file as its bytes. Everything else about the part is kept, a hint included.
const fetched = async (part: FilePart & { url: string }, get: typeof fetch): Promise<FilePart> => {
  const response = await get(part.url);
  if (!response.ok) throw new Error(`could not fetch ${part.url}: ${response.status}`);
  const { url, ...rest } = part;
  return { ...rest, ...file(part.mediaType, new Uint8Array(await response.arrayBuffer())) };
};

// A user message with every linked file fetched.
const inlined = async (
  message: UserMessage<TextPart | FilePart>,
  get: typeof fetch = fetch,
): Promise<UserMessage<TextPart | FilePart>> => ({
  ...message,
  content: await Promise.all(
    message.content.map((part) => (part.type === "file" && "url" in part ? fetched(part, get) : part)),
  ),
});

messages.push(await inlined(user(file("application/pdf", new URL("http://localhost:8080/report.pdf")), "Summarise.")));
```

- Done once, as here, the history holds the bytes: it is larger, and the file is fetched one time.
- To keep the link in the history, do the same to a copy of the messages each time you call the provider. The history stays small and the file is fetched on every request.
- `get` is whatever fetches for you, so it can add credentials, and a test can pass a fake.

### Files a model makes

A model turn may hold a file too, where a provider's model makes one, such as an image it drew. It arrives whole, as a `file` part among the turn's other parts, and a portable history keeps it.

- Claude does not write files into its turns, so the Anthropic provider never yields one.
- Handed a history in which another model did, the Anthropic provider sends the file as it sends any other. Whether a file may sit in a model turn is Anthropic's to say, and its API's error is what tells you.

## Sources

A model can say where its words came from. Such a source is a part of the turn, directly after the text it supports.

With Anthropic, a document is cited only if it was sent with citations switched on:

```ts
import { readFile } from "node:fs/promises";
import { collect, file, isSource, isText, user } from "@ai-agent-library/library";
import type { AnthropicMessage } from "@ai-agent-library/providers/anthropic";

const report = {
  ...file("application/pdf", await readFile("report.pdf")),
  anthropic: { citations: { enabled: true }, title: "Q3 report" },
};
const messages: AnthropicMessage[] = [user(report, "What drove the margin change?")];
messages.push(...(await collect(provider({ messages }))));
```

The turn then reads:

```ts
[
  { type: "text", text: "Margins fell, mainly on freight." },
  { type: "source", span: 18, quote: "Freight expense rose 31%.", title: "Q3 report", anthropic: { type: "page_location", start_page_number: 4, /* … */ } },
  { type: "text", text: " Pricing was flat." },
]
```

- A source belongs to the text directly before it. Several in a row all support that same text.
- `span` says how much of that text: its last `span` characters, counted as a string's `length` counts them. Here that is `"mainly on freight."`. Text joins whatever text came before it, so the part before a source may begin with words the source says nothing of. With no `span`, a source speaks for the whole text part before it.
- `quote` is the passage relied on, `title` what it is from, and `url` where that is, when it is on the web. `isSource` picks a source out.
- Whatever else a provider knows is in a field under its name. With Anthropic it is the citation as its API gave it: the document, and the pages or characters cited.
- A source is no part of the answer: `text` leaves it out.
- The Anthropic provider sends its own sources back, as citations on the passage they support, and leaves out every other provider's.

To show them, walk the turn:

```ts
for (const [i, part] of turn.content.entries()) {
  if (isText(part)) write(part.text);
  if (isSource(part)) footnote(part.title, part.quote); // supports the end of the text just before it
}
```

## Reasoning and cost

- A `reasoning` part is what the model says of its own working. It is for showing and is never sent back; `isReasoning` picks it out. With Anthropic, put `thinking: { type: "adaptive", display: "summarized" }` in its settings to receive its text.
- `totalUsage(messages)` adds up what the model turns in a history cost: `input`, `output`, `cacheRead`, `cacheWrite` and `reasoning` tokens.
- `reasoning` is the part of `output` spent reasoning, never a count beside it. A turn carries it only when the provider says how much it was; in a total, a turn that does not say counts as none.
- What a provider counts beyond these is in its own account of the response, under its name on the turn. With Anthropic that is `turn.anthropic?.usage`: the cache split by lifetime, server tool requests, the service tier.

## What the provider said of a response

A finished model turn also holds what the provider said of the response that made it.

```ts
const messages: AnthropicMessage[] = [user("Count to three.")];
messages.push(...(await collect(provider({ messages }))));

const turn = messages.at(-1);
if (turn?.from === "model") {
  turn.id; // "msg_01…": the provider's name for this response
  turn.model; // the model that answered, as the provider names it
  turn.anthropic?.request_id; // the request's id, to quote to Anthropic
  turn.anthropic?.stop_sequence; // which stop sequence matched, if one did
  turn.anthropic?.usage; // usage as Anthropic counts it, with all its detail
}
```

- `id` and `model` are shared: every provider that knows them says them the same way.
- Everything else a provider says is in a field under its name. With Anthropic it is the message as its API ended it, without the content, plus `request_id`. It is the API's own object, so a field Anthropic adds later arrives with a newer SDK.
- All of it comes on the `end` chunk that closes the turn, and `append` keeps whatever an `end` carries on the turn. So it is in a stored history too, as plain JSON.
- None of it is ever sent. A provider reads only a turn's content.
- Typed as `AnthropicMessage`, a turn's `anthropic` field is typed. In a history typed more widely it is there all the same, for you to narrow.
- Response headers are not kept. To see them, give the vendor's client a `fetch` of your own.

## Cancelling

Give one signal to the provider and to whatever runs your tools. A cancelled request makes the stream throw. Have a cancelled call throw too: made into a result, it would tell the model of a failure that was your decision.

```ts
const controller = new AbortController();
const { signal } = controller;

// `run` takes the signal here, and hands it to whatever it does that can be stopped.
const answer = async (call: ToolCall): Promise<ToolResult> => {
  try {
    return toolResult(call, await run(call, signal));
  } catch (error) {
    if (isSchemaError(error)) throw error;
    signal.throwIfAborted();
    return toolFailure(call, error);
  }
};

messages.push(...(await collect(provider({ messages, tools, signal }))));
const results = await Promise.all(pendingToolCalls(messages).map(answer));
```

## Caching with Anthropic

A shared part may carry a hint for one provider. It changes cost, never meaning, and every other provider ignores it.

```ts
const reply = provider({
  system: [{ type: "text", text: instructions, anthropic: { cache_control: { type: "ephemeral" } } }],
  messages,
});
```

For automatic caching, put `cache_control: { type: "ephemeral" }` in Anthropic's settings instead.

## Tool settings for Anthropic

A tool may carry Anthropic's own settings for it, in a field under Anthropic's name.

```ts
import type { AnthropicTool } from "@ai-agent-library/providers/anthropic";

const readFileTool = {
  name: "read_file",
  description: "Read a UTF-8 text file.",
  schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  anthropic: { strict: true, cache_control: { type: "ephemeral" } },
} as const satisfies AnthropicTool;
```

- The field takes every setting Anthropic's API has for a tool you define, among them `strict`, `cache_control`, `eager_input_streaming`, `input_examples`, `defer_loading` and `allowed_callers`. It is sent as it is, so a setting Anthropic adds later needs nothing from the provider but a newer SDK for its type.
- What the tool is comes from the tool: its name, description and schema cannot be set in the field.
- Every other provider ignores the field and is told the same tool. `parse(readFileTool.schema, call.input)` reads a call's input as before.
- A tool's schema is sent as you wrote it. It is not fitted the way a shape's is, so where a setting narrows what Anthropic takes, its API is what says so.

## Settings

A provider is made with a client and nothing else. Its vendor's settings go on each request, in `native`, under the provider's name.

```ts
const answer = await text(
  claude({
    messages: [user("Write a haiku about rain.")],
    native: { anthropic: { model: "claude-opus-5-5", max_tokens: 64000 } },
  }),
);
```

- With Anthropic the entry is everything `messages.stream` accepts besides `messages`, `system` and `tools`. It needs `model` and `max_tokens`. Among the rest are `output_config`, `stop_sequences`, `tool_choice` and `thinking`. It is the SDK's own type, so a setting Anthropic adds later needs nothing but a newer SDK.
- The entry is sent as it is. The provider keeps nothing from one request to the next.
- A request with no entry for Anthropic is refused before anything is sent: there is no model to send it to.
- What the request is comes from the request: `messages`, `system` and `tools` cannot be set there. A `shape` on the request is used in place of a `format` in `output_config`.
- `native` is the one place on a request for a vendor's settings, and it is plain data. A provider reads the entry under its own name and ignores every other.
- Which stop sequence ended a turn is on the turn, as `turn.anthropic?.stop_sequence`.

Nothing in the library fills settings in. They are a value, so sharing them and changing them is ordinary TypeScript:

```ts
const opus = {
  model: "claude-opus-5-5",
  max_tokens: 64000,
  output_config: { effort: "high" },
} satisfies AnthropicSettings;

// The settings every request shares: a function of your own.
const provider = (request: Omit<AnthropicRequest, "native">) =>
  claude({ ...request, native: { anthropic: opus } });

// One request that differs: the same value, with what differs changed.
const title = await text(
  claude({
    messages: [user("Give this conversation a title.")],
    native: { anthropic: { ...opus, output_config: { effort: "low" }, stop_sequences: ["\n"] } },
  }),
);

// A setting that changes often: a function that takes it.
const withEffort = (effort: "low" | "medium" | "high") => (request: Omit<AnthropicRequest, "native">) =>
  claude({ ...request, native: { anthropic: { ...opus, output_config: { effort } } } });
```

- `claude` takes only a request that says its settings, so it does not fit where a `Provider` for any request is asked for. With them filled in, as in `provider` and `withEffort("low")`, it does, and a function that wraps any provider takes it.
- Written as a literal, settings are type-checked wherever they are handed to `claude`.

## Write a provider

A provider is one function: it takes a request and returns an async iterable of parts, with one `end` chunk closing each turn. That is all a fake for a test needs.

```ts
import { text, user, type AnyMessage, type Provider, type TextPart } from "@ai-agent-library/library";

const canned: Provider<AnyMessage, TextPart> = async function* () {
  yield { type: "text", text: "Hello." };
  yield { type: "end", reason: "stop" };
};

const said = await text(canned({ messages: [user("Hi.")] })); // "Hello."
```

For a real one:

- Text, reasoning and tool input may be yielded in pieces. Every other part the library names is yielded whole.
- A kind of part of your own may be yielded in pieces too. Export the rule that joins them beside your provider (see [A part of your own, in pieces](#a-part-of-your-own-in-pieces)).
- To tell of a tool call as it is written, yield `tool_input` parts for it, one after another with nothing between them, and then the call itself directly after. The call is still yielded whole, and the pieces are yours to leave out.
- A history may hold `tool_input` parts whose call never arrived. Leave them out of what you send, as you do reasoning.
- If your model says where its words came from, yield a `source` part directly after the text it supports, whole, with a `span`: the length of that text as you yielded it. Put what only your API knows of it in a field under your provider's name. Send your own sources back if your API takes them, and leave out everyone else's.
- A file may carry a field under your provider's name, holding your API's own settings for it. Read it on a file in a message, not on one inside a tool result.
- Anything only your API understands travels as a `native` part carrying your provider's name. Send your own native parts back and leave out everyone else's, so one history can pass between providers.
- Close each turn with an `end` chunk. Besides the reason and usage, say the response's `id` and `model` if your API gives them, and put whatever else it says of the response in a field under your provider's name. Keep it plain JSON, with nothing undefined in it, and leave the content out. `append` keeps all of it on the turn.
- Build what you send from the fields you know. Never forward a part whole.
- A tool may carry a field under your provider's name, holding your API's own settings for it. It is addressed to you alone, so you may send it as it is. Take the tool's name, description and schema from the tool itself, after the field, so nothing in it can replace them. Ignore a field under any other name.
- `fitToolIds` rewrites tool-call ids your API cannot accept, and `answerToolCalls` gives a result to any call that has none. Both return a copy and leave the history as it was.
- A request may carry a `shape`. Send its schema in the form your API takes: `fitSchema` takes every schema inside it, innermost first, through a function of yours, and returns a copy.
  - You may loosen a schema, by leaving out a bound your API cannot enforce and saying it in the description, or tighten it, by closing an object your API needs closed.
  - Never send a schema whose answers you would have to rewrite on the way back. Throw instead, saying where. Throw too if your API cannot ask for a shape at all.
  - Give the same output for the same schema every time.
- Take your vendor's settings from the request, in `native` under your provider's name. Be made with nothing but what reaches your API, such as a client.
  - Read the entry under your own name and no other, and never forward the field.
  - Send what is in the entry as it is, and after it what the request itself says, so nothing in the entry can replace the messages, the tools or a `shape`.
  - A request may come from storage, or from code that does not know you. If your API cannot be called without settings, throw for a request that has none.
- A provider that does not know a request field ignores it. One written before `shape` existed lets the model answer in prose, and the caller's `JSON.parse` reports text that is not JSON. A scripted provider in a test can return canned JSON for the same reason.

Code that only needs text can ask for the narrowest provider, and any richer one fits:

```ts
import { text, user, type Part, type Provider, type TextPart, type UserMessage } from "@ai-agent-library/library";

const summarise = (provider: Provider<UserMessage<TextPart>, Part>) => (document: string) =>
  text(provider({ messages: [user(`Summarise: ${document}`)] }));
```

## A part of your own, in pieces

`append` joins the pieces of text, reasoning and tool input. A provider may yield a kind of part of its own in pieces too, such as audio. How those pieces join is a rule: a function from the parts of the turn so far, and one more part, to the parts after it.

- `join` is the library's own rule, the one `append` and `collect` go by.
- `appending(rule)` is `append` with a rule of yours, and `collecting(rule)` is `collect` with it.

```ts
import { appending, collecting, join, type Join, type Part, type TextPart } from "@ai-agent-library/library";

// Audio, a piece at a time. Each piece is the base64 of its own bytes, so
// pieces are kept side by side and never joined as strings.
type Audio = { type: "audio"; pieces: readonly string[] };
const isAudio = (part: Part): part is Audio => part.type === "audio";

const withAudio: Join<TextPart | Audio> = (parts, part) => {
  const last = parts.at(-1);
  return last && isAudio(last) && isAudio(part)
    ? [...parts.slice(0, -1), { ...last, pieces: [...last.pieces, ...part.pieces] }]
    : join(parts, part);
};

const append = appending(withAudio);
const collect = collecting(withAudio);
```

- A rule speaks for the kinds it knows and hands every other part to `join`, as above. Rules stack the same way: one can hand on to another.
- A rule is pure. It returns the parts and leaves those it was given as they were.
- It keeps one law: however a part is cut into pieces, the turn comes out the same. Adding two pieces one after the other gives what adding them as one piece gives.
- It is given the whole turn, so a piece may join a part that is not the last. That is how to fold a stream in which two parts are written at once.
- Every part of a turn goes through the rule, the first one too. An `end` chunk and a tool result do not: turns and tool messages are folded as `append` folds them.
- Folded without its rule, each piece is a part by itself. Nothing is lost, and nothing is joined.
- `text` needs no rule. It reads the text alone, and the answer is the same however the other parts were joined.

## What is not here

- No agent loop, retries, turn limits or approval flow: those are your loop, and the vendor SDK's client.
- Nothing that runs a tool. The library says what the model may call, what it called and what came of it; finding the code for a call and running it is yours.
- No retrieval, persistence or scheduling.
- Nothing that fills in a provider's settings. They are plain data on the request, and a function of your own shares them.
- No structured output from a vendor that cannot be asked for one. Write the schema into the prompt and call `parse` yourself.
- The Anthropic provider sends only tools you define. It cannot yet send Anthropic's server tools such as web search, so the sources it tells of are those of documents you gave it.