import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerToolCalls,
  append,
  attemptToolCall,
  collect,
  toolFailure,
  file,
  fitSchema,
  fitToolIds,
  isReasoning,
  isText,
  model,
  pendingToolCalls,
  toolResult,
  runToolCall,
  shape,
  text,
  tool,
  totalUsage,
  user,
  type AnyMessage,
  type End,
  type Message,
  type ModelMessage,
  type NativePart,
  type Part,
  type PortableMessage,
  type Provider,
  type ReasoningPart,
  type Reply,
  type Request,
  type TextPart,
  type Tool,
  type ToolCall,
  type ToolResult,
  type UserMessage,
} from "./library.ts";

// A provider that plays back one scripted turn per call. It accepts any
// message, so it can stand in wherever a narrower provider is expected.
// It records each request as it was when it arrived, whatever the caller does to its history later.
const scripted = <Out extends Part>(...turns: (Out | End)[][]) => {
  const seen: Request<AnyMessage>[] = [];
  const provider: Provider<AnyMessage, Out> = async function* (request) {
    seen.push({ ...request, messages: [...request.messages] });
    yield* turns[seen.length - 1]!;
  };
  return Object.assign(provider, { seen });
};

// A stream of several turns with tool results between them, as a loop that streams would produce.
const played = async function* (...chunks: (Part | End)[]) {
  yield* chunks;
};

// The loop from library.ts: the same call again with a longer history, until the model asks for nothing.
const loop = async (
  provider: Provider<AnyMessage, Part>,
  messages: AnyMessage[],
  tools: readonly Tool[],
) => {
  for (;;) {
    messages.push(...(await collect(provider({ messages, tools }))));
    const last = messages.at(-1);
    if (last?.from === "model" && last.end === "pause") continue;
    const calls = pendingToolCalls(messages);
    if (calls.length === 0) break;
    messages.push({
      from: "tool",
      content: await Promise.all(calls.map((c) => runToolCall(tools, c))),
    });
  }
};

const say = (t: string): TextPart => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown = {}): ToolCall => ({
  type: "tool_call",
  id,
  name,
  input,
});
const stop: End = { type: "end", reason: "stop" };
const cut: End = { type: "end", reason: "length" };
// A tool without its `run`. Held in a variable, a schema needs `as const` to type the input; written inside tool() it does not.
const forecast = {
  name: "get_weather",
  description: "Current weather for a city.",
  schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
} as const;
const weather = tool({ ...forecast, run: (input) => `18C in ${input.city}` });
// What the model is told when an input does not fit a schema; undefined when it fits.
const refused = async (schema: object, input: unknown) => {
  const made = tool({ name: "t", description: "", schema, run: () => "ok" });
  const { content, error } = await runToolCall([made], call("1", "t", input));
  return error
    ? content.map((part) => ("text" in part ? part.text : "")).join("")
    : undefined;
};
const toronto = call("1", "get_weather", { city: "Toronto" });
const answer: ToolResult = {
  type: "tool_result",
  id: "1",
  content: [say("18C in Toronto")],
};

test("model() turns a bare string into a request; text() reads the answer", async () => {
  const provider = scripted<TextPart>([say("hel"), say("lo"), stop]);
  assert.equal(await text(model(provider)("hi")), "hello");
  assert.deepEqual(provider.seen[0], {
    messages: [{ from: "user", content: [say("hi")] }],
  });
});

test("file() keeps bytes as base64 and a link as a string, so the part is plain JSON", () => {
  const inline = file("image/png", new Uint8Array([1, 2, 3]));
  const linked = file("application/pdf", new URL("https://example.com/a.pdf"));
  assert.deepEqual(inline, {
    type: "file",
    mediaType: "image/png",
    data: "AQID",
  });
  assert.deepEqual(linked, {
    type: "file",
    mediaType: "application/pdf",
    url: "https://example.com/a.pdf",
  });
  assert.deepEqual(file("text/plain", new Uint8Array()), {
    type: "file",
    mediaType: "text/plain",
    data: "",
  });
  assert.deepEqual(JSON.parse(JSON.stringify([inline, linked])), [
    inline,
    linked,
  ]);
});

test("append() is pure and builds turns: parts join, End finishes, results group", () => {
  const empty: Reply<TextPart | ToolCall> = [];
  const chunks = [
    say("Chec"),
    say("king."),
    toronto,
    stop,
    answer,
    say("It is 18C."),
    stop,
  ];
  const reply = chunks.reduce(append<TextPart | ToolCall>, empty);
  assert.deepEqual(reply, [
    { from: "model", content: [say("Checking."), toronto], end: "stop" },
    { from: "tool", content: [answer] },
    { from: "model", content: [say("It is 18C.")], end: "stop" },
  ]);
  assert.deepEqual(empty, []);
  // While a turn is still arriving it has no `end`.
  assert.deepEqual(append(empty, say("so far")), [
    { from: "model", content: [say("so far")] },
  ]);
  // A turn with no content is still a turn.
  assert.deepEqual(append(empty, cut), [
    { from: "model", content: [], end: "length" },
  ]);
});

