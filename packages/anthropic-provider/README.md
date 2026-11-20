# @ai-patterns/anthropic-provider

Anthropic's API as a provider for [`@ai-patterns/core`](https://github.com/shovon/ai-core/blob/main/packages/core/README.md). Anthropic's SDK is yours to install, and the provider is made with a client from it.

```sh
npm install @ai-patterns/core @ai-patterns/anthropic-provider @anthropic-ai/sdk
```

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@ai-patterns/anthropic-provider";

const claude = anthropic(new Anthropic());
```

How to use it is in the library's README, for now: [settings](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#settings), [files](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#files), [sources](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#sources), [caching](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#caching-with-anthropic), [tool settings](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#tool-settings-for-anthropic) and [Anthropic's own tools](https://github.com/shovon/ai-core/blob/main/packages/core/README.md#anthropics-own-tools). What follows is said only here.

## Betas

The provider calls the SDK's beta namespace, `client.beta.messages.stream`. A request that names no beta is answered as it is on the stable one. To reach what only a beta has, name the beta in the settings, as `betas`, beside the settings it brings.

Here Anthropic calls the tools of an MCP server itself:

```ts
import { collect, user } from "@ai-patterns/core";
import type { AnthropicMessage, AnthropicSettings } from "@ai-patterns/anthropic-provider";

const withDocs = {
  model: "claude-opus-5-5",
  max_tokens: 64000,
  betas: ["mcp-client-2026-09-15"],
  mcp_servers: [{ type: "url", name: "docs", url: "https://example.com/mcp" }],
  tools: [{ type: "mcp_toolset", mcp_server_name: "docs" }],
} satisfies AnthropicSettings;

const messages: AnthropicMessage[] = [user("What do the docs say about rain?")];
for (;;) {
  messages.push(...(await collect(claude({ messages, settings: { anthropic: withDocs } }))));
  const last = messages.at(-1);
  if (last?.from === "model" && last.end === "pause") continue;
  break;
}
```

- `betas` is the SDK's own setting. The SDK sends the names as a header, never in the body.
- A beta's name is the one Anthropic's documentation gives it. A setting sent without its beta is refused by Anthropic's API.
- The settings are the SDK's own type for the beta namespace. So what a beta takes is typed, and a beta Anthropic adds later needs nothing but a newer SDK.
- What a beta puts in a reply arrives as `native` parts, in the order it happened, and goes back to Anthropic as it came.

### The MCP connector

- A server's tools are listed, called and answered on Anthropic's side. The listing, each call and what came of it are `native` parts. They are not yours to run: `pendingToolCalls` does not return them.
- A history in which a server was used can be sent to Anthropic only with that server still in the settings and the beta named. The listing in the turn names its server.
- A server's entry may hold an `authorization_token`. Settings are plain data, so a request that is stored holds the token.
- A toolset has no name of its own. So where a tool of yours has the name of one of a server's tools, both are sent. What Anthropic makes of that has not been tried.

### Compaction

A request with `compaction` in its settings asks for a summary of the conversation, and for nothing else.

```ts
const opus = { model: "claude-opus-5-5", max_tokens: 64000 } satisfies AnthropicSettings;
const compact = ["compact-2026-09-04"];
const summarising = { ...opus, betas: compact, compaction: { type: "summarize" } } satisfies AnthropicSettings;

