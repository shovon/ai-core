import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  anthropic,
  type AnthropicMessage,
  type AnthropicOut,
  type AnthropicTool,
} from "./anthropic.ts";
import {
  append,
  collect,
  file,
  isSource,
  isText,
  isToolInput,
  parse,
  pendingToolCalls,
  text,
  toolResult,
  totalUsage,
  user,
  type AnyMessage,
  type NativePart,
  type Part,
  type PortableMessage,
  type Provider,
  type ReasoningPart,
  type Reply,
  type Request,
  type SourcePart,
  type Takes,
  type TextPart,
  type ToolCall,
  type ToolInputPart,
  type ToolSpec,
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
const weather: ToolSpec = {
  name: "get_weather",
  description: "Weather.",
  schema: { type: "object" },
};
// Running a tool is the caller's business: here every call comes to the same thing.
const answered = (call: ToolCall) => toolResult(call, "18C");
const blocks = (m: any) => m.content.map((b: any) => b.type).join("+");

test("a tool call is told as it is written: that it has begun, each piece of its input, then the call itself, whole", async () => {
  const provider = anthropic(client([], thinksThenCalls), options);
  const chunks: object[] = [];
  let reply: Reply<AnthropicOut> = [];
  const growing: unknown[] = [];
  for await (const chunk of provider({ messages: [user("weather?")] })) {
    chunks.push(chunk);
    reply = append(reply, chunk);
    growing.push(reply[0]?.content.at(-1));
  }
  const writes = (text: string) => ({
    type: "tool_input",
    id: "toolu_1",
    name: "get_weather",
    text,
  });
  const called = {
    type: "tool_call",
    id: "toolu_1",
    name: "get_weather",
    input: { city: "Toronto" },
  };
  // From the call's beginning to the call itself, in order; only the turn's end comes after.
  assert.deepEqual(chunks.slice(-5, -1), [
    writes(""),
    writes('{"city":'),
    writes('"Toronto"}'),
    called,
  ]);
  assert.equal((chunks.at(-1) as { type: string }).type, "end");
  // Folded as it arrives, the input is one part that grows, and the call takes its place.
  assert.deepEqual(growing.slice(-5), [
    writes(""),
    writes('{"city":'),
    writes('{"city":"Toronto"}'),
    called,
    called,
  ]);
  assert.ok(!reply[0]?.content.some(isToolInput));
});

test("reply: text streams; a tool call is left whole; thinking is told as reasoning and arrives whole as a native part", async () => {
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
    content: pendingToolCalls(messages).map(answered),
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
      | TextPart
      | SourcePart
      | ReasoningPart
      | ToolInputPart
      | ToolCall
      | NativePart
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
  // Written inline, hints are checked and sent as well.
  await collect(
    provider({
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

test("a tool's settings for Anthropic are sent as they are, beside what the tool is", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok"), says("ok")), options);
  // Written the way a tool is: one value, typed by its schema, with Anthropic's settings on it.
  const strict = {
    name: "get_weather",
    description: "Weather.",
    schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    anthropic: {
      strict: true,
      eager_input_streaming: true,
      cache_control: { type: "ephemeral" },
    },
  } as const satisfies AnthropicTool;
  await collect(provider({ messages: [user("hi")], tools: [strict, weather] }));
  assert.deepEqual(sent[0].tools, [
    {
      name: "get_weather",
      description: "Weather.",
      input_schema: strict.schema,
      strict: true,
      eager_input_streaming: true,
      cache_control: { type: "ephemeral" },
    },
    // A tool with no settings goes as it always did.
    {
      name: "get_weather",
      description: "Weather.",
      input_schema: { type: "object" },
    },
  ]);
  // The schema still types and checks a call's input, settings or none.
  const city: string = parse(strict.schema, { city: "Toronto" }).city;
  assert.equal(city, "Toronto");
});

test("a tool's settings cannot replace what the tool is, and a field for another provider is not sent", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  // Held in a variable, a tool may carry more than the type knows, as one read from storage might.
  const tool = {
    ...weather,
    anthropic: {
      input_examples: [{ city: "Toronto" }],
      name: "replaced",
      description: "Replaced.",
      input_schema: { type: "string" },
    },
    other: { parallel: false },
  };
  // Any provider's request type takes it: the field rides along unseen.
  const portable: Provider<PortableMessage, Part> = provider;
  await collect(portable({ messages: [user("hi")], tools: [tool] }));
  assert.deepEqual(sent[0].tools, [
    {
      name: "get_weather",
      description: "Weather.",
      input_schema: { type: "object" },
      input_examples: [{ city: "Toronto" }],
    },
  ]);
});

test("a turn ends with Anthropic's account of the response: its id and model, and the message itself without its content", async () => {
  const sent: any[] = [];
  // A reply that stopped on a stop sequence, from a response that names its request.
  const stopped = sse([
    start,
    ...speaks(0, "One, two,"),
    {
      type: "message_delta",
      delta: { stop_reason: "stop_sequence", stop_sequence: " three" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ]);
  const replies = [stopped, says("ok")];
  const provider = anthropic(
    new Anthropic({
      apiKey: "test",
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(replies[sent.length - 1], {
          headers: {
            "content-type": "text/event-stream",
            "request-id": `req_${sent.length}`,
          },
        });
      },
    }),
    options,
  );
  const messages: AnthropicMessage[] = [user("count")];
  const chunks: object[] = [];
  let reply: Reply<AnthropicOut> = [];
  for await (const chunk of provider({ messages })) {
    chunks.push(chunk);
    reply = append(reply, chunk);
  }
  const account = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    stop_reason: "stop_sequence",
    stop_sequence: " three",
    usage: { input_tokens: 1, output_tokens: 5 },
    request_id: "req_1",
  };
  assert.deepEqual(chunks.at(-1), {
    type: "end",
    reason: "stop",
    usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
    id: "msg_1",
    model: "m",
    anthropic: account,
  });

  // Folded, it is on the turn, and typed there: which stop sequence it was is read by name.
  messages.push(...reply);
  const turn = messages[1];
  assert.ok(turn?.from === "model");
  assert.deepEqual([turn.id, turn.model], ["msg_1", "m"]);
  assert.deepEqual(turn.anthropic, account);
  const matched: string | null | undefined = turn.anthropic?.stop_sequence;
  const request: string | null | undefined = turn.anthropic?.request_id;
  assert.deepEqual([matched, request], [" three", "req_1"]);
  // It is plain data: stored and loaded, the turn is equal.
  assert.deepEqual(JSON.parse(JSON.stringify(turn)), turn);

  // None of it is sent back: a turn goes out as its role and content alone.
  messages.push(user("go on"));
  await collect(provider({ messages }));
  assert.deepEqual(sent[1].messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "One, two," }],
  });
});

test("a response that does not name its request still ends with the rest of the account", async () => {
  const provider = anthropic(client([], says("ok")), options);
  const [turn] = await collect(provider({ messages: [user("hi")] }));
  assert.ok(turn?.from === "model");
  const kept: AnthropicMessage = turn;
  assert.ok(kept.from === "model");
  assert.equal(kept.anthropic?.request_id, null);
  assert.equal(kept.anthropic?.stop_reason, "end_turn");
  // What the SDK left undefined is left out, not kept as a hole.
  assert.ok(
    Object.values(kept.anthropic ?? {}).every((value) => value !== undefined),
  );
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

test("usage: thinking tokens are told as reasoning, within the output, when Anthropic says how many", async () => {
  // As the API ends a turn that thought: the count comes with the final usage.
  const thought = sse([
    start,
    ...thinks,
    ...speaks(1, "Blue."),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 40 } },
    },
    { type: "message_stop" },
  ]);
  const provider = anthropic(client([], thought, says("ok")), options);
  const messages: AnthropicMessage[] = [user("a colour?")];
  messages.push(...(await collect(provider({ messages }))));
  const turn = messages[1];
  assert.ok(turn?.from === "model");
  assert.deepEqual(turn.usage, {
    input: 1,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 40,
  });
  // Anthropic's own count is there beside it, with whatever else it reports.
  assert.deepEqual(turn.anthropic?.usage.output_tokens_details, {
    thinking_tokens: 40,
  });

  // A turn Anthropic gives no such count for reports none, and adds nothing to the total.
  messages.push(user("thanks"));
  messages.push(...(await collect(provider({ messages }))));
  const last = messages.at(-1);
  assert.ok(last?.from === "model" && last.usage);
  assert.equal("reasoning" in last.usage, false);
  assert.equal(totalUsage(messages).reasoning, 40);
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
  // A call: that it began, each piece of its input, then the call itself.
  assert.deepEqual(types, [
    "reasoning",
    "reasoning",
    "native",
    "text",
    "text",
    "tool_input",
    "tool_input",
    "tool_input",
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
  const snapshot: ToolSpec = {
    name: "get_weather",
    description: "Weather, with a chart.",
    schema: { type: "object" },
  };
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
    content: pendingToolCalls(messages).map((call) =>
      toolResult(call, [
        { type: "text", text: "18C" },
        file("image/png", new Uint8Array([9, 9])),
      ]),
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

test("a file type Anthropic cannot take is an error, not a silent drop", async () => {
  const provider = anthropic(client([]), options);
  const audio = user(file("audio/wav", new Uint8Array()));
  await assert.rejects(collect(provider({ messages: [audio] })), /audio\/wav/);
});

test("a file a model made, in another provider's turn, goes to Anthropic as a file does anywhere", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("A cat.")), options);
  // A portable history in which some other model drew a picture.
  const drawn = file("image/png", new Uint8Array([1, 2, 3]));
  const messages: PortableMessage[] = [
    user("draw a cat"),
    {
      from: "model",
      content: [{ type: "text", text: "Here it is." }, drawn],
      end: "stop",
    },
    user("what did you draw?"),
  ];
  await collect(provider({ messages }));
  assert.deepEqual(sent[0].messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Here it is." },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AQID" },
      },
    ],
  });
  // A kind Anthropic cannot take is an error there too, never a silent drop.
  const sung: PortableMessage = {
    from: "model",
    content: [file("audio/wav", new Uint8Array())],
    end: "stop",
  };
  await assert.rejects(
    collect(provider({ messages: [user("sing"), sung, user("again")] })),
    /audio\/wav/,
  );
  assert.equal(sent.length, 1);
});