test("reasoning arrives in pieces and joins as text does, and the two never join each other", () => {
  const thinks = (t: string): ReasoningPart => ({ type: "reasoning", text: t });
  const sealed: NativePart = { type: "native", provider: "x", value: 1 };
  const empty: Reply<TextPart | ReasoningPart | NativePart> = [];
  const reply = [
    thinks(""),
    thinks("Let me "),
    thinks("see."),
    sealed,
    say("Bl"),
    say("ue."),
    thinks("More."),
    say("Or red."),
    stop,
  ].reduce(append<TextPart | ReasoningPart | NativePart>, empty);
  assert.deepEqual(reply, [
    {
      from: "model",
      content: [
        thinks("Let me see."),
        sealed,
        say("Blue."),
        thinks("More."),
        say("Or red."),
      ],
      end: "stop",
    },
  ]);
  // One with nothing in it yet is a part all the same: the model has started working.
  assert.deepEqual(append(empty, thinks("")), [
    { from: "model", content: [thinks("")] },
  ]);
  assert.ok(
    isReasoning(thinks("x")) && !isReasoning(say("x")) && !isText(thinks("x")),
  );
});

test("text() is the answer alone: reasoning is no part of it", async () => {
  const thinks: ReasoningPart = {
    type: "reasoning",
    text: "The sky, perhaps. ",
  };
  assert.equal(await text(played(thinks, say("Blue."), stop)), "Blue.");
});

test("collect() keeps a provider's native parts typed and records why each turn ended", async () => {
  type Chart = NativePart<"charts", { points: number[] }>;
  const chart: Chart = {
    type: "native",
    provider: "charts",
    value: { points: [1, 2] },
  };
  const [turn] = await collect(
    scripted<TextPart | Chart>([say("a"), say("b"), chart, cut])({
      messages: [],
    }),
  );
  assert.deepEqual(turn, {
    from: "model",
    content: [say("ab"), chart],
    end: "length",
  });
  const points = turn!.content.flatMap((part) =>
    part.type === "native" ? part.value.points : [],
  );
  assert.deepEqual(points, [1, 2]);
});

test("a stream that stops mid-turn, or says nothing at all, is a provider bug", async () => {
  await assert.rejects(
    collect(scripted([say("oops")])({ messages: [] })),
    /without an end/,
  );
  await assert.rejects(
    collect(scripted([])({ messages: [] })),
    /without an end/,
  );
});

test("text() throws on a truncated answer", async () => {
  await assert.rejects(
    text(scripted([say("half"), cut])({ messages: [] })),
    /length/,
  );
});

test("pendingToolCalls() is the calls in a final, finished model turn, and nothing else", () => {
  const asked: ModelMessage<TextPart | ToolCall> = {
    from: "model",
    content: [say("hm"), toronto],
    end: "stop",
  };
  assert.deepEqual(pendingToolCalls([asked]), [toronto]);
  assert.deepEqual(pendingToolCalls([{ ...asked, end: "length" }]), []);
  assert.deepEqual(
    pendingToolCalls([{ from: "model", content: [toronto] }]),
    [],
  );
  assert.deepEqual(
    pendingToolCalls([asked, { from: "tool", content: [answer] }]),
    [],
  );
  assert.deepEqual(pendingToolCalls([]), []);
});

test("a hand-written loop decides what happens to each call", async () => {
  const provider = scripted<TextPart | ToolCall>(
    [
      call("1", "delete_files"),
      call("2", "get_weather", { city: "Toronto" }),
      stop,
    ],
    [say("Done."), stop],
  );
  const messages: Message<TextPart, TextPart | ToolCall>[] = [user("go")];
  for (;;) {
    messages.push(...(await collect(provider({ messages, tools: [weather] }))));
    const last = messages.at(-1);
    if (last?.from === "model" && last.end === "pause") continue;
    const calls = pendingToolCalls(messages);
    if (calls.length === 0) break;
    const results: ToolResult[] = [];
    for (const c of calls)
      results.push(
        c.name === "delete_files"
          ? toolResult(c, "Denied.", { error: true })
          : await runToolCall([weather], c),
      );
    messages.push({ from: "tool", content: results });
  }
  assert.deepEqual(
    messages.map((m) => m.from),
    ["user", "model", "tool", "model"],
  );
  assert.deepEqual(messages[2]!.content, [
    { type: "tool_result", id: "1", content: [say("Denied.")], error: true },
    { type: "tool_result", id: "2", content: [say("18C in Toronto")] },
  ]);
});