// The summary takes the place of the messages it stands for.
const summary = await collect(claude({ messages, settings: { anthropic: summarising } }));
const next: AnthropicMessage[] = [...summary, user("Where were we?")];
next.push(...(await collect(claude({ messages: next, settings: { anthropic: { ...opus, betas: compact } } }))));
```

- The reply is one turn that holds the summary, as a `native` part. It is no answer, so the turn ends as `unknown` and `text` throws on it. `turn.anthropic?.stop_reason` says `"compaction"`.
- A history that starts with a summary can be sent to Anthropic only with the beta named.

### Context management

- `context_management` clears old tool results on Anthropic's side, for one request. Your history is yours and does not change.
- What was cleared is on the turn, as `turn.anthropic?.context_management`.

### Threads

- With `thread: { type: "create" }` in the settings, Anthropic holds the conversation.
- The next request sends only its new messages, with `thread: { type: "continue", previous_message_id }`. The id is the last turn's `id`.

### Fallbacks

- `fallbacks` names the models to try when the one asked declines. Not every model takes them, and which models one may fall back to is on Anthropic's Models API.
- What each attempt cost is on the turn, in `turn.anthropic?.usage.iterations`.
- Anthropic's guide says a fallback that happened is told by a block in the reply, which would arrive as a `native` part. That has not been tried: it needs a real refusal.

### What has been tried

All of the above was tried against Anthropic's API on 2026-11-20, but for two things: a fallback that happened, and an MCP server that needs a token.

## Make the call yourself

The Anthropic provider is two functions put together, and both are exported. `params` makes what Anthropic's SDK is asked from a request. `read` makes the library's parts from the SDK's stream.

```ts
import { params, read } from "@ai-patterns/anthropic-provider";

// What `anthropic(client)` does with a request, once its stream is first read:
const parts = read(client.beta.messages.stream(params(request), { signal: request.signal }));
```

The provider does not pass on everything Anthropic says. To reach the rest, make the call and keep hold of the SDK's stream:

```ts
import { append, type Reply } from "@ai-patterns/core";
import { params, read, type AnthropicOut } from "@ai-patterns/anthropic-provider";

const stream = client.beta.messages.stream(params(request), { signal, timeout: 30_000 });
stream.on("streamEvent", (event) => {
  if (event.type === "message_start") console.log(event.message.id); // known before the first word
});

let reply: Reply<AnthropicOut> = [];
for await (const chunk of read(stream)) reply = append<AnthropicOut>(reply, chunk);

stream.response?.headers.get("anthropic-ratelimit-requests-remaining");
```

- Every event reaches a `streamEvent` listener as Anthropic sent it, whether or not `read` makes a part of it. Listening takes nothing from what `read` yields.
- `stream.response` is the HTTP response, headers and all. It is there once the response has begun.
- The second argument is the SDK's own options for one request: headers, a timeout, retries. A request's `signal` goes there too, since `params` leaves it out.
- The SDK sends the request when the stream is made. The provider sends nothing until its own stream is first read.
- `read` yields one turn, closed by one `end`, exactly as the provider does. It takes anything that has the stream's events, its `currentMessage`, its `finalMessage()` and its `request_id`.
- Make the call on the SDK's beta namespace, as the provider does. The stable one's stream is not one `read` takes: it joins only the pieces of a reply it knows, so a block only a beta writes would come out of it incomplete.
- This is code written against Anthropic's SDK. Code that is handed a provider cannot do it, because it never sees the client.

## Set a timeout or a header for one request

A timeout, a header and retries are the SDK's own options for one request. They are no part of a request's settings, and the provider passes none of them. A provider of your own that does is a few lines around the two halves:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { text, user, type Takes } from "@ai-patterns/core";
import { params, read, type AnthropicOut, type AnthropicRequest } from "@ai-patterns/anthropic-provider";

const withOptions = (client: Anthropic, options: Anthropic.RequestOptions): Takes<AnthropicRequest, AnthropicOut> =>
  async function* (request) {
    yield* read(client.beta.messages.stream(params(request), { ...options, signal: request.signal }));
  };

const client = new Anthropic();
const settings = { anthropic: { model: "claude-opus-5-5", max_tokens: 64000 } };

// The options every request shares: a provider made with them.
const claude = withOptions(client, { timeout: 30_000, maxRetries: 0 });

// One request that differs: a provider made for it, from the same client.
const title = await text(
  withOptions(client, { timeout: 5_000, headers: { "x-trace": "t1" } })({
    messages: [user("Give this conversation a title.")],
    settings,
  }),
);
```

- The options are the SDK's own type: `headers`, `timeout`, `maxRetries`, `idempotencyKey` and the rest. One the SDK adds later needs nothing but a newer SDK.
- One client serves every provider made this way, and `anthropic(client)` beside them. Different options never need a second client.
- They are not on the request, so a request stays plain data even where an option is not, such as `middleware`, which holds functions.
- Cancelling is the request's own. Its `signal` comes after the options, so a `signal` among them is not used.
- It is a provider like the one it is made from. It fits wherever `anthropic(client)` does, and sends nothing until its stream is first read.
- Code that is handed a provider cannot set these. Hand it one that has them already, or one whose requests carry them, as below.