// ── Documents and sources ───────────────────────────────────────────────────

test("a file's settings for Anthropic go on a document as they are; an image takes only its cache breakpoint", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  const settings = {
    citations: { enabled: true },
    title: "Q3 report",
    context: "Unaudited.",
    cache_control: { type: "ephemeral" },
  } as const;
  const messages: AnthropicMessage[] = [
    user(
      { ...file("application/pdf", new Uint8Array([1, 2, 3])), anthropic: settings },
      { ...file("image/png", new Uint8Array([1, 2, 3])), anthropic: settings },
      "What drove the margin change?",
    ),
  ];
  await collect(provider({ messages }));
  assert.deepEqual(sent[0].messages[0].content.slice(0, 2), [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "AQID" },
      ...settings,
    },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("a text file goes to Anthropic as a document holding the text itself", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok"), says("ok")), options);
  const words = "Freight rose 31%.\nCafé margins held. 🚚";
  const notes = {
    ...file("text/plain", new TextEncoder().encode(words)),
    anthropic: { citations: { enabled: true }, title: "Notes" },
  };
  await collect(provider({ messages: [user(notes, "Summarise.")] }));
  assert.deepEqual(sent[0].messages[0].content[0], {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: words },
    citations: { enabled: true },
    title: "Notes",
  });
  // Anthropic has no way to be given one by link, so that is said here, and nothing is sent.
  const linked = user(file("text/plain", new URL("https://example.com/a.txt")));
  await assert.rejects(
    collect(provider({ messages: [linked] })),
    /^Error: anthropic: cannot send a text\/plain file by link$/,
  );
  assert.equal(sent.length, 1);

  // Inside a tool result no hint is read: the file goes, its settings do not.
  const call: ToolCall = { type: "tool_call", id: "toolu_1", name: "read", input: {} };
  await collect(
    provider({
      messages: [
        user("read it"),
        { from: "model", content: [call], end: "stop" },
        { from: "tool", content: [toolResult(call, [notes])] },
      ],
      tools: [weather],
    }),
  );
  assert.deepEqual(sent[1].messages[2].content[0].content, [
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: words },
    },
  ]);
});