test("a loop is the same call again with a longer history", async () => {
  const provider = scripted<TextPart | ToolCall>(
    [say("Checking."), toronto, stop],
    [say("It is 18C."), stop],
    [say("Colder."), stop],
  );
  const messages: AnyMessage[] = [user("weather?")];
  await loop(provider, messages, [weather]);
  assert.deepEqual(messages.slice(1), [
    { from: "model", content: [say("Checking."), toronto], end: "stop" },
    { from: "tool", content: [answer] },
    { from: "model", content: [say("It is 18C.")], end: "stop" },
  ]);
  // Each request is the one before it with more messages, and nothing else differs.
  assert.deepEqual(provider.seen, [
    { messages: messages.slice(0, 1), tools: [weather] },
    { messages: messages.slice(0, 3), tools: [weather] },
  ]);
  // The history is the conversation: add to it and call again.
  messages.push(user("and tomorrow?"));
  assert.equal(await text(provider({ messages })), "Colder.");
  const sent = provider.seen[2]!.messages;
  assert.deepEqual(
    sent.map((m) => m.from),
    ["user", "model", "tool", "model", "user"],
  );
  for (const m of sent)
    assert.equal(
      m.content.some((part) => part.type === "tool_result"),
      m.from === "tool",
    );
});

test("text() of several turns is the final answer only, and tool results are not an answer", async () => {
  assert.equal(
    await text(
      played(say("Checking."), toronto, stop, answer, say("It is 18C."), stop),
    ),
    "It is 18C.",
  );
  await assert.rejects(text(played(toronto, stop, answer)), /no final answer/);
});

test("runToolCall() turns a missing or a throwing tool into an error result", async () => {
  const boom: Tool = {
    ...weather,
    name: "boom",
    run: () => {
      throw new Error("kaput");
    },
  };
  assert.deepEqual(await runToolCall([boom], call("1", "nope")), {
    type: "tool_result",
    id: "1",
    content: [say("unknown tool: nope")],
    error: true,
  });
  assert.deepEqual(await runToolCall([boom], call("2", "boom")), {
    type: "tool_result",
    id: "2",
    content: [say("kaput")],
    error: true,
  });
});

test("attemptToolCall() gives back what the tool returned, and throws what it threw, as it was thrown", async () => {
  const kaput = new TypeError("kaput");
  const boom: Tool = {
    ...weather,
    name: "boom",
    run: () => {
      throw kaput;
    },
  };
  assert.equal(
    await attemptToolCall([weather, boom], toronto),
    "18C in Toronto",
  );
  // The very error, not a copy or a description of it.
  assert.equal(
    await attemptToolCall([weather, boom], call("1", "boom")).catch(
      (error) => error,
    ),
    kaput,
  );
  await assert.rejects(
    attemptToolCall([weather], call("1", "nope")),
    /^Error: unknown tool: nope$/,
  );
  await assert.rejects(
    attemptToolCall([weather], call("1", "get_weather", { city: 42 })),
    /^Error: city must be a string$/,
  );
});

test("toolFailure() is what the model reads: the thrower's own words, with nothing put before them", () => {
  const said = (error: unknown) => toolFailure(toronto, error);
  const reads = (words: string): ToolResult => ({
    type: "tool_result",
    id: "1",
    content: [say(words)],
    error: true,
  });
  assert.deepEqual(said(new Error("no such city")), reads("no such city"));
  assert.deepEqual(
    said(new TypeError("x is undefined")),
    reads("x is undefined"),
  );
  assert.deepEqual(said("thrown as a string"), reads("thrown as a string"));
  // Anything with a message will do; it need not be an Error from here.
  assert.deepEqual(
    said({ message: "from elsewhere" }),
    reads("from elsewhere"),
  );
  // With no words of its own, an error goes by its name: a result is never empty.
  assert.deepEqual(said(new RangeError()), reads("RangeError"));
});

test("runToolCall() written out: a failure can be seen before the model reads it, and a mistake in a tool's code can stop the loop", async () => {
  const flaky: Tool = {
    ...weather,
    name: "flaky",
    run: () => {
      throw new Error("no such city");
    },
  };
  const broken: Tool = {
    ...weather,
    name: "broken",
    run: (input) =>
      (input as { city: { name: string } }).city.name.toUpperCase(),
  };
  const seen: unknown[] = [];
  const watched = async (c: ToolCall) => {
    try {
      return toolResult(
        c,
        await attemptToolCall([weather, flaky, broken], c),
      );
    } catch (error) {
      seen.push(error);
      if (error instanceof TypeError) throw error;
      return toolFailure(c, error);
    }
  };
  assert.deepEqual(await watched(toronto), answer);
  assert.deepEqual(await watched(call("2", "flaky")), {
    type: "tool_result",
    id: "2",
    content: [say("no such city")],
    error: true,
  });
  await assert.rejects(
    watched(call("3", "broken", { city: "Toronto" })),
    TypeError,
  );
  assert.equal(seen.length, 2);
  // runToolCall() itself lets nothing through: the same mistake is only something the model reads.
  assert.equal(
    (await runToolCall([broken], call("3", "broken", { city: "Toronto" })))
      .error,
    true,
  );
});