### Options on the request

To say the options request by request, make a provider whose request carries them. The field is your own, on a request type of your own:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { text, user, type Takes } from "@ai-patterns/core";
import { params, read, type AnthropicOut, type AnthropicRequest } from "@ai-patterns/anthropic-provider";

// A request for Anthropic, with the SDK's options for it beside the rest.
type RequestWithOptions = AnthropicRequest & { options?: Anthropic.RequestOptions };

const takingOptions = (client: Anthropic): Takes<RequestWithOptions, AnthropicOut> =>
  async function* (request) {
    yield* read(client.beta.messages.stream(params(request), { ...request.options, signal: request.signal }));
  };

const claude = takingOptions(new Anthropic());
const settings = { anthropic: { model: "claude-opus-5-5", max_tokens: 64000 } };

const title = await text(
  claude({
    messages: [user("Give this conversation a title.")],
    settings,
    options: { timeout: 5_000, headers: { "x-trace": "t1" } },
  }),
);
```

- `params` reads only the fields of a request that it knows, so `options` is never sent to Anthropic. The name is yours to choose, and the library gives it no meaning: another provider handed such a request ignores the field.
- One provider serves every request, whatever its options. Code that is handed it can set them, and a wrapper that holds state around it, such as a budget, sees every call.
- A request with no options is an `AnthropicRequest`, so this provider fits wherever `anthropic(client)` does.
- A request that is stored keeps the options that are plain data, such as a timeout and headers. `middleware` holds functions, which do not survive JSON.
- A header may hold a secret, and on a request it goes wherever the request goes.
- Cancelling is still the request's own. Its `signal` comes after the options, so a `signal` among them is not used.

## Keep a response's headers

The provider does not keep a response's headers. A provider of your own that does is a few lines around the two halves:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { isEnd, type Takes } from "@ai-patterns/core";
import { params, read, type AnthropicMessage, type AnthropicOut, type AnthropicRequest } from "@ai-patterns/anthropic-provider";

// Which headers are kept is yours to say. Here: what Anthropic says of the rate limits.
const rateLimits = (headers: Headers | undefined) =>
  Object.fromEntries([...(headers ?? [])].filter(([name]) => name.startsWith("anthropic-ratelimit-")));

const keepingHeaders = (client: Anthropic): Takes<AnthropicRequest, AnthropicOut> =>
  async function* (request) {
    const stream = client.beta.messages.stream(params(request), { signal: request.signal });
    for await (const chunk of read(stream))
      yield isEnd(chunk)
        ? { ...chunk, anthropic: { ...chunk.anthropic, headers: rateLimits(stream.response?.headers) } }
        : chunk;
  };

const claude = keepingHeaders(new Anthropic());
```

To read them from a turn, say that your history may hold them:

```ts
import { collect, user } from "@ai-patterns/core";

type KeepingHeaders = AnthropicMessage & { anthropic?: { headers?: Record<string, string> } };

const settings = { anthropic: { model: "claude-opus-5-5", max_tokens: 64000 } };
const messages: KeepingHeaders[] = [user("Hello.")];
messages.push(...(await collect(claude({ messages, settings }))));

const turn = messages.at(-1);
if (turn?.from === "model") turn.anthropic?.headers?.["anthropic-ratelimit-requests-remaining"];
```

- `append` keeps whatever an `end` carries. So the headers are on the turn, beside the rest of Anthropic's account of the response, and in a stored history as plain JSON. They are never sent.
- It is a provider like the one it is made from. It fits wherever `anthropic(client)` does, and sends nothing until its stream is first read.
- The headers come with the `end`, so a stream that is cut off leaves none on its turn. To read them sooner, hold the SDK's stream as in [Make the call yourself](#make-the-call-yourself).
- Kept whole, the headers hold everything the response carries, such as Anthropic's id for your organisation, and all of it goes wherever the history goes. That is why the example names the ones it keeps.
- The headers of a request that failed need none of this. They are on the error the SDK throws.