// A reply that cites: plain text, then a passage resting on two citations, then plain text again.
const onPage: Anthropic.CitationPageLocation = {
  type: "page_location",
  cited_text: "Freight expense rose 31%.",
  document_index: 0,
  document_title: "Q3 report",
  start_page_number: 4,
  end_page_number: 5,
  file_id: null,
};
const onWeb: Anthropic.CitationsWebSearchResultLocation = {
  type: "web_search_result_location",
  cited_text: "Container rates doubled.",
  encrypted_index: "abc",
  title: "Shipping news",
  url: "https://example.com/rates",
};
const citing = sse([
  start,
  ...speaks(0, "Margins fell, "),
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "", citations: [] },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "citations_delta", citation: onPage },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "mainly on " },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "citations_delta", citation: onWeb },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "freight." },
  },
  { type: "content_block_stop", index: 1 },
  ...speaks(2, " Pricing was flat."),
  ...finish("end_turn"),
]);
const pageSource = {
  type: "source",
  span: 18,
  quote: "Freight expense rose 31%.",
  title: "Q3 report",
  anthropic: onPage,
};
const webSource = {
  type: "source",
  span: 18,
  quote: "Container rates doubled.",
  title: "Shipping news",
  url: "https://example.com/rates",
  anthropic: onWeb,
};