test("tool(): input is checked and typed before run; bad input goes back to the model as an error", async () => {
  let ran = 0;
  const checked = tool({
    ...forecast,
    run: (input) => {
      ran++;
      return input.city.toUpperCase();
    },
  });
  assert.deepEqual(await runToolCall([checked], toronto), {
    type: "tool_result",
    id: "1",
    content: [say("TORONTO")],
  });
  const bad = await runToolCall(
    [checked],
    call("2", "get_weather", { city: 42 }),
  );
  assert.deepEqual(bad, {
    type: "tool_result",
    id: "2",
    content: [say("city must be a string")],
    error: true,
  });
  assert.equal(ran, 1);
  // The schema the model is told is the one that was given, untouched.
  assert.equal(checked.schema, forecast.schema);
});

test("tool(): the model is told everything wrong with an input at once, and where", async () => {
  const schema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        maxLength: 5,
        description: "What to look for.",
      },
      limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      sort: { enum: ["recent", "relevant"] },
      exact: { const: true },
      sites: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 2,
      },
      region: { anyOf: [{ type: "string" }, { type: "null" }] },
      where: {
        type: "object",
        properties: { lat: { type: "number" } },
        required: ["lat"],
      },
    },
    required: ["query", "region"],
    additionalProperties: false,
  };
  const fine = {
    query: "cats",
    region: null,
    limit: 3,
    sort: "recent",
    exact: true,
    sites: ["a.com"],
    where: { lat: 43.7 },
  };
  assert.equal(await refused(schema, fine), undefined);
  assert.equal(
    await refused(schema, { query: "cats", region: "ca" }),
    undefined,
  );

  assert.equal(await refused(schema, "cats"), "input must be an object");
  assert.equal(
    await refused(schema, {}),
    "query is missing; region is missing",
  );
  const wrong = {
    query: "c",
    limit: 2.5,
    sort: "old",
    exact: false,
    sites: [],
    region: 7,
    where: { lat: "north" },
    colour: "red",
  };
  assert.equal(
    await refused(schema, wrong),
    [
      "query must be 2 or more characters long",
      "limit must be an integer",
      'sort must be "recent" or "relevant"',
      "exact must be true",
      "sites must have 1 or more items",
      "region must be a string, or region must be null",
      "where.lat must be a number",
      "colour is not expected",
    ].join("; "),
  );
  const over = {
    ...fine,
    query: "kittens",
    limit: 11,
    sites: ["a.com", 7, "c.com"],
    where: {},
  };
  assert.equal(
    await refused(schema, over),
    [
      "query must be 5 or fewer characters long",
      "limit must be 10 or less",
      "sites[1] must be a string",
      "sites must have 2 or fewer items",
      "where.lat is missing",
    ].join("; "),
  );
  assert.equal(
    await refused(schema, { ...fine, limit: 0 }),
    "limit must be 1 or more",
  );
});

test("tool(): a keyword constrains only the kind of value it is about, and length is counted in characters", async () => {
  assert.equal(
    await refused({ minLength: 2, required: ["a"], minItems: 1 }, 5),
    undefined,
  );
  assert.equal(
    await refused({ type: "array" }, { length: 0 }),
    "input must be an array",
  );
  assert.equal(
    await refused({ type: "number" }, NaN),
    "input must be a number",
  );
  assert.equal(
    await refused({ type: "array", items: { type: "integer" } }, [1, "2"]),
    "input[1] must be an integer",
  );
  // One emoji is one character, though it is two UTF-16 units.
  assert.equal(
    await refused({ type: "string", maxLength: 1 }, "😀"),
    undefined,
  );
  // With nothing said about other properties, they are let through.
  assert.equal(
    await refused({ type: "object", properties: {} }, { anything: 1 }),
    undefined,
  );
});

