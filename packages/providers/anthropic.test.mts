import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, type AnthropicMessage } from "./anthropic.ts";
import {
  collect,
  file,
  model,
  pendingToolCalls,
  runToolCall,
  text,
  tool,
  user,
  type NativePart,
  type PortableMessage,
  type Provider,
  type ReasoningPart,
  type Request,
  type TextPart,
  type Tool,
  type ToolCall,
} from "@ai-agent-library/library";

// The real SDK, with fetch replaced by canned server-sent-event replies.
const sse = (events: object[]) =>
  events
    .map(
      (e) =>
        `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`,
    )
    .join("");

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
};
const finish = (stop_reason: string) => [
  {
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];
const thinks = [
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "hmm" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig" },
  },
  { type: "content_block_stop", index: 0 },
];
const speaks = (index: number, ...pieces: string[]) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  },
  ...pieces.map((piece) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: piece },
  })),
  { type: "content_block_stop", index },
];
const callsWeather = [
  {
    type: "content_block_start",
    index: 2,
    content_block: {
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"city":' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"Toronto"}' },
  },
  { type: "content_block_stop", index: 2 },
];
const thinksThenCalls = sse([
  start,
  ...thinks,
  ...speaks(1, "Chec", "king."),
  ...callsWeather,
  ...finish("tool_use"),
]);
const thinksThenSays = (words: string) =>
  sse([start, ...thinks, ...speaks(1, words), ...finish("end_turn")]);
const says = (words: string) =>
  sse([start, ...speaks(0, words), ...finish("end_turn")]);

/** A client that answers each request with the next canned reply and records what was sent. */
const client = (sent: any[], ...replies: string[]) =>
  new Anthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(replies[sent.length - 1], {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
const options = { model: "claude-opus-5-5", max_tokens: 1024 };
const weather: Tool = {
  name: "get_weather",
  description: "Weather.",
  schema: { type: "object" },
  run: () => "18C",
};
const blocks = (m: any) => m.content.map((b: any) => b.type).join("+");

test("reply: text streams; tool calls arrive whole; thinking is told as reasoning and arrives whole as a native part", async () => {
  const provider = anthropic(client([], thinksThenCalls), options);
  const reply = await collect(provider({ messages: [user("weather?")] }));
  assert.equal(reply.length, 1);
  const [turn] = reply;
  assert.ok(turn?.from === "model" && turn.end === "stop");
  assert.deepEqual(turn.content, [
    { type: "reasoning", text: "hmm" },
    {
      type: "native",
      provider: "anthropic",
      value: { type: "thinking", thinking: "hmm", signature: "sig" },
    },
    { type: "text", text: "Checking." },
    {
      type: "tool_call",
      id: "toolu_1",
      name: "get_weather",
      input: { city: "Toronto" },
    },
  ]);
  // The value keeps Anthropic's own type: plain narrowing reaches its fields.
  const [, first] = turn.content;
  assert.ok(
    first?.type === "native" &&
      first.value.type === "thinking" &&
      first.value.signature === "sig",
  );
});

test("request: each origin is translated to its role; the model turn echoes back unchanged", async () => {
  const sent: any[] = [];
  const provider = anthropic(
    client(sent, thinksThenCalls, says("ok")),
    options,
  );
  const messages: AnthropicMessage[] = [
    user(file("image/png", new Uint8Array([1, 2, 3])), "weather?"),
  ];
  messages.push(...(await collect(provider({ messages }))));
  messages.push({
    from: "tool",
    content: [
      {
        type: "tool_result",
        id: "toolu_1",
        content: [{ type: "text", text: "18C" }],
      },
    ],
  });
  await collect(provider({ system: "Be brief.", messages, tools: [weather] }));

  const body = sent[1];
  assert.equal(body.system, "Be brief.");
  assert.deepEqual(body.tools, [
    {
      name: "get_weather",
      description: "Weather.",
      input_schema: { type: "object" },
    },
  ]);
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(body.messages[0].content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AQID" },
  });
  assert.deepEqual(body.messages[1].content[0], {
    type: "thinking",
    thinking: "hmm",
    signature: "sig",
  });
  assert.equal(blocks(body.messages[1]), "thinking+text+tool_use");
  assert.deepEqual(body.messages[2].content, [
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: "18C" }],
    },
  ]);
});