test("what a passage rests on is told as sources, directly after its text, each with how much text is its own", async () => {
  const provider = anthropic(client([], citing), options);
  const chunks: object[] = [];
  for await (const chunk of provider({ messages: [user("margins?")] }))
    chunks.push(chunk);
  assert.deepEqual(chunks.slice(0, -1), [
    { type: "text", text: "Margins fell, " },
    { type: "text", text: "mainly on " },
    { type: "text", text: "freight." },
    pageSource,
    webSource,
    { type: "text", text: " Pricing was flat." },
  ]);

  // Folded, the passage has joined the text before it, and the span still says which part is cited.
  const [turn] = await collect(
    anthropic(client([], citing), options)({ messages: [user("margins?")] }),
  );
  assert.ok(turn?.from === "model");
  assert.deepEqual(turn.content, [
    { type: "text", text: "Margins fell, mainly on freight." },
    pageSource,
    webSource,
    { type: "text", text: " Pricing was flat." },
  ]);
  const [said, first] = turn.content;
  assert.ok(said && isText(said) && first && isSource(first));
  assert.equal(said.text.slice(-(first.span ?? 0)), "mainly on freight.");
  // Anthropic's own citation keeps its type: narrowing reaches the pages.
  assert.ok(first.anthropic.type === "page_location");
  assert.equal(first.anthropic.start_page_number, 4);
  assert.equal(
    await text(anthropic(client([], citing), options)({ messages: [] })),
    "Margins fell, mainly on freight. Pricing was flat.",
  );
});

test("Anthropic's own sources go back as citations on the passage they support, and no one else's are sent", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, citing, says("ok"), says("ok")), options);
  const messages: AnthropicMessage[] = [user("margins?")];
  messages.push(...(await collect(provider({ messages }))), user("go on"));
  await collect(provider({ messages }));
  // The passage is its own block again, with both citations; the text around it has none.
  assert.deepEqual(sent[1].messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Margins fell, " },
      { type: "text", text: "mainly on freight.", citations: [onPage, onWeb] },
      { type: "text", text: " Pricing was flat." },
    ],
  });

  // Stored and loaded, the history sends the same request.
  await collect(provider({ messages: JSON.parse(JSON.stringify(messages)) }));
  assert.deepEqual(sent[2], sent[1]);
});

test("a source is sent only where Anthropic can take it: its own, after text, with a cache breakpoint kept at the end", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok")), options);
  const messages: AnthropicMessage[] = [
    user("margins?"),
    {
      from: "model",
      content: [
        // With nothing before it, there is no text for it to be a citation on.
        { type: "source", quote: "Nothing before me.", anthropic: onPage },
        {
          type: "text",
          text: "Margins fell, mainly on freight.",
          anthropic: { cache_control: { type: "ephemeral" } },
        },
        // Another provider's: it has no citation of Anthropic's to send.
        { type: "source", quote: "From elsewhere.", url: "https://example.com" },
        { type: "source", span: 18, anthropic: onPage },
        { type: "text", text: " All of this is cited." },
        // With no span, it speaks for the whole of the text part before it.
        { type: "source", anthropic: onWeb },
      ],
      end: "stop",
    },
    user("go on"),
  ];
  await collect(provider({ messages }));
  assert.deepEqual(sent[0].messages[1].content, [
    { type: "text", text: "Margins fell, " },
    {
      type: "text",
      text: "mainly on freight.",
      citations: [onPage],
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: " All of this is cited.", citations: [onWeb] },
  ]);
});

// ── Shapes ──────────────────────────────────────────────────────────────────

// A schema Anthropic takes as it is: closed objects, and no bound it does not enforce.
const verdict = {
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      why: { anyOf: [{ type: "string" }, { type: "null" }] },
      steps: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["ok", "why", "steps"],
    additionalProperties: false,
  },
} as const;
// The schema Anthropic was sent for a shape, and nothing else of the request.
const sentFor = async (schema: object) => {
  const sent: any[] = [];
  const claude = anthropic(client(sent, says("{}")), options);
  await collect(claude({ messages: [user("go")], shape: { schema } }));
  return sent[0].output_config.format.schema;
};
const strings = { type: "array", items: { type: "string" } };