test("tool(): a schema that says something unenforced is refused when the tool is made", () => {
  const make = (schema: object) => () =>
    tool({ name: "t", description: "", schema, run: () => "ok" });
  assert.throws(
    make({ type: "string", pattern: "^a" }),
    /"pattern" is not one this enforces/,
  );
  assert.throws(
    make({
      type: "object",
      properties: { when: { type: "string", format: "date" } },
    }),
    /"format"/,
  );
  assert.throws(
    make({ type: "array", items: { anyOf: [{ not: {} }] } }),
    /"not"/,
  );
  assert.throws(
    make({ type: ["string", "null"] }),
    /"type" must be one of string, number/,
  );
  assert.throws(
    make({ type: "object", additionalProperties: { type: "string" } }),
    /"additionalProperties" must be true or false/,
  );
  assert.throws(make({ enum: [{ a: 1 }] }), /"enum" must be a list of strings/);
  assert.throws(
    make({ type: "string", maxLength: "5" }),
    /"maxLength" must be a number/,
  );
  assert.throws(
    make({ type: "array", items: true }),
    /a schema must be an object/,
  );
  // What is only for the reader asserts nothing, so it is let through.
  assert.doesNotThrow(
    make({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "T",
      description: "d",
      default: 1,
      examples: [1],
      $comment: "c",
    }),
  );
});