test("an empty list of tools is the same as none: the request does not mention tools", async () => {
  const sent: any[] = [];
  const claude = anthropic(
    client(sent, says("a"), says("b"), says("c")),
    options,
  );
  const messages = [user("hi")];
  await collect(claude({ messages }));
  await collect(claude({ messages, tools: [] }));
  await collect(claude({ messages, tools: [weather] }));
  assert.equal("tools" in sent[0], false);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(sent[2].tools.length, 1);
});

test("a call left without a result is answered on the way out, and the history keeps what happened", async () => {
  const sent: any[] = [];
  // One whole call, then a second cut off in the middle of its input.
  const cutShort = [
    {
      type: "content_block_start",
      index: 3,
      content_block: {
        type: "tool_use",
        id: "toolu_2",
        name: "get_weather",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    },
    { type: "content_block_stop", index: 3 },
  ];
  const cutOff = sse([
    start,
    ...thinks,
    ...speaks(1, "Checking."),
    ...callsWeather,
    ...cutShort,
    ...finish("max_tokens"),
  ]);
  const claude = anthropic(
    client(sent, cutOff, says("Just Toronto, then.")),
    options,
  );
  const messages: AnthropicMessage[] = [user("weather in Toronto and Ottawa?")];
  messages.push(...(await collect(claude({ messages, tools: [weather] }))));
  // The turn did not finish, so nothing in it is run: the half-written call looks like a whole one.
  assert.deepEqual(messages[1]?.content.at(-1), {
    type: "tool_call",
    id: "toolu_2",
    name: "get_weather",
    input: {},
  });
  assert.deepEqual(pendingToolCalls(messages), []);

  messages.push(user("never mind, just Toronto"));
  const before = structuredClone(messages);
  await collect(claude({ messages, tools: [weather] }));
  const history = sent[1].messages;
  assert.deepEqual(
    history.map((m: any) => `${m.role}: ${blocks(m)}`),
    [
      "user: text",
      "assistant: thinking+text+tool_use+tool_use",
      "user: tool_result+tool_result",
      "user: text",
    ],
  );
  const unrun = (tool_use_id: string) => ({
    type: "tool_result",
    tool_use_id,
    is_error: true,
    content: [
      { type: "text", text: "Not run: this call was never given a result." },
    ],
  });
  assert.deepEqual(history[2].content, [unrun("toolu_1"), unrun("toolu_2")]);
  // Nothing was added to the history itself.
  assert.deepEqual(messages, before);
  assert.deepEqual(
    messages.map((m) => m.from),
    ["user", "model", "user"],
  );
});

test("a reply, its tool results and the next reply continue the conversation with a valid history", async () => {
  const sent: any[] = [];
  const claude = anthropic(
    client(sent, thinksThenCalls, says("It is 18C."), says("Colder.")),
    options,
  );
  const messages: AnthropicMessage[] = [user("weather?")];
  messages.push(...(await collect(claude({ messages, tools: [weather] }))));
  messages.push({
    from: "tool",
    content: await Promise.all(
      pendingToolCalls(messages).map((call) => runToolCall([weather], call)),
    ),
  });
  messages.push(...(await collect(claude({ messages, tools: [weather] }))));
  messages.push(user("and tomorrow?"));
  assert.equal(await text(claude({ messages, tools: [weather] })), "Colder.");

  const history = sent[2].messages;
  assert.deepEqual(
    history.map((m: any) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  assert.deepEqual(history.map(blocks), [
    "text",
    "thinking+text+tool_use",
    "tool_result",
    "text",
    "text",
  ]);
});

// A stand-in for a second provider, with private state of its own.
type OtherOut =
  | TextPart
  | ToolCall
  | NativePart<"other", { reasoning: string }>;
const other = (
  seen: Request<PortableMessage>[],
): Provider<PortableMessage, OtherOut> =>
  async function* (request) {
    seen.push({ ...request, messages: [...request.messages] });
    yield {
      type: "native",
      provider: "other",
      value: { reasoning: `private ${seen.length}` },
    };
    yield { type: "text", text: `other ${seen.length}` };
    yield { type: "end", reason: "stop" };
  };

test("one history across two providers: each gets its own private parts back, and only its own", async () => {
  const sent: any[] = [];
  const seen: Request<PortableMessage>[] = [];
  const claude = anthropic(
    client(
      sent,
      thinksThenSays("A1"),
      thinksThenSays("A2"),
      thinksThenSays("A3"),
    ),
    options,
  );
  const gpt = other(seen);

  const messages: PortableMessage[] = [];
  // Both providers fit one type: takes a portable history, emits shared parts and native parts.
  const hit = async (
    provider: Provider<
      PortableMessage,
      TextPart | ReasoningPart | ToolCall | NativePart
    >,
    prompt: string,
  ) => {
    messages.push(user(prompt));
    messages.push(...(await collect(provider({ messages }))));
  };
  await hit(claude, "one");
  await hit(claude, "two");
  await hit(gpt, "three");
  await hit(claude, "four");
  await hit(gpt, "five");

  // Fourth hit, to Anthropic: its two earlier turns are complete; the other provider's turn is text only.
  const fourth = sent[2].messages;
  assert.deepEqual(
    fourth.map((m: any) => m.role),
    ["user", "assistant", "user", "assistant", "user", "assistant", "user"],
  );
  assert.deepEqual(fourth.map(blocks), [
    "text",
    "thinking+text",
    "text",
    "thinking+text",
    "text",
    "text",
    "text",
  ]);
  assert.equal(fourth[1].content[0].signature, "sig");
  assert.deepEqual(fourth[5].content, [{ type: "text", text: "other 1" }]);

  // Fifth hit, to the other provider: the history it is handed still holds its own private part.
  const fifth = seen[1]!.messages;
  assert.deepEqual(fifth[5]!.content[0], {
    type: "native",
    provider: "other",
    value: { reasoning: "private 1" },
  });

  // The history itself lost nothing: every model turn still carries its maker's private part.
  const owners = messages.flatMap((m) =>
    m.from === "model"
      ? m.content.flatMap((p) => (p.type === "native" ? [p.provider] : []))
      : [],
  );
  assert.deepEqual(owners, [
    "anthropic",
    "anthropic",
    "other",
    "anthropic",
    "other",
  ]);
});

test("another provider's tool-call ids are made acceptable, and still pair with their results", async () => {
  const sent: any[] = [];
  const result = (id: string) =>
    ({
      type: "tool_result",
      id,
      content: [{ type: "text", text: "ok" }],
    }) as const;
  const messages: PortableMessage[] = [
    user("go"),
    {
      from: "model",
      end: "stop",
      content: [
        {
          type: "tool_call",
          id: "call:9f3a.1",
          name: "get_weather",
          input: {},
        },
        {
          type: "tool_call",
          id: "call_abc123",
          name: "get_weather",
          input: {},
        },
        {
          type: "tool_call",
          id: "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
          name: "get_weather",
          input: {},
        },
      ],
    },
    {
      from: "tool",
      content: [
        result("call:9f3a.1"),
        result("call_abc123"),
        result("toolu_01D7FLrfh4GYq7yT1ULFeyMV"),
      ],
    },
  ];
  const before = structuredClone(messages);
  await collect(
    anthropic(
      client(sent, says("ok")),
      options,
    )({ messages, tools: [weather] }),
  );

  const calls = sent[0].messages[1].content.map((b: any) => b.id);
  const results = sent[0].messages[2].content.map((b: any) => b.tool_use_id);
  // Only the id Anthropic would reject is replaced; the other two go out as they are.
  assert.deepEqual(calls, [
    "toolu_fitted_0",
    "call_abc123",
    "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
  ]);
  assert.deepEqual(results, calls);
  assert.deepEqual(messages, before);
});

test("hints: a cache breakpoint on a shared part reaches Anthropic, and only that", async () => {
  const sent: any[] = [];
  const here = { cache_control: { type: "ephemeral", ttl: "1h" } } as const;
  const messages: AnthropicMessage[] = [
    {
      from: "user",
      content: [
        { type: "text", text: "A long reference document.", anthropic: here },
        { ...file("image/png", new Uint8Array([1])), anthropic: here },
        { type: "text", text: "No hint on this one." },
      ],
    },
    {
      from: "model",
      end: "stop",
      content: [
        { type: "text", text: "Looking.", anthropic: here },
        {
          type: "tool_call",
          id: "toolu_1",
          name: "get_weather",
          input: {},
          anthropic: here,
        },
      ],
    },
    {
      from: "tool",
      content: [
        {
          type: "tool_result",
          id: "toolu_1",
          content: [{ type: "text", text: "18C" }],
          anthropic: here,
        },
      ],
    },
  ];
  const before = structuredClone(messages);
  await collect(
    anthropic(
      client(sent, says("ok")),
      options,
    )({ messages, tools: [weather] }),
  );

  const [asked, replied, answered] = sent[0].messages;
  assert.deepEqual(
    asked.content.map((b: any) => b.cache_control),
    [here.cache_control, here.cache_control, undefined],
  );
  assert.deepEqual(
    replied.content.map((b: any) => b.cache_control),
    [here.cache_control, here.cache_control],
  );
  assert.deepEqual(
    answered.content.map((b: any) => b.cache_control),
    [here.cache_control],
  );
  // The field itself is never sent, and the history is untouched.
  assert.doesNotMatch(JSON.stringify(sent[0]), /"anthropic"/);
  assert.deepEqual(messages, before);
});

test("hints: unknown keys in the field, and hints inside a tool result, are not sent", async () => {
  const sent: any[] = [];
  // As a history comes back from storage: untyped.
  const stored = JSON.parse(
    JSON.stringify([
      {
        from: "user",
        content: [
          {
            type: "text",
            text: "hi",
            anthropic: {
              cache_control: { type: "ephemeral" },
              secret: "s3cr3t",
            },
          },
        ],
      },
      {
        from: "model",
        end: "stop",
        content: [
          { type: "tool_call", id: "toolu_1", name: "get_weather", input: {} },
        ],
      },
      {
        from: "tool",
        content: [
          {
            type: "tool_result",
            id: "toolu_1",
            content: [
              {
                type: "text",
                text: "18C",
                anthropic: { cache_control: { type: "ephemeral" } },
              },
            ],
          },
        ],
      },
    ]),
  ) as AnthropicMessage[];
  await collect(
    anthropic(client(sent, says("ok")), options)({ messages: stored }),
  );

  assert.deepEqual(sent[0].messages[0].content[0], {
    type: "text",
    text: "hi",
    cache_control: { type: "ephemeral" },
  });
  assert.deepEqual(sent[0].messages[2].content[0].content, [
    { type: "text", text: "18C" },
  ]);
  assert.doesNotMatch(JSON.stringify(sent[0]), /s3cr3t/);
});

test("hints: a hinted history is still a portable one, and the plain helpers carry hints", async () => {
  const sent: any[] = [];
  const seen: Request<PortableMessage>[] = [];
  const document = {
    type: "text",
    text: "A long reference document.",
    anthropic: { cache_control: { type: "ephemeral" } },
  } as const;
  const messages: PortableMessage[] = [user(document, "What does it say?")];
  // The other provider is typed for a portable history and is handed the hinted one unchanged.
  await collect(other(seen)({ messages }));
  await collect(anthropic(client(sent, says("ok")), options)({ messages }));
  assert.deepEqual(
    sent[0].messages[0].content.map((b: any) => b.cache_control),
    [{ type: "ephemeral" }, undefined],
  );
});

test("the system prompt can be text parts, each with its own cache breakpoint", async () => {
  const sent: any[] = [];
  const provider = anthropic(
    client(sent, says("a"), says("b"), says("c"), says("d")),
    options,
  );
  const rules = {
    type: "text",
    text: "Long, fixed rules.",
    anthropic: { cache_control: { type: "ephemeral" } },
  } as const;
  const today = { type: "text", text: "Today is Monday." } as const;
  const messages = [user("hi")];

  await collect(provider({ system: [rules, today], messages }));
  assert.deepEqual(sent[0].system, [
    {
      type: "text",
      text: "Long, fixed rules.",
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: "Today is Monday." },
  ]);
  // A string still goes out as a string, and an empty list as no system prompt at all.
  await collect(provider({ system: "Be brief.", messages }));
  assert.equal(sent[1].system, "Be brief.");
  await collect(provider({ system: [], messages }));
  assert.equal("system" in sent[2], false);
  // Written inline, hints are checked and sent through the string sugar as well.
  await text(
    model(provider)({
      system: [{ type: "text", text: "Rules.", anthropic: rules.anthropic }],
      messages,
    }),
  );
  assert.deepEqual(sent[3].system, [
    { type: "text", text: "Rules.", cache_control: { type: "ephemeral" } },
  ]);
});

test("system parts concatenate exactly: a list means the same as its joined string", async () => {
  const sent: any[] = [];
  const provider = anthropic(
    client(sent, says("a"), says("b"), says("c")),
    options,
  );
  const here = { cache_control: { type: "ephemeral" } } as const;
  const part = (text: string, anthropic?: typeof here) =>
    ({ type: "text", text, ...(anthropic && { anthropic }) }) as const;
  const messages = [user("hi")];

  // With no hints, the list and the string produce the same request.
  await collect(
    provider({
      system: [part("Be brief. "), part("Use metric"), part(" units.")],
      messages,
    }),
  );
  await collect(provider({ system: "Be brief. Use metric units.", messages }));
  assert.equal(sent[0].system, "Be brief. Use metric units.");
  assert.deepEqual(sent[0], sent[1]);

  // A block ends only where a hint needs one; everything else is joined with nothing between.
  await collect(
    provider({
      system: [
        part("Rules, "),
        part("more rules.", here),
        part(" Today is"),
        part(" Monday."),
      ],
      messages,
    }),
  );
  assert.deepEqual(sent[2].system, [
    {
      type: "text",
      text: "Rules, more rules.",
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: " Today is Monday." },
  ]);
  assert.equal(
    sent[2].system.map((b: any) => b.text).join(""),
    "Rules, more rules. Today is Monday.",
  );
});

test("a system part that is not text is rejected here, and nothing is sent", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  const system = JSON.parse(
    JSON.stringify([{ type: "file", mediaType: "image/png", data: "x" }]),
  );
  await assert.rejects(
    collect(provider({ system, messages: [user("hi")] })),
    /cannot send a "file" part/,
  );
  assert.equal(sent.length, 0);
});

test("a portable request, with a plain system prompt in parts, is accepted by both providers", async () => {
  const sent: any[] = [];
  const seen: Request<PortableMessage>[] = [];
  const request: Request<PortableMessage> = {
    system: [{ type: "text", text: "Be brief." }],
    messages: [user("hi")],
  };
  await collect(other(seen)(request));
  await collect(anthropic(client(sent, says("ok")), options)(request));
  assert.equal(sent[0].system, "Be brief.");
  assert.equal(seen[0]!.system, request.system);
});

test("automatic caching is a provider option and reaches the request as is", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), {
    ...options,
    cache_control: { type: "ephemeral" },
  });
  await collect(provider({ messages: [user("hi")] }));
  assert.deepEqual(sent[0].cache_control, { type: "ephemeral" });
});