test("a shape is asked for as Anthropic's output format, and the answer comes back as text to parse", async () => {
  const sent: any[] = [];
  const written = '{"ok":true,"why":null,"steps":["look"]}';
  const inPieces = sse([
    start,
    ...speaks(0, written.slice(0, 12), written.slice(12)),
    ...finish("end_turn"),
  ]);
  const claude = anthropic(client(sent, inPieces, says("plain")), options);
  const messages = [user("Is it safe?")];
  const before = structuredClone(verdict.schema);
  const answer = parse(
    verdict.schema,
    JSON.parse(await text(claude({ messages, shape: verdict }))),
  );
  assert.deepEqual(answer, { ok: true, why: null, steps: ["look"] });
  assert.deepEqual(sent[0].output_config, {
    format: { type: "json_schema", schema: verdict.schema },
  });
  // Only the schema is sent: nothing else of the shape, and the shape is as it was.
  assert.deepEqual(Object.keys(sent[0].output_config.format), [
    "type",
    "schema",
  ]);
  assert.deepEqual(verdict.schema, before);
  // With no shape, the request says nothing of a format.
  await collect(claude({ messages }));
  assert.equal("output_config" in sent[1], false);
});

test("a shape shares output_config with the provider's own options, and is used in place of a format set there", async () => {
  const sent: any[] = [];
  const elsewhere = {
    type: "json_schema",
    schema: { type: "string" },
  } as const;
  const claude = anthropic(client(sent, says("{}"), says('""')), {
    ...options,
    output_config: { effort: "low", format: elsewhere },
  });
  const messages = [user("go")];
  await collect(claude({ messages, shape: verdict }));
  assert.deepEqual(sent[0].output_config, {
    effort: "low",
    format: { type: "json_schema", schema: verdict.schema },
  });
  // Without a shape, the options go out as they were given.
  await collect(claude({ messages }));
  assert.deepEqual(sent[1].output_config, { effort: "low", format: elsewhere });
});

// ── Settings for one request ────────────────────────────────────────────────

// Everything a request was sent with but its messages.
const settingsSent = ({ messages, ...rest }: any) => rest;

test("settings for one request are laid over the provider's own, for that request alone", async () => {
  const sent: any[] = [];
  const claude = anthropic(client(sent, says("ok"), says("ok")), {
    ...options,
    output_config: { effort: "high" },
    stop_sequences: ["END"],
    cache_control: { type: "ephemeral" },
  });
  const messages = [user("go")];
  await collect(
    claude({
      messages,
      native: {
        anthropic: {
          model: "claude-haiku-5-5",
          output_config: { effort: "low" },
          stop_sequences: ["\n"],
          tool_choice: { type: "none" },
        },
      },
    }),
  );
  // Each setting given takes the place of the provider's; the rest stay. The
  // field itself is never sent.
  assert.deepEqual(settingsSent(sent[0]), {
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    output_config: { effort: "low" },
    stop_sequences: ["\n"],
    cache_control: { type: "ephemeral" },
    tool_choice: { type: "none" },
    stream: true,
  });
  // The next request, with no settings, goes as the provider was made.
  await collect(claude({ messages }));
  assert.deepEqual(settingsSent(sent[1]), {
    model: "claude-opus-5-5",
    max_tokens: 1024,
    output_config: { effort: "high" },
    stop_sequences: ["END"],
    cache_control: { type: "ephemeral" },
    stream: true,
  });
});