test("usage: each turn records what it cost, and totalUsage() adds a history up", async () => {
  const cost = (input: number, output: number, cacheRead?: number): End => ({
    type: "end",
    reason: "stop",
    usage: { input, output, ...(cacheRead && { cacheRead }) },
  });
  const reply = await collect(
    played(toronto, cost(100, 10, 80), answer, say("It is 18C."), cost(130, 6)),
  );
  assert.deepEqual(reply[0], {
    from: "model",
    content: [toronto],
    end: "stop",
    usage: { input: 100, output: 10, cacheRead: 80 },
  });
  assert.deepEqual(reply[2], {
    from: "model",
    content: [say("It is 18C.")],
    end: "stop",
    usage: { input: 130, output: 6 },
  });
  assert.deepEqual(totalUsage(reply), {
    input: 230,
    output: 16,
    cacheRead: 80,
    cacheWrite: 0,
  });
  // Turns that report nothing, and messages that are not turns, count as nothing.
  assert.deepEqual(
    totalUsage([user("hi"), { from: "model", content: [], end: "stop" }]),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test("a paused turn is not an answer: text() throws, and no tools run", async () => {
  const paused: End = { type: "end", reason: "pause" };
  await assert.rejects(
    text(scripted([say("so far"), paused])({ messages: [] })),
    /pause/,
  );
  await assert.rejects(
    text(
      scripted([say("?"), { type: "end", reason: "unknown" }])({
        messages: [],
      }),
    ),
    /unknown/,
  );
  assert.deepEqual(
    pendingToolCalls([{ from: "model", content: [toronto], end: "pause" }]),
    [],
  );
});

test("a paused turn goes back as it is, so the model can finish it", async () => {
  const paused: End = { type: "end", reason: "pause" };
  const provider = scripted<TextPart | ToolCall>(
    [say("Searching. "), paused],
    [say("Found it."), stop],
  );
  const messages: AnyMessage[] = [user("find it")];
  await loop(provider, messages, [weather]);
  // No tool message was invented: the paused turn itself is what went back.
  assert.deepEqual(provider.seen[1]!.messages, [
    user("find it"),
    { from: "model", content: [say("Searching. ")], end: "pause" },
  ]);
  assert.deepEqual(
    messages.map((m) => [m.from, m.from === "model" && m.end]),
    [
      ["user", false],
      ["model", "pause"],
      ["model", "stop"],
    ],
  );
  // The paused turn and its continuation read as one answer.
  assert.equal(
    await text(played(say("Searching. "), paused, say("Found it."), stop)),
    "Searching. Found it.",
  );
});

test("abort: the signal reaches a running tool, and a cancelled call throws instead of answering", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const slow = tool({
    ...forecast,
    run: (_input, { signal }) => {
      seen = signal;
      return new Promise<string>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  });
  const running = runToolCall([slow], toronto, controller.signal);
  controller.abort(new Error("stopped by the user"));
  // No error result is made up for the model to read.
  await assert.rejects(running, /stopped by the user/);
  assert.equal(seen, controller.signal);
});

test("a step written against text alone accepts any richer provider", async () => {
  const summarise =
    (provider: Provider<UserMessage<TextPart>, Part>) => (doc: string) =>
      text(provider({ messages: [user(`Summarise: ${doc}`)] }));
  const rich: Provider<
    Message<TextPart, TextPart | ToolCall>,
    TextPart | ToolCall
  > = scripted([say("short"), stop]);
  assert.equal(await summarise(rich)("long text"), "short");
});

// A provider that only takes ids of exactly nine letters and digits.
const nine = (id: string) => /^[a-zA-Z0-9]{9}$/.test(id);
const freshNine = (n: number) => `fitted${String(n).padStart(3, "0")}`;
const asked = (...ids: string[]): PortableMessage => ({
  from: "model",
  content: ids.map((id) => call(id, "t")),
  end: "stop",
});
const told = (...ids: string[]): PortableMessage => ({
  from: "tool",
  content: ids.map((id) => ({ type: "tool_result", id, content: [say("ok")] })),
});
const ids = (messages: readonly PortableMessage[]) =>
  messages.map((m) =>
    m.content.flatMap((part) =>
      part.type === "tool_call" || part.type === "tool_result" ? [part.id] : [],
    ),
  );

test("fitToolIds() renames an unacceptable id the same way in the call and its result", () => {
  const history = [
    user("go"),
    asked("toolu_01ABCDEFGH", "abcdefghi"),
    told("toolu_01ABCDEFGH", "abcdefghi"),
    user("more"),
  ];
  const before = structuredClone(history);
  const fitted = fitToolIds(history, nine, freshNine);
  assert.deepEqual(ids(fitted), [
    [],
    ["fitted000", "abcdefghi"],
    ["fitted000", "abcdefghi"],
    [],
  ]);
  // Everything that did not need changing is the same object, and the history is untouched.
  assert.equal(fitted[0], history[0]);
  assert.equal(fitted[3], history[3]);
  assert.equal(fitted[1]!.content[1], history[1]!.content[1]);
  assert.deepEqual(history, before);
});

test("fitToolIds() returns the very same history when every id already fits", () => {
  const history = [user("go"), asked("abcdefghi"), told("abcdefghi")];
  assert.equal(fitToolIds(history, nine, freshNine), history);
});

test("fitToolIds() never hands out an id that is already in use", () => {
  // "fitted000" is a real id here, so the first replacement must skip it.
  const early = [asked("fitted000", "bad id 1"), told("fitted000", "bad id 1")];
  assert.deepEqual(ids(fitToolIds(early, nine, freshNine))[0], [
    "fitted000",
    "fitted001",
  ]);
  // Here the replacement comes first; the real "fitted000" arrives later and is the one that moves.
  const late = [
    asked("bad id 1"),
    told("bad id 1"),
    asked("fitted000"),
    told("fitted000"),
  ];
  assert.deepEqual(ids(fitToolIds(late, nine, freshNine)), [
    ["fitted000"],
    ["fitted000"],
    ["fitted001"],
    ["fitted001"],
  ]);
});

test("fitToolIds() gives a history the same ids however much is added after it", () => {
  const start = [
    asked("bad id 1", "abcdefghi"),
    told("bad id 1", "abcdefghi"),
    asked("bad id 2"),
    told("bad id 2"),
  ];
  const longer = [
    ...start,
    asked("fitted001", "bad id 3"),
    told("fitted001", "bad id 3"),
  ];
  assert.deepEqual(
    fitToolIds(longer, nine, freshNine).slice(0, start.length),
    fitToolIds(start, nine, freshNine),
  );
});

test("fitToolIds() fails instead of hanging when fresh() cannot produce a usable id", () => {
  const history = [asked("bad id 1", "bad id 2")];
  assert.throws(
    () => fitToolIds(history, nine, () => "still bad"),
    /distinct ids that fit/,
  );
  assert.throws(
    () => fitToolIds(history, nine, () => "sameagain"),
    /distinct ids that fit/,
  );
});

const unrun = (c: ToolCall) =>
  toolResult(c, "Not run.", { error: true });
const refusal = (id: string): ToolResult => ({
  type: "tool_result",
  id,
  content: [say("Not run.")],
  error: true,
});

test("answerToolCalls() gives a call with no result one, directly after its turn", () => {
  const history = [
    user("go"),
    asked("a", "b"),
    user("never mind"),
    asked("c"),
    told("c"),
  ];
  const before = structuredClone(history);
  const put = answerToolCalls(history, unrun);
  assert.deepEqual(put, [
    history[0],
    history[1],
    { from: "tool", content: [refusal("a"), refusal("b")] },
    history[2],
    history[3],
    history[4],
  ]);
  // Everything that was there is the same object, and the history is untouched.
  for (const m of history) assert.ok(put.includes(m));
  assert.deepEqual(history, before);
});

test("answerToolCalls() adds what is missing to the results already there, and answers a final turn too", () => {
  const cutOff: PortableMessage = {
    from: "model",
    content: [say("Checking."), call("d", "t"), call("e", "t")],
    end: "length",
  };
  const put = answerToolCalls([asked("a", "b", "c"), told("b"), cutOff], unrun);
  assert.deepEqual(put[1], {
    from: "tool",
    content: [told("b").content[0], refusal("a"), refusal("c")],
  });
  assert.deepEqual(put[3], {
    from: "tool",
    content: [refusal("d"), refusal("e")],
  });
  assert.equal(put.length, 4);
});

test("answerToolCalls() returns the very same history when every call is answered, so doing it twice changes nothing", () => {
  const whole = [
    user("go"),
    asked("a"),
    told("a"),
    { from: "model", content: [say("Done.")], end: "stop" } as PortableMessage,
  ];
  assert.equal(answerToolCalls(whole, unrun), whole);
  assert.equal(answerToolCalls([], unrun).length, 0);
  const put = answerToolCalls(
    [user("go"), asked("a", "b"), told("a"), asked("c")],
    unrun,
  );
  assert.equal(answerToolCalls(put, unrun), put);
  // Results that answer no call of the turn before them are left as they are.
  const stray = [user("go"), told("x")];
  assert.equal(answerToolCalls(stray, unrun), stray);
});

// The shape of an answer: a field that may be missing is required and either itself or null.
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
const threw = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

test("shape(): a request asks for it as plain data, and parse() reads the answer as text", async () => {
  const written = '{"category":"bug","urgent":true,"orderId":null}';
  const provider = scripted<TextPart>([
    say(written.slice(0, 9)),
    say(written.slice(9)),
    stop,
  ]);
  const ticket = triage.parse(
    await text(provider({ messages: [user("It crashes.")], shape: triage })),
  );
  assert.deepEqual(ticket, { category: "bug", urgent: true, orderId: null });
  // A provider that knows nothing of shapes was simply handed one more field.
  assert.equal(provider.seen[0]!.shape, triage);
  // The schema is the one that was given, untouched, and a request needs nothing but it.
  const schema = { type: "string" };
  assert.equal(shape(schema).schema, schema);
  assert.equal(
    await text(
      scripted([say('"hi"'), stop])({ messages: [], shape: { schema } }),
    ),
    '"hi"',
  );
  // The answer is ordinary text in the history, so a stored one reads the same way.
  const [turn] = JSON.parse(
    JSON.stringify(
      await collect(scripted([say(written), stop])({ messages: [] })),
    ),
  );
  assert.deepEqual(triage.parse(turn.content[0].text), ticket);
});

test("shape(): parse() throws unless the answer is JSON that fits, naming everything wrong", () => {
  assert.equal(
    threw(() => triage.parse("Sure! Here is the ticket.")),
    "the answer is not JSON",
  );
  assert.equal(
    threw(() => triage.parse('{"category":"bug","urg')),
    "the answer is not JSON",
  );
  assert.equal(
    threw(() => triage.parse('"bug"')),
    "answer must be an object",
  );
  assert.equal(
    threw(() =>
      triage.parse('{"category":"Bug","urgent":"yes","note":"x","orderId":7}'),
    ),
    [
      'answer.category must be "billing" or "bug" or "other"',
      "answer.urgent must be a boolean",
      "answer.orderId must be a string, or answer.orderId must be null",
      "answer.note is not expected",
    ].join("; "),
  );
  assert.equal(
    threw(() => triage.parse('{"category":"bug","urgent":true}')),
    "answer.orderId is missing",
  );
  const counts = shape({ type: "array", items: { type: "integer" } });
  assert.equal(
    threw(() => counts.parse("[1,2.5]")),
    "answer[1] must be an integer",
  );
});

test("shape(): parse() is exact about null: where the schema does not accept one, it is wrong", () => {
  const loose = shape({
    type: "object",
    properties: { note: { type: "string" } },
  });
  assert.deepEqual(loose.parse("{}"), {});
  assert.deepEqual(loose.parse('{"note":"x"}'), { note: "x" });
  // Left out is not the same as null: an optional property is either absent or what its schema says.
  assert.equal(
    threw(() => loose.parse('{"note":null}')),
    "answer.note must be a string",
  );
});

test("shape(): a schema that says something unenforced is refused when the shape is made", () => {
  assert.throws(
    () => shape({ type: "string", pattern: "^a" }),
    /"pattern" is not one this enforces/,
  );
  assert.throws(
    () => shape({ type: "object", properties: { when: { format: "date" } } }),
    /"format"/,
  );
});

// Every schema a walk visited, in order, as the place it sits and the keywords it holds.
const visits = (schema: object) => {
  const seen: string[] = [];
  fitSchema(schema, (node, at) => {
    seen.push(`${at || "(whole)"}: ${Object.keys(node).join(",")}`);
    return node;
  });
  return seen;
};

test("fitSchema() takes every schema inside a schema through fit, innermost first, and says where each sits", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      where: {
        anyOf: [
          { type: "null" },
          { type: "object", properties: { lat: { type: "number" } } },
        ],
      },
      rows: { type: "array", items: { type: "array", items: { enum: [1] } } },
    },
    required: ["name"],
  };
  assert.deepEqual(visits(schema), [
    "name: type",
    "tags[]: type",
    "tags: type,items",
    "where: type",
    "where.lat: type",
    "where: type,properties",
    "where: anyOf",
    "rows[][]: enum",
    "rows[]: type,items",
    "rows: type,items",
    "(whole): type,properties,required",
  ]);
});

