# ai-patterns

Plain values and functions for talking to a model, in TypeScript. This is an idiom more than a framework: a few small pieces that you put together in code of your own.

- A conversation is an array you own. It is plain JSON, so it can be stored and read back without the library.
- A provider is a function. It takes a request and streams a reply.
- A tool is plain data. Running it is your code.
- An agent is a `for` loop you write.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { collect, pendingToolCalls, toolResult, user, type ToolSpec } from "@ai-patterns/core";
import { anthropic, type AnthropicMessage } from "@ai-patterns/anthropic-provider";

// A provider is a function. This one is Anthropic's.
const claude = anthropic(new Anthropic());
const settings = { anthropic: { model: "claude-opus-5-5", max_tokens: 64000 } };

// A tool is plain data. Running it is your code.
const clock = {
  name: "clock",
  description: "The current time, as ISO 8601.",
  schema: { type: "object", properties: {} },
} as const satisfies ToolSpec;

// A conversation is an array you own.
const messages: AnthropicMessage[] = [user("What time is it?")];

// An agent is a loop you write: the same call again, with a longer history.
for (;;) {
  messages.push(...(await collect(claude({ messages, tools: [clock], settings }))));
  const calls = pendingToolCalls(messages);
  if (calls.length === 0) break;
  messages.push({ from: "tool", content: calls.map((call) => toolResult(call, new Date().toISOString())) });
}
```

The whole of it is in [the core package's README](packages/core/README.md): streaming, the full loop, structured output, files, sources and caching.

## Packages

| Package | What it is | Published |
| --- | --- | --- |
| [`@ai-patterns/core`](packages/core/README.md) | The values and functions: parts, messages, the one interface a provider fits, and the pieces of a tool loop. No dependencies. | Not yet |
| [`@ai-patterns/anthropic-provider`](packages/anthropic-provider/README.md) | Anthropic's API as a provider. Anthropic's SDK is yours to install. | Not yet |
| [`tree`](packages/tree/tree.ts) | A tree as plain data, so a conversation can fork. Used by the app. | No |
| [`app`](packages/app) | A desktop chat app built on the packages, to find out what they are good for. | No |

Nothing is on npm yet. [#17](https://github.com/shovon/ai-core/issues/17) tracks the work of publishing.

## Write your own provider

A provider is one function, and the one for Anthropic uses nothing that yours could not: from the library, it imports only what `@ai-patterns/core` exports. A provider for another vendor is a package of your own, under any name, with no need to be added here.

[Write a provider](packages/core/README.md#write-a-provider) says what one has to do. The first example there is a whole provider in four lines, which is all a test needs.

## What is left out

There is no agent loop, nothing that runs a tool, and no retrieval, persistence or scheduling. Those are your code. [What is not here](packages/core/README.md#what-is-not-here) has the full list.

## Working on it

The repo is an npm workspace, developed and checked on Node 26. The tests run the TypeScript as it is, which an older Node may refuse.

```sh
npm install
npm test
npm run typecheck
npm run lint
```

Inside the workspace the packages are read as source, so none of those needs a build. `npm run build` makes what is published: each package's `dist/`.

A pull request that changes a published package says so with a changeset: run `npx changeset` and commit the file it writes. [.changeset/README.md](.changeset/README.md) says how big a change to call it.

`npm start` opens the app. It needs Anthropic credentials, such as `ANTHROPIC_API_KEY` in the environment.

## License

[MIT](LICENSE)