test("output_config is laid over one field at a time, and a shape is used in place of a format from anywhere", async () => {
  const sent: any[] = [];
  const elsewhere = {
    type: "json_schema",
    schema: { type: "string" },
  } as const;
  const another = {
    type: "json_schema",
    schema: { type: "number" },
  } as const;
  const claude = anthropic(client(sent, says('""'), says("0"), says("{}")), {
    ...options,
    output_config: { effort: "high", format: elsewhere },
  });
  const messages = [user("go")];
  // An effort for one request keeps the format the provider was made with.
  await collect(
    claude({
      messages,
      native: { anthropic: { output_config: { effort: "low" } } },
    }),
  );
  assert.deepEqual(sent[0].output_config, { effort: "low", format: elsewhere });
  // A format for one request keeps the effort.
  await collect(
    claude({
      messages,
      native: { anthropic: { output_config: { format: another } } },
    }),
  );
  assert.deepEqual(sent[1].output_config, { effort: "high", format: another });
  // A shape is what the request asks for, so no format takes its place.
  await collect(
    claude({
      messages,
      shape: verdict,
      native: {
        anthropic: { output_config: { effort: "low", format: another } },
      },
    }),
  );
  assert.deepEqual(sent[2].output_config, {
    effort: "low",
    format: { type: "json_schema", schema: verdict.schema },
  });
  // A provider made with no output_config takes one from the request whole.
  const alone: any[] = [];
  const bare = anthropic(client(alone, says("ok")), options);
  await collect(
    bare({
      messages,
      native: { anthropic: { output_config: { effort: "low" } } },
    }),
  );
  assert.deepEqual(alone[0].output_config, { effort: "low" });
});

test("a setting left undefined takes nothing away, and an entry for another provider is not read", async () => {
  const sent: any[] = [];
  const made = {
    ...options,
    output_config: { effort: "high" },
    stop_sequences: ["END"],
  } as const;
  const claude = anthropic(client(sent, says("ok"), says("ok")), {
    ...made,
    stop_sequences: [...made.stop_sequences],
  });
  const request = {
    messages: [user("go")],
    native: {
      anthropic: {
        model: undefined,
        stop_sequences: undefined,
        output_config: { effort: undefined },
      },
      other: { stop_sequences: ["X"], temperature: 0 },
    },
  };
  await collect(claude(request));
  assert.deepEqual(settingsSent(sent[0]), { ...made, stream: true });
  // Stored and loaded, the request means the same.
  await collect(claude(JSON.parse(JSON.stringify(request))));
  assert.deepEqual(sent[1], sent[0]);
});

test("settings cannot replace what the request is, and anything there but an object is no settings", async () => {
  const sent: any[] = [];
  const claude = anthropic(
    client(sent, says("ok"), says("ok"), says("ok")),
    options,
  );
  // Any provider's request type takes the field: what is in it rides along unseen.
  const portable: Provider<PortableMessage, Part> = claude;
  const replacing = {
    messages: [],
    system: "Replaced.",
    tools: [{ name: "replaced" }],
    stop_sequences: ["\n"],
  };
  await collect(
    portable({
      system: "Be brief.",
      messages: [user("hi")],
      tools: [weather],
      native: { anthropic: replacing },
    }),
  );
  assert.equal(sent[0].system, "Be brief.");
  assert.equal(sent[0].messages.length, 1);
  assert.deepEqual(
    sent[0].tools.map((tool: any) => tool.name),
    ["get_weather"],
  );
  assert.deepEqual(sent[0].stop_sequences, ["\n"]);
  // A request with no system prompt and no tools still has none.
  await collect(
    portable({ messages: [user("hi")], native: { anthropic: replacing } }),
  );
  assert.equal(sent[1].messages.length, 1);
  assert.equal("system" in sent[1], false);
  assert.equal("tools" in sent[1], false);
  // As one read from storage might be: not settings at all.
  await collect(
    portable({ messages: [user("hi")], native: { anthropic: "low" } }),
  );
  assert.deepEqual(settingsSent(sent[2]), { ...options, stream: true });
});

test("settings ride through a wrapper that knows nothing of Anthropic", async () => {
  const sent: any[] = [];
  const claude = anthropic(client(sent, says("ok")), options);
  // Typed against Provider, as a wrapper for any provider would be. It changes
  // one field and passes the rest of the request on.
  const brief =
    <In extends AnyMessage, Out extends Part>(
      provider: Provider<In, Out>,
    ): Provider<In, Out> =>
    (request) =>
      provider({ ...request, system: "Be brief." });
  await collect(
    brief(claude)({
      messages: [user("hi")],
      native: { anthropic: { output_config: { effort: "low" } } },
    }),
  );
  assert.equal(sent[0].system, "Be brief.");
  assert.deepEqual(sent[0].output_config, { effort: "low" });
});