test("usage: each turn reports what it cost, with cached tokens counted into the input", async () => {
  const plain = anthropic(client([], says("ok")), options);
  const [turn] = await collect(plain({ messages: [user("hi")] }));
  assert.deepEqual(turn?.from === "model" && turn.usage, {
    input: 1,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
  });

  const cached = sse([
    {
      ...start,
      message: {
        ...start.message,
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
      },
    },
    ...speaks(0, "ok"),
    ...finish("end_turn"),
  ]);
  const [second] = await collect(
    anthropic(client([], cached), options)({ messages: [user("hi")] }),
  );
  assert.deepEqual(second?.from === "model" && second.usage, {
    input: 123,
    output: 5,
    cacheRead: 100,
    cacheWrite: 20,
  });
});

test("stop reasons: a paused turn is 'pause', one this version does not know is 'unknown', never 'stop'", async () => {
  const ending = async (stop_reason: string) => {
    const provider = anthropic(
      client([], sse([start, ...speaks(0, "so far"), ...finish(stop_reason)])),
      options,
    );
    const [turn] = await collect(provider({ messages: [user("hi")] }));
    return turn?.from === "model" && turn.end;
  };
  assert.equal(await ending("pause_turn"), "pause");
  assert.equal(await ending("some_future_reason"), "unknown");
  assert.equal(await ending("toString"), "unknown");
  assert.deepEqual(
    await Promise.all(
      [
        "end_turn",
        "stop_sequence",
        "tool_use",
        "max_tokens",
        "model_context_window_exceeded",
        "refusal",
      ].map(ending),
    ),
    ["stop", "stop", "stop", "length", "length", "refusal"],
  );
});

