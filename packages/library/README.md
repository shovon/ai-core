# @ai-agent-library/library

Plain values and functions for talking to a model. A conversation is an array you own, a provider is a function that streams a reply, and an agent is a `for` loop you write. Nothing here has dependencies, and nothing here needs the library to be read back: a history is plain JSON.

## Setup

The packages are TypeScript source with no build step, so run them with a Node that executes TypeScript directly, or through a bundler. Inside this workspace, add them to a package's dependencies as `"*"`.

A provider comes from `@ai-agent-library/providers`, one import per vendor. You install the vendor's SDK yourself and hand the provider a client.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@ai-agent-library/providers/anthropic";

const provider = anthropic(new Anthropic(), { model: "claude-opus-5-5", max_tokens: 64000 });
```

The second argument is anything Anthropic's `messages.stream` accepts, except `messages`, `system` and `tools`, which come from each request.

## Ask once

```ts
import { model, text } from "@ai-agent-library/library";

const answer = await text(model(provider)("Write a haiku about rain."));
```

`model` turns a bare string into a request. `text` reads the stream to its end and returns the answer. It throws unless the model finished, so a reply that was cut off or refused never comes back looking like an answer.

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

A message is from `"user"`, `"model"` or `"tool"`, and who it is from decides what it may contain. A model message records why its turn ended (`end`) and what it cost (`usage`).

## Give the model tools

A tool is a name, a description, a JSON Schema for its input, and a function. The one schema is told to the model, types the input of `run`, and is checked before `run` is called.

```ts
import { readFile } from "node:fs/promises";
import { tool } from "@ai-agent-library/library";

const tools = [
  tool({
    name: "read_file",
    description: "Read a UTF-8 text file.",
    schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: ({ path }) => readFile(path, "utf8"),
  }),
];
```

- Input that does not fit the schema goes back to the model as an error naming everything wrong with it, so it can correct the call.
- The schema may use `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems` and `maxItems`. Any other keyword that asserts something is refused when the tool is made, because it would be told to the model and never enforced.
- A schema held in a variable needs `as const` to type the input; written inside `tool()` it does not.
- `run` returns a string, or text and file parts in order. It receives `{ signal }` as its second argument.
- For a schema outside that subset, write the `Tool` object out yourself, with a `run` that checks its own input.

## The loop

There is no agent loop in the library. A loop is the same call made again with a longer history:

```ts
import { collect, isText, pendingToolCalls, runToolCall, user } from "@ai-agent-library/library";
import type { AnthropicMessage } from "@ai-agent-library/providers/anthropic";

const messages: AnthropicMessage[] = [user("What does package.json depend on?")];

for (;;) {
  messages.push(...(await collect(provider({ messages, tools }))));
  const last = messages.at(-1);
  if (last?.from === "model" && last.end === "pause") continue;
  const calls = pendingToolCalls(messages);
  if (calls.length === 0) break;
  messages.push({ from: "tool", content: await Promise.all(calls.map((call) => runToolCall(tools, call))) });
}

const final = messages.at(-1);
if (final?.from !== "model" || final.end !== "stop") throw new Error("the run did not end on an answer");
console.log(final.content.filter(isText).map((part) => part.text).join(""));
```

- `pendingToolCalls` returns the tool calls in a final, finished model turn. When it returns none, the loop is over.
- `runToolCall` runs one call. A missing tool, bad input or a thrown error becomes an error result the model reads, so the loop keeps going.
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
import { runToolCall, toolResult, type ToolResult } from "@ai-agent-library/library";

const results: ToolResult[] = [];
for (const call of calls) {
  const allowed = call.name !== "delete_file" || (await confirm(call));
  results.push(allowed ? await runToolCall(tools, call) : toolResult(call, "The user said no.", { error: true }));
}
messages.push({ from: "tool", content: results });
```

See a failure before the model does. `runToolCall` is `attemptToolCall`, with `toolResult` for what comes back and `toolFailure` for what is thrown:

```ts
import { attemptToolCall, toolFailure, toolResult, type ToolCall } from "@ai-agent-library/library";

const watched = async (call: ToolCall) => {
  try {
    return toolResult(call, await attemptToolCall(tools, call));
  } catch (error) {
    console.error(call.name, error);
    return toolFailure(call, error);
  }
};
```

## Ask for a typed answer

A shape is a JSON Schema for the answer. The one schema is told to the model, types what `parse` returns, and is checked by `parse`.

```ts
import { shape, text, user } from "@ai-agent-library/library";

const triage = shape({
  type: "object",
  properties: {
    category: { enum: ["billing", "bug", "other"] },
    urgent: { type: "boolean" },
    orderId: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["category", "urgent", "orderId"],
  additionalProperties: false,
});

const ticket = triage.parse(
  await text(provider({ system: "Triage the support ticket.", messages: [user(email)], shape: triage })),
);
// ticket: { category: "billing" | "bug" | "other"; urgent: boolean; orderId: string | null }
```