test("fitSchema() copies only what changed, and returns the very same schema when nothing did", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 5 },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name"],
  };
  const before = structuredClone(schema);
  assert.equal(
    fitSchema(schema, (node) => node),
    schema,
  );
  // Fit sees its children already fitted, and what it gives back takes the schema's place.
  const fitted = fitSchema(schema, (node) => {
    if (!("maxLength" in node)) return node;
    const { maxLength, ...kept } = node;
    return { ...kept, description: `At most ${maxLength}.` };
  });
  assert.deepEqual(fitted, {
    type: "object",
    properties: {
      name: { type: "string", description: "At most 5." },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name"],
  });
  // The untouched branch is the same object, keywords keep their order, and the schema given is as it was.
  assert.equal(fitted.properties.tags, schema.properties.tags);
  assert.deepEqual(Object.keys(fitted), ["type", "properties", "required"]);
  assert.deepEqual(schema, before);
});

test("fitSchema() refuses by letting fit throw, and leaves alone what is not a schema", () => {
  const map = { type: "object", properties: { extra: { type: "object" } } };
  assert.throws(
    () =>
      fitSchema(map, (node, at) => {
        if (node.type === "object" && !("properties" in node))
          throw new Error(`cannot ask for a free-form object (${at})`);
        return node;
      }),
    /free-form object \(extra\)/,
  );
  // As a schema written by hand might be: fit is only ever handed an object.
  const odd = { items: true, properties: [1], anyOf: ["x", { type: "null" }] };
  assert.deepEqual(visits(odd), [
    "(whole): type",
    "(whole): items,properties,anyOf",
  ]);
  const list: object = [1, 2];
  assert.equal(
    fitSchema(list, () => ({})),
    list,
  );
});

