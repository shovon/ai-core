# @ai-agent-library/providers

Providers for [`@ai-agent-library/library`](../library/README.md), one file for each vendor. Import the one you use by name. Its vendor's SDK is yours to install, and the provider is made with a client from it.

There is one so far: Anthropic.

## Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@ai-agent-library/providers/anthropic";

const claude = anthropic(new Anthropic());
```

How to use it is in the library's README, for now: [settings](../library/README.md#settings), [files](../library/README.md#files), [sources](../library/README.md#sources), [caching](../library/README.md#caching-with-anthropic), [tool settings](../library/README.md#tool-settings-for-anthropic) and [Anthropic's own tools](../library/README.md#anthropics-own-tools). What follows is said only here.

### Make the call yourself

The Anthropic provider is two functions put together, and both are exported. `params` makes what Anthropic's SDK is asked from a request. `read` makes the library's parts from the SDK's stream.

```ts
import { params, read } from "@ai-agent-library/providers/anthropic";

// What `anthropic(client)` does with a request, once its stream is first read:
const parts = read(client.messages.stream(params(request), { signal: request.signal }));
```

The provider does not pass on everything Anthropic says. To reach the rest, make the call and keep hold of the SDK's stream:

```ts
import { append, type Reply } from "@ai-agent-library/library";
import { params, read, type AnthropicOut } from "@ai-agent-library/providers/anthropic";

const stream = client.messages.stream(params(request), { signal, timeout: 30_000 });
stream.on("streamEvent", (event) => {
  if (event.type === "message_start") console.log(event.message.id); // known before the first word
});

let reply: Reply<AnthropicOut> = [];
for await (const chunk of read(stream)) reply = append(reply, chunk);

stream.response?.headers.get("anthropic-ratelimit-requests-remaining");
```

- Every event reaches a `streamEvent` listener as Anthropic sent it, whether or not `read` makes a part of it. Listening takes nothing from what `read` yields.
- `stream.response` is the HTTP response, headers and all. It is there once the response has begun.
- The second argument is the SDK's own options for one request: headers, a timeout, retries. A request's `signal` goes there too, since `params` leaves it out.
- The SDK sends the request when the stream is made. The provider sends nothing until its own stream is first read.
- `read` yields one turn, closed by one `end`, exactly as the provider does. It takes anything that has the stream's events, its `currentMessage`, its `finalMessage()` and its `request_id`.
- This is code written against Anthropic's SDK. Code that is handed a provider cannot do it, because it never sees the client.

### Keep a response's headers

The provider does not keep a response's headers. A provider of your own that does is a few lines around the two halves:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { isEnd } from "@ai-agent-library/library";
import { params, read, type AnthropicMessage, type AnthropicRequest } from "@ai-agent-library/providers/anthropic";

// Which headers are kept is yours to say. Here: what Anthropic says of the rate limits.
const rateLimits = (headers: Headers | undefined) =>
  Object.fromEntries([...(headers ?? [])].filter(([name]) => name.startsWith("anthropic-ratelimit-")));

const keepingHeaders = (client: Anthropic) =>
  async function* (request: AnthropicRequest) {
    const stream = client.messages.stream(params(request), { signal: request.signal });
    for await (const chunk of read(stream))
      yield isEnd(chunk)
        ? { ...chunk, anthropic: { ...chunk.anthropic, headers: rateLimits(stream.response?.headers) } }
        : chunk;
  };

const claude = keepingHeaders(new Anthropic());
```

To read them from a turn, say that your history may hold them:

```ts
import { collect, user } from "@ai-agent-library/library";

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