test("a shape's bounds that Anthropic does not enforce are left out and said in the description; the reader still checks them", async () => {
  const rated = {
    schema: {
      type: "object",
      properties: {
        score: { type: "integer", minimum: 1, maximum: 5 },
        title: {
          type: "string",
          description: "A headline.",
          minLength: 3,
          maxLength: 60,
        },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 12 },
          minItems: 2,
          maxItems: 4,
        },
        some: { ...strings, minItems: 1 },
        any: { ...strings, minItems: 0 },
      },
      required: ["score", "title", "tags", "some", "any"],
      additionalProperties: false,
    },
  };
  const before = structuredClone(rated.schema);
  assert.deepEqual(await sentFor(rated.schema), {
    type: "object",
    properties: {
      score: {
        type: "integer",
        description: "Must be 1 or more. Must be 5 or less.",
      },
      title: {
        type: "string",
        description:
          "A headline. Must be 3 or more characters long. Must be 60 or fewer characters long.",
      },
      tags: {
        type: "array",
        items: {
          type: "string",
          description: "Must be 12 or fewer characters long.",
        },
        description: "Must have 2 or more items. Must have 4 or fewer items.",
      },
      // Requiring a list to be non-empty, or not, is the one bound Anthropic enforces.
      some: { ...strings, minItems: 1 },
      any: { ...strings, minItems: 0 },
    },
    required: ["score", "title", "tags", "some", "any"],
    additionalProperties: false,
  });
  assert.deepEqual(rated.schema, before);
  // The same schema is sent the same way every time.
  assert.deepEqual(await sentFor(rated.schema), await sentFor(rated.schema));
  // What Anthropic was not held to, parse() holds the answer to.
  const outOfBounds = {
    score: 9,
    title: "ok",
    tags: ["a", "b"],
    some: ["x"],
    any: [],
  };
  assert.throws(
    () => parse(rated.schema, outOfBounds),
    /^Error: score must be 5 or less; title must be 3 or more characters long$/,
  );
});

test("a shape's objects are closed for Anthropic, at every depth, and a schema that already fits goes out as it is", async () => {
  const lat = { lat: { type: "number" } };
  const id = { id: { type: "string" } };
  const n = { n: { type: "integer" } };
  assert.deepEqual(
    await sentFor({
      type: "object",
      properties: {
        where: { type: "object", properties: lat, additionalProperties: true },
        rows: { type: "array", items: { properties: id } },
        either: {
          anyOf: [{ type: "null" }, { type: "object", properties: n }],
        },
        nothing: { type: "object", additionalProperties: false },
      },
    }),
    {
      type: "object",
      properties: {
        where: { type: "object", properties: lat, additionalProperties: false },
        rows: {
          type: "array",
          items: { properties: id, additionalProperties: false },
        },
        either: {
          anyOf: [
            { type: "null" },
            { type: "object", properties: n, additionalProperties: false },
          ],
        },
        // Closed with nothing listed asks for exactly {}, which Anthropic can give.
        nothing: { type: "object", additionalProperties: false },
      },
      additionalProperties: false,
    },
  );
  assert.deepEqual(await sentFor(verdict.schema), verdict.schema);
  assert.deepEqual(await sentFor({ type: "string" }), { type: "string" });
});

test("a shape holding an open object with no listed properties is refused, saying where, and nothing is sent", async () => {
  const sent: any[] = [];
  const claude = anthropic(client(sent, says("{}")), options);
  const asking = (schema: object) =>
    collect(claude({ messages: [user("go")], shape: { schema } }));
  await assert.rejects(
    asking({ type: "object" }),
    /^Error: anthropic: cannot ask for an object with no listed properties \(the whole answer\)$/,
  );
  await assert.rejects(
    asking({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: {} } },
      },
    }),
    /no listed properties \(rows\[\]\)/,
  );
  await assert.rejects(
    asking({
      type: "object",
      properties: { extra: { type: "object", additionalProperties: true } },
    }),
    /no listed properties \(extra\)/,
  );
  assert.equal(sent.length, 0);
});

test("a shaped answer that was cut off ends as any other turn does: it is the reader that refuses it", async () => {
  const cutOff = sse([
    start,
    ...speaks(0, '{"ok":tr'),
    ...finish("max_tokens"),
  ]);
  const claude = anthropic(client([], cutOff, cutOff), options);
  const request = { messages: [user("Is it safe?")], shape: verdict };
  const [turn] = await collect(claude(request));
  assert.ok(turn?.from === "model" && turn.end === "length");
  assert.deepEqual(turn.content, [{ type: "text", text: '{"ok":tr' }]);
  await assert.rejects(text(claude(request)), /model stopped early: length/);
});