// What a schema gives `run`, as the compiler sees it. `npm run typecheck` fails if one of these types is off.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export const typed = () => {
  tool({
    name: "search",
    description: "",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer" },
        ratio: { type: "number" },
        exact: { type: "boolean" },
        sort: { type: "string", enum: ["recent", "relevant"] },
        kind: { const: "web" },
        sites: { type: "array", items: { type: "string" } },
        tags: { type: "array" },
        region: { anyOf: [{ type: "string" }, { type: "null" }] },
        where: {
          type: "object",
          properties: { lat: { type: "number" } },
          required: ["lat"],
        },
        extra: { type: "object" },
        anything: {},
      },
      required: ["query", "region"],
    },
    run: (input) => {
      type Expected = {
        query: string;
        region: string | null;
        limit?: number;
        ratio?: number;
        exact?: boolean;
        sort?: "recent" | "relevant";
        kind?: "web";
        sites?: string[];
        tags?: unknown[];
        where?: { lat: number };
        extra?: { [key: string]: unknown };
        anything?: unknown;
      };
      const same: Same<typeof input, Expected> = true;
      // @ts-expect-error a string is not a number
      const wrong: number = input.query;
      return String(same) + String(wrong);
    },
  });
  // A shape types what parse() returns, the way a tool's schema types its input.
  const ticket = triage.parse("");
  type Ticket = {
    category: "billing" | "bug" | "other";
    urgent: boolean;
    orderId: string | null;
  };
  const sameTicket: Same<typeof ticket, Ticket> = true;
  // @ts-expect-error a boolean is not a string
  const wrongTicket: string = ticket.urgent;
  String(sameTicket) + wrongTicket;
  // A schema whose literal types were lost types nothing: the input is unknown, never a wrong guess.
  const widened = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  };
  tool({
    name: "t",
    description: "",
    schema: widened,
    run: (input) => {
      const same: Same<typeof input, unknown> = true;
      return String(same);
    },
  });
};

// Histories that must not compile. `npm run typecheck` fails if one starts to.
export const illegal = async (
  rich: Provider<Message<TextPart, TextPart | ToolCall>, TextPart | ToolCall>,
  textOnly: Provider<UserMessage<TextPart> | ModelMessage<TextPart>, TextPart>,
) => {
  // @ts-expect-error a user message cannot carry a tool call
  rich({ messages: [{ from: "user", content: [toronto] }] });
  // @ts-expect-error a tool message carries results, not text
  rich({ messages: [{ from: "tool", content: [say("not a result")] }] });
  // @ts-expect-error a model turn cannot contain a tool result
  rich({ messages: [{ from: "model", content: [toronto, answer] }] });
  // @ts-expect-error a reply is a list of messages, not the content of one
  rich({
    messages: [
      { from: "model", content: await collect(rich({ messages: [] })) },
    ],
  });
  // @ts-expect-error a provider that cannot take tool messages cannot be sent tool results
  textOnly({ messages: [{ from: "tool", content: [answer] }] });
};