- The answer is ordinary text that happens to be JSON. It streams, ends and is stored like any other answer, so `parse` reads one from a stored history just as well.
- `parse` throws unless the text is JSON that fits the schema as you wrote it, and the error names everything wrong. Sending that back to the model and asking again is your loop.
- `parse` is exact about `null`: where the schema does not accept one, it is wrong.
- The schema uses the same keywords as a tool's. Any other keyword that asserts something is refused when the shape is made.
- A shape and tools go in one request. The model calls its tools first, and its final answer is the JSON.
- A call can fail in three places. The stream throws if the request fails or the provider cannot ask for the schema, `text` throws if the turn did not finish, and `parse` throws if the answer does not fit.

Vendors take different schemas. One written this way can be asked of any of them:

- The whole answer is an object.
- Every object lists its properties and is closed with `additionalProperties: false`.
- Every property is required. One that may be missing is itself or `null`, like `orderId` above.

Nothing enforces that style. Each provider sends what its vendor takes and refuses the rest with an error that says where. The Anthropic provider:

- Leaves out `minimum`, `maximum`, `minLength`, `maxLength`, `maxItems` and a `minItems` above 1, which Anthropic does not enforce, and says each in the schema's description so the model is still told. `parse` still checks them.
- Closes every object, as Anthropic requires. The model then writes only the properties you listed.
- Refuses an open object with no listed properties, because Anthropic could only answer `{}` for it.

## Files

`file` makes a part from bytes or from a link. Bytes are kept as base64, so the part stays plain JSON.

```ts
import { readFile } from "node:fs/promises";
import { file, text, user } from "@ai-agent-library/library";

const seen = await text(provider({ messages: [user("What is in this picture?", file("image/png", await readFile("cat.png")))] }));
```

The Anthropic provider sends JPEG, PNG, GIF and WebP images and PDFs. Any other type is an error, never a silent drop.

## Reasoning and cost

- A `reasoning` part is what the model says of its own working. It is for showing and is never sent back; `isReasoning` picks it out. With Anthropic, pass `thinking: { type: "adaptive", display: "summarized" }` to the provider to receive its text.
- `totalUsage(messages)` adds up what the model turns in a history cost: `input`, `output`, `cacheRead` and `cacheWrite` tokens.

## Cancelling

Give one signal to the provider and to `runToolCall`. A cancelled request makes the stream throw, and a cancelled tool call throws instead of becoming a result.

```ts
const controller = new AbortController();
const { signal } = controller;

messages.push(...(await collect(provider({ messages, tools, signal }))));
const results = await Promise.all(pendingToolCalls(messages).map((call) => runToolCall(tools, call, signal)));
```

## Caching with Anthropic

A shared part may carry a hint for one provider. It changes cost, never meaning, and every other provider ignores it.

```ts
const reply = provider({
  system: [{ type: "text", text: instructions, anthropic: { cache_control: { type: "ephemeral" } } }],
  messages,
});
```

For automatic caching, pass `cache_control: { type: "ephemeral" }` in the provider's options instead.

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

- Text and reasoning may be yielded in pieces. Every other part is yielded whole.
- Anything only your API understands travels as a `native` part carrying your provider's name. Send your own native parts back and leave out everyone else's, so one history can pass between providers.
- Build what you send from the fields you know. Never forward a part whole.
- `fitToolIds` rewrites tool-call ids your API cannot accept, and `answerToolCalls` gives a result to any call that has none. Both return a copy and leave the history as it was.
- A request may carry a `shape`. Send its schema in the form your API takes: `fitSchema` takes every schema inside it, innermost first, through a function of yours, and returns a copy.
  - You may loosen a schema, by leaving out a bound your API cannot enforce and saying it in the description, or tighten it, by closing an object your API needs closed.
  - Never send a schema whose answers you would have to rewrite on the way back. Throw instead, saying where. Throw too if your API cannot ask for a shape at all.
  - Give the same output for the same schema every time.
- A provider that does not know a request field ignores it. One written before `shape` existed lets the model answer in prose, and the caller's `parse` reports text that is not JSON. A scripted provider in a test can return canned JSON for the same reason.

Code that only needs text can ask for the narrowest provider, and any richer one fits:

```ts
import { text, user, type Part, type Provider, type TextPart, type UserMessage } from "@ai-agent-library/library";

const summarise = (provider: Provider<UserMessage<TextPart>, Part>) => (document: string) =>
  text(provider({ messages: [user(`Summarise: ${document}`)] }));
```

## What is not here

- No agent loop, retries, turn limits or approval flow: those are your loop, and the vendor SDK's client.
- No retrieval, persistence or scheduling.
- No typed answer from a vendor that cannot be asked for one. Write the schema into the prompt and call `parse` yourself.
- The Anthropic provider sends only tools you define. It cannot yet send Anthropic's server tools such as web search, and it does not carry text citations.