test("a shape and tools go in one request: the tools are called first, and the final answer is the JSON", async () => {
  const sent: any[] = [];
  const claude = anthropic(
    client(
      sent,
      thinksThenCalls,
      says('{"ok":false,"why":"18C","steps":["ask"]}'),
    ),
    options,
  );
  const messages: AnthropicMessage[] = [user("Is it warm?")];
  for (;;) {
    messages.push(
      ...(await collect(
        claude({ messages, tools: [weather], shape: verdict }),
      )),
    );
    const calls = pendingToolCalls(messages);
    if (calls.length === 0) break;
    messages.push({
      from: "tool",
      content: calls.map(answered),
    });
  }
  assert.deepEqual(
    sent.map((body) => [body.tools.length, body.output_config.format.type]),
    [
      [1, "json_schema"],
      [1, "json_schema"],
    ],
  );
  const last = messages.at(-1);
  assert.ok(last?.from === "model" && last.content[0]?.type === "text");
  assert.deepEqual(parse(verdict.schema, JSON.parse(last.content[0].text)), {
    ok: false,
    why: "18C",
    steps: ["ask"],
  });
});

// Must not compile: a provider-specific part with no provider name on it.
export const illegal = (claude: ReturnType<typeof anthropic>) => {
  claude({
    messages: [
      // @ts-expect-error a bare provider-specific part is not part of a portable history
      { from: "model", content: [{ type: "reasoning", encrypted: "x" }] },
    ],
  });
  claude({
    messages: [
      {
        from: "user",
        content: [
          {
            type: "text",
            text: "hi",
            // @ts-expect-error a hint has to be one Anthropic defines
            anthropic: { cache_control: { type: "forever" } },
          },
        ],
      },
    ],
  });
  claude({
    messages: [
      {
        from: "user",
        // @ts-expect-error and nothing else may ride in the field
        content: [{ type: "text", text: "hi", anthropic: { temperature: 0 } }],
      },
    ],
  });
  claude({
    system: [
      {
        type: "text",
        text: "Rules.",
        // @ts-expect-error the same holds for a hint on a system part
        anthropic: { cache_control: { type: "forever" } },
      },
    ],
    messages: [],
  });
  claude({
    // @ts-expect-error a system part is text, never a file
    system: [{ type: "file", mediaType: "image/png", data: "" }],
    messages: [],
  });
  // @ts-expect-error a tool's settings have to be ones Anthropic defines
  claude({ messages: [], tools: [{ ...weather, anthropic: { loud: true } }] });
  // @ts-expect-error and what the tool is cannot be set among them
  claude({ messages: [], tools: [{ ...weather, anthropic: { name: "x" } }] });
  claude({
    messages: [],
    // @ts-expect-error a setting for one request has to be one Anthropic defines
    native: { anthropic: { output_config: { effort: "lowest" } } },
  });
  claude({
    messages: [],
    // @ts-expect-error the provider always streams, so that is not a setting
    native: { anthropic: { stream: false } },
  });
  claude({
    messages: [],
    // @ts-expect-error what the request is cannot be set among them
    native: { anthropic: { system: "Replaced." } },
  });
  claude({
    messages: [],
    // @ts-expect-error a vendor's settings go in `native`, never beside the request's own fields
    anthropic: { output_config: { effort: "low" } },
  });
  // A wrapper that leaves the request's type as it is keeps its settings checked.
  const same =
    <R, Out extends Part>(provider: Takes<R, Out>): Takes<R, Out> =>
    (request) =>
      provider(request);
  same(claude)({
    messages: [],
    // @ts-expect-error through such a wrapper, a setting still has to be one Anthropic defines
    native: { anthropic: { output_config: { effort: "lowest" } } },
  });
  same(claude)({
    messages: [],
    native: { anthropic: { output_config: { effort: "low" } } },
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

test("tool input is never sent: with it in a history or taken out, the request is the same", async () => {
  const sent: any[] = [];
  const provider = anthropic(client(sent, says("ok"), says("ok")), options);
  // A turn whose stream stopped while a call was being written, kept as it was.
  const messages: PortableMessage[] = [
    user("the weather?"),
    {
      from: "model",
      content: [
        { type: "text", text: "Checking." },
        {
          type: "tool_input",
          id: "toolu_1",
          name: "get_weather",
          text: '{"city":"Tor',
        },
      ],
    },
    user("well?"),
  ];
  const without = messages.map(
    (message): PortableMessage =>
      message.from === "model"
        ? {
            ...message,
            content: message.content.filter(
              (part) => part.type !== "tool_input",
            ),
          }
        : message,
  );
  await collect(provider({ messages }));
  await collect(provider({ messages: without }));
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[0].messages.map(blocks), ["text", "text", "text"]);
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