test("each turn ends exactly once, after everything else", async () => {
  const provider = anthropic(client([], thinksThenCalls), options);
  const types: string[] = [];
  for await (const chunk of provider({ messages: [user("weather?")] }))
    types.push(chunk.type);
  // Thinking: that it began, what was shown of it, then the block itself.
  assert.deepEqual(types, [
    "reasoning",
    "reasoning",
    "native",
    "text",
    "text",
    "tool_call",
    "end",
  ]);
});

test("abort: the signal cancels the request and the stream throws", async () => {
  let fetched: AbortSignal | undefined;
  const hanging = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      fetched = init?.signal ?? undefined;
      const opening = new TextEncoder().encode(
        sse([start, ...speaks(0, "hi").slice(0, 2)]),
      );
      // The reply starts and then never finishes. Like a real fetch, the body fails when the signal aborts.
      const body = new ReadableStream({
        start: (c) => {
          c.enqueue(opening);
          init?.signal?.addEventListener("abort", () =>
            c.error(init.signal?.reason),
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const controller = new AbortController();
  const chunks: string[] = [];
  const running = (async () => {
    for await (const chunk of anthropic(
      hanging,
      options,
    )({ messages: [user("hi")], signal: controller.signal }))
      chunks.push(chunk.type);
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(running);
  assert.deepEqual(chunks, ["text"]);
  assert.equal(fetched?.aborted, true);
});

test("a large file's bytes are encoded without Buffer and match it byte for byte", async () => {
  const sent: any[] = [];
  const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31) % 256);
  await collect(
    anthropic(
      client(sent, says("ok")),
      options,
    )({ messages: [user(file("application/pdf", data))] }),
  );
  assert.equal(
    sent[0].messages[0].content[0].source.data,
    Buffer.from(data).toString("base64"),
  );
});

test("a history is plain JSON: stored and loaded, it is equal and sends the same request", async () => {
  const sent: any[] = [];
  const snapshot = tool({
    name: "get_weather",
    description: "Weather, with a chart.",
    schema: { type: "object" },
    run: () => [
      { type: "text", text: "18C" },
      file("image/png", new Uint8Array([9, 9])),
    ],
  });
  const claude = anthropic(
    client(sent, thinksThenCalls, says("It is 18C."), says("x"), says("y")),
    options,
  );
  // Every kind of part the library has: text, both kinds of file, a hint, thinking,
  // a tool call, a tool result holding a file, and each turn's end and usage.
  const messages: AnthropicMessage[] = [
    user(
      {
        ...file("image/png", new Uint8Array([1, 2, 3])),
        anthropic: { cache_control: { type: "ephemeral" } },
      },
      file("application/pdf", new URL("https://example.com/a.pdf")),
      "weather?",
    ),
  ];
  messages.push(...(await collect(claude({ messages, tools: [snapshot] }))));
  messages.push({
    from: "tool",
    content: await Promise.all(
      pendingToolCalls(messages).map((call) => runToolCall([snapshot], call)),
    ),
  });
  messages.push(...(await collect(claude({ messages, tools: [snapshot] }))));
  messages.push({
    from: "tool",
    content: [
      {
        type: "tool_result",
        id: "x",
        content: [{ type: "text", text: "no" }],
        error: true,
      },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.from),
    ["user", "model", "tool", "model", "tool"],
  );

  // No function from this library is involved in storing or loading.
  const loaded = JSON.parse(JSON.stringify(messages)) as AnthropicMessage[];
  assert.deepEqual(loaded, messages);

  await collect(
    claude({ messages: [...messages.slice(0, 4), user("and tomorrow?")] }),
  );
  await collect(
    claude({ messages: [...loaded.slice(0, 4), user("and tomorrow?")] }),
  );
  assert.deepEqual(sent[3], sent[2]);
  const [image, pdf] = sent[2].messages[0].content;
  assert.deepEqual(image.source, {
    type: "base64",
    media_type: "image/png",
    data: "AQID",
  });
  assert.deepEqual(pdf.source, {
    type: "url",
    url: "https://example.com/a.pdf",
  });
  assert.equal(sent[2].messages[1].content[0].signature, "sig");
  assert.deepEqual(sent[2].messages[2].content[0].content[1].source, {
    type: "base64",
    media_type: "image/png",
    data: "CQk=",
  });
});

test("a file part with no usable content is rejected here, never sent empty", async () => {
  const sent: any[] = [];
  const claude = anthropic(client(sent, says("ok")), options);
  const stored = (part: object) =>
    JSON.parse(
      JSON.stringify([{ from: "user", content: [part] }]),
    ) as AnthropicMessage[];
  // Raw bytes that went through JSON, as an earlier version of this library would have written them.
  await assert.rejects(
    collect(
      claude({
        messages: stored({
          type: "file",
          mediaType: "image/png",
          data: new Uint8Array([1, 2]),
        }),
      }),
    ),
    /needs base64 "data" or a "url"/,
  );
  await assert.rejects(
    collect(
      claude({ messages: stored({ type: "file", mediaType: "image/png" }) }),
    ),
    /needs base64 "data" or a "url"/,
  );
  assert.equal(sent.length, 0);
});

test("a turn holding only another provider's private parts is left out, not sent empty", async () => {
  const sent: any[] = [];
  const messages: PortableMessage[] = [
    user("one"),
    {
      from: "model",
      content: [{ type: "native", provider: "other", value: {} }],
      end: "stop",
    },
    user("two"),
  ];
  await collect(anthropic(client(sent, says("ok")), options)({ messages }));
  assert.deepEqual(
    sent[0].messages.map((m: any) => m.role),
    ["user", "user"],
  );
});

test("a part with no known type and no provider name is rejected here, and nothing is sent", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  // As a history comes back from storage: untyped, with a bare provider-specific part.
  const stored = (content: object[], from = "model") =>
    JSON.parse(
      JSON.stringify([
        { from: "user", content: [{ type: "text", text: "hi" }] },
        { from, content },
      ]),
    ) as PortableMessage[];
  await assert.rejects(
    collect(
      provider({ messages: stored([{ type: "scratchpad", encrypted: "x" }]) }),
    ),
    /cannot send a "scratchpad" part/,
  );
  await assert.rejects(
    collect(
      provider({ messages: stored([{ type: "sticker", id: 1 }], "user") }),
    ),
    /cannot send a "sticker" part/,
  );
  await assert.rejects(
    collect(provider({ messages: stored([], "narrator") })),
    /from "narrator"/,
  );
  assert.equal(sent.length, 0);
});

test("model() still accepts files through the sugar", async () => {
  const sent: any[] = [];
  const ask = model(anthropic(client(sent, says("a cat")), options));
  const picture = file("image/png", new Uint8Array([1]));
  assert.equal(
    await text(ask({ messages: [user(picture, "what is this?")] })),
    "a cat",
  );
  assert.equal(blocks(sent[0].messages[0]), "image+text");
});

test("a file type Anthropic cannot take is an error, not a silent drop", async () => {
  const provider = anthropic(client([]), options);
  const audio = user(file("audio/wav", new Uint8Array()));
  await assert.rejects(collect(provider({ messages: [audio] })), /audio\/wav/);
});

// Must not compile: a provider-specific part with no provider name on it.
export const illegal = (claude: ReturnType<typeof anthropic>) => {
  // @ts-expect-error a bare provider-specific part is not part of a portable history
  claude({
    messages: [
      { from: "model", content: [{ type: "reasoning", encrypted: "x" }] },
    ],
  });
  // @ts-expect-error a hint has to be one Anthropic defines
  claude({
    messages: [
      {
        from: "user",
        content: [
          {
            type: "text",
            text: "hi",
            anthropic: { cache_control: { type: "forever" } },
          },
        ],
      },
    ],
  });
  // @ts-expect-error and nothing else may ride in the field
  claude({
    messages: [
      {
        from: "user",
        content: [{ type: "text", text: "hi", anthropic: { temperature: 0 } }],
      },
    ],
  });
  // @ts-expect-error the same holds for a hint on a system part
  claude({
    system: [
      {
        type: "text",
        text: "Rules.",
        anthropic: { cache_control: { type: "forever" } },
      },
    ],
    messages: [],
  });
  // @ts-expect-error and it still holds through the string sugar
  model(claude)({
    system: [
      {
        type: "text",
        text: "Rules.",
        anthropic: { cache_control: { type: "forever" } },
      },
    ],
    messages: [],
  });
  // @ts-expect-error a system part is text, never a file
  claude({
    system: [{ type: "file", mediaType: "image/png", data: "" }],
    messages: [],
  });
};

// ── Reasoning ───────────────────────────────────────────────────────────────

test("thinking is told the moment it begins, before anything of it can be shown", async () => {
  const provider = anthropic(client([], thinksThenSays("Blue.")), options);
  const chunks: object[] = [];
  for await (const chunk of provider({ messages: [user("a colour?")] }))
    chunks.push(chunk);
  assert.deepEqual(chunks.slice(0, 3), [
    { type: "reasoning", text: "" },
    { type: "reasoning", text: "hmm" },
    {
      type: "native",
      provider: "anthropic",
      value: { type: "thinking", thinking: "hmm", signature: "sig" },
    },
  ]);
});

test("thinking that Anthropic does not show is still told: a reasoning part with nothing in it", async () => {
  // As the API sends it when no summary was asked for: one empty delta, then the signature.
  const silent = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig" },
    },
    { type: "content_block_stop", index: 0 },
  ];
  const redacted = [
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "opaque" },
    },
    { type: "content_block_stop", index: 1 },
  ];
  const provider = anthropic(
    client(
      [],
      sse([
        start,
        ...silent,
        ...redacted,
        ...speaks(2, "Blue."),
        ...finish("end_turn"),
      ]),
    ),
    options,
  );
  const types: string[] = [];
  const [turn] = await collect(
    (async function* () {
      for await (const chunk of provider({ messages: [user("a colour?")] })) {
        types.push(chunk.type);
        yield chunk;
      }
    })(),
  );
  // One piece per block, at its start, and none for the empty delta.
  assert.deepEqual(types, [
    "reasoning",
    "native",
    "reasoning",
    "native",
    "text",
    "end",
  ]);
  assert.deepEqual(
    turn?.content.map((part) => (part.type === "reasoning" ? part : part.type)),
    [
      { type: "reasoning", text: "" },
      "native",
      { type: "reasoning", text: "" },
      "native",
      "text",
    ],
  );
});

test("reasoning is never sent: with it in a history or taken out, the request is the same", async () => {
  const sent: any[] = [];
  const provider = anthropic(
    client(sent, thinksThenSays("Blue."), says("ok"), says("ok")),
    options,
  );
  const messages: PortableMessage[] = [user("a colour?")];
  messages.push(...(await collect(provider({ messages }))), user("another"));
  assert.ok(messages[1]?.content.some((part) => part.type === "reasoning"));

  const without = messages.map(
    (message): PortableMessage =>
      message.from === "model"
        ? {
            ...message,
            content: message.content.filter(
              (part) => part.type !== "reasoning",
            ),
          }
        : message,
  );
  await collect(provider({ messages }));
  await collect(provider({ messages: without }));
  assert.deepEqual(sent[1], sent[2]);
  // What does go back is the thinking block itself, whole.
  assert.deepEqual(sent[1].messages.map(blocks), [
    "text",
    "thinking+text",
    "text",
  ]);
});

test("a turn holding only reasoning is left out, not sent empty", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  const messages: PortableMessage[] = [
    user("a colour?"),
    {
      from: "model",
      content: [{ type: "reasoning", text: "thinking it over" }],
    },
    user("well?"),
  ];
  await collect(provider({ messages }));
  assert.deepEqual(
    sent[0].messages.map((m: any) => m.role),
    ["user", "user"],
  );
});
