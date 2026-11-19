import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerToolCalls,
  append,
  collect,
  toolFailure,
  file,
  fitSchema,
  fitToolIds,
  isReasoning,
  isSchemaError,
  isSource,
  isText,
  isToolCall,
  isToolInput,
  parse,
  partial,
  pendingToolCalls,
  toolResult,
  text,
  totalUsage,
  user,
  type AnyMessage,
  type End,
  type FilePart,
  type Message,
  type ModelMessage,
  type NativePart,
  type Part,
  type PortableMessage,
  type Provider,
  type ReasoningPart,
  type Reply,
  type Request,
  type SourcePart,
  type TextPart,
  type ToolCall,
  type ToolInputPart,
  type ToolResult,
  type ToolSpec,
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
  tools: readonly ToolSpec[],
) => {
  for (;;) {
    messages.push(...(await collect(provider({ messages, tools }))));
    const last = messages.at(-1);
    if (last?.from === "model" && last.end === "pause") continue;
    const calls = pendingToolCalls(messages);
    if (calls.length === 0) break;
    messages.push({
      from: "tool",
      content: await Promise.all(calls.map(respond)),
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
// What the model is told of a tool. Held in a variable, a schema needs `as const` to type the input.
const weather = {
  name: "get_weather",
  description: "Current weather for a city.",
  schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
} as const;
// What a caller writes for itself: what a call does, and the result it comes to.
const run = (c: ToolCall): string => {
  if (c.name !== weather.name) throw new Error(`unknown tool: ${c.name}`);
  return `18C in ${parse(weather.schema, c.input).city}`;
};
const respond = async (c: ToolCall): Promise<ToolResult> => {
  try {
    return toolResult(c, run(c));
  } catch (error) {
    return toolFailure(c, error);
  }
};
// What the model is told when an input does not fit a schema; undefined when it fits.
const refused = (schema: object, input: unknown) => {
  try {
    parse(schema, input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const toronto = call("1", "get_weather", { city: "Toronto" });
const answer: ToolResult = {
  type: "tool_result",
  id: "1",
  content: [say("18C in Toronto")],
};

test("user() makes a text message from a bare string; text() reads the answer", async () => {
  const provider = scripted<TextPart>([say("hel"), say("lo"), stop]);
  assert.equal(await text(provider({ messages: [user("hi")] })), "hello");
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

test("a model may make a file: it arrives whole, stays where it was said, and is part of a portable history", async () => {
  const drawn = file("image/png", new Uint8Array([1, 2, 3]));
  const reply = await collect(
    played(say("Here "), say("it is."), drawn, say("Like it?"), stop),
  );
  // Text joins on either side of it, never across it.
  assert.deepEqual(reply, [
    {
      from: "model",
      content: [say("Here it is."), drawn, say("Like it?")],
      end: "stop",
    },
  ]);
  // It is no part of the answer's text, and asks for nothing.
  assert.equal(
    await text(played(say("Here it is."), drawn, say("Like it?"), stop)),
    "Here it is.Like it?",
  );
  assert.deepEqual(pendingToolCalls(reply), []);
  // Any provider can be handed the history, and it is plain JSON.
  const history: PortableMessage[] = [user("draw a cat"), ...reply];
  assert.deepEqual(JSON.parse(JSON.stringify(history)), history);
});

// The recipe from the README: fetching is the caller's, and the library only makes the part.
const fetched = async (
  part: FilePart & { url: string },
  get: typeof fetch,
): Promise<FilePart> => {
  const response = await get(part.url);
  if (!response.ok)
    throw new Error(`could not fetch ${part.url}: ${response.status}`);
  const { url, ...rest } = part;
  return {
    ...rest,
    ...file(part.mediaType, new Uint8Array(await response.arrayBuffer())),
  };
};
const inlined = async (
  message: UserMessage<TextPart | FilePart>,
  get: typeof fetch = fetch,
): Promise<UserMessage<TextPart | FilePart>> => ({
  ...message,
  content: await Promise.all(
    message.content.map((part) =>
      part.type === "file" && "url" in part ? fetched(part, get) : part,
    ),
  ),
});

test("a file given by link can be fetched by the caller and given as its bytes, with nothing from the library but file()", async () => {
  const asked: string[] = [];
  const get: typeof fetch = async (input) => {
    asked.push(String(input));
    return String(input).endsWith("/missing.pdf")
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array([1, 2, 3]));
  };
  const linked = {
    ...file("application/pdf", new URL("http://localhost:8080/report.pdf")),
    acme: { title: "Q3 report" },
  };
  const already = file("image/png", new Uint8Array([9]));
  const message = await inlined(user(linked, already, "Summarise."), get);
  // The link is gone and the bytes are there; the rest of the part, a hint included, is as it was.
  assert.deepEqual(message, {
    from: "user",
    content: [
      {
        type: "file",
        mediaType: "application/pdf",
        data: "AQID",
        acme: { title: "Q3 report" },
      },
      already,
      say("Summarise."),
    ],
  });
  // Only the linked file was fetched, and the message is still plain JSON.
  assert.deepEqual(asked, ["http://localhost:8080/report.pdf"]);
  assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
  // A link that cannot be fetched is an error where it is fetched, before anything is sent.
  const missing = file("application/pdf", new URL("http://localhost/missing.pdf"));
  await assert.rejects(inlined(user(missing), get), /could not fetch .*: 404/);
});

test("a source follows the text it supports, and its span keeps it to its own passage when text has joined", async () => {
  const freight: SourcePart = {
    type: "source",
    span: 18,
    quote: "Freight expense rose 31%.",
    title: "Q3 report",
  };
  const rates: SourcePart = {
    type: "source",
    span: 18,
    quote: "Container rates doubled.",
    url: "https://example.com/rates",
  };
  const chunks = [
    say("Margins fell, "),
    say("mainly on "),
    say("freight."),
    freight,
    rates,
    say(" Pricing "),
    say("was flat."),
    stop,
  ];
  const reply = await collect(played(...chunks));
  // Text joins up to a source and after it, never across it. Sources in a row stay as they came.
  assert.deepEqual(reply, [
    {
      from: "model",
      content: [
        say("Margins fell, mainly on freight."),
        freight,
        rates,
        say(" Pricing was flat."),
      ],
      end: "stop",
    },
  ]);
  // The passage a source speaks for is the end of the text before it.
  const [turn] = reply;
  assert.ok(turn?.from === "model");
  const passages = turn.content.flatMap((part, i) => {
    const before = turn.content[i - 1];
    return isSource(part) && before && isText(before)
      ? [before.text.slice(-(part.span ?? before.text.length))]
      : [];
  });
  assert.deepEqual(passages, ["mainly on freight."]);
  // A source is no part of the answer's text, and asks for nothing.
  assert.equal(
    await text(played(...chunks)),
    "Margins fell, mainly on freight. Pricing was flat.",
  );
  assert.deepEqual(pendingToolCalls(reply), []);
  assert.ok(isSource(freight) && !isSource(say("x")) && !isText(freight));
  // Any provider can be handed the history, and it is plain JSON.
  const history: PortableMessage[] = [user("margins?"), ...reply];
  assert.deepEqual(JSON.parse(JSON.stringify(history)), history);
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

test("append() keeps all an End carries on the turn: the reason as `end`, and the rest as it is", () => {
  // What a provider says of its response: the shared id and model, and its own account under its name.
  // A provider types its End as the shared one and more.
  type AcmeEnd = End & { acme: { request: string; stopped_on: string } };
  const told: AcmeEnd = {
    type: "end",
    reason: "stop",
    usage: { input: 3, output: 5 },
    id: "resp_1",
    model: "model-2026-01-01",
    acme: { request: "req_9", stopped_on: "END" },
  };
  const empty: Reply<TextPart> = [];
  const said = {
    usage: { input: 3, output: 5 },
    id: "resp_1",
    model: "model-2026-01-01",
    acme: { request: "req_9", stopped_on: "END" },
  };
  const reply = [say("Blue."), told].reduce(append<TextPart>, empty);
  assert.deepEqual(reply, [
    { from: "model", content: [say("Blue.")], end: "stop", ...said },
  ]);
  // The shared two are there to read by name.
  const [turn] = reply;
  assert.ok(turn?.from === "model");
  assert.deepEqual([turn.id, turn.model], ["resp_1", "model-2026-01-01"]);
  // A turn with nothing in it keeps them just the same.
  assert.deepEqual(append(empty, told), [
    { from: "model", content: [], end: "stop", ...said },
  ]);
  // An End that says nothing more adds nothing more.
  assert.deepEqual(append(empty, stop), [
    { from: "model", content: [], end: "stop" },
  ]);
  // It is all plain data, so a stored history holds it too.
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
});

test("what an End carries is for reading: collect() keeps it, and text() and totalUsage() go on as before", async () => {
  const told: End = {
    type: "end",
    reason: "stop",
    usage: { input: 3, output: 5 },
    id: "resp_1",
    model: "model-2026-01-01",
  };
  const reply = await collect(played(say("Blue."), told));
  assert.deepEqual(reply, [
    {
      from: "model",
      content: [say("Blue.")],
      end: "stop",
      usage: { input: 3, output: 5 },
      id: "resp_1",
      model: "model-2026-01-01",
    },
  ]);
  assert.equal(await text(played(say("Blue."), told)), "Blue.");
  assert.deepEqual(totalUsage(reply), {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  });
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

const writes = (id: string, name: string, t: string): ToolInputPart => ({
  type: "tool_input",
  id,
  name,
  text: t,
});

test("tool input arrives in pieces and joins by call, and the whole call takes its place", () => {
  const empty: Reply<TextPart | ToolInputPart | ToolCall> = [];
  const add = append<TextPart | ToolInputPart | ToolCall>;
  const pieces = [
    say("Checking."),
    writes("1", "get_weather", ""),
    writes("1", "get_weather", '{"city":'),
    writes("1", "get_weather", '"Toronto"}'),
  ];
  // While the call is being written there is one part, growing.
  const writing = pieces.reduce(add, empty);
  assert.deepEqual(writing, [
    {
      from: "model",
      content: [
        say("Checking."),
        writes("1", "get_weather", '{"city":"Toronto"}'),
      ],
    },
  ]);
  // One with nothing in it yet is a part all the same: the model has started writing the call.
  assert.deepEqual(add(empty, writes("1", "get_weather", "")), [
    { from: "model", content: [writes("1", "get_weather", "")] },
  ]);
  // Told of or not, a call's input leaves the same reply.
  assert.deepEqual(
    [toronto, stop].reduce(add, writing),
    [say("Checking."), toronto, stop].reduce(add, empty),
  );
  assert.deepEqual(empty, []);
  assert.ok(
    isToolInput(writes("1", "x", "")) &&
      !isToolInput(toronto) &&
      !isToolCall(writes("1", "x", "")),
  );
});

test("tool input joins only its own call's, and gives way only to its own call, directly after", () => {
  const empty: Reply<TextPart | ToolInputPart | ToolCall> = [];
  const add = append<TextPart | ToolInputPart | ToolCall>;
  const content = (...chunks: (TextPart | ToolInputPart | ToolCall)[]) =>
    chunks.reduce(add, empty)[0]?.content;
  // Two calls, one after the other: each call's input stays its own.
  assert.deepEqual(content(writes("1", "a", "{"), writes("2", "b", "{")), [
    writes("1", "a", "{"),
    writes("2", "b", "{"),
  ]);
  // Another call takes no one's place.
  assert.deepEqual(content(writes("2", "b", "{}"), toronto), [
    writes("2", "b", "{}"),
    toronto,
  ]);
  // Nor does a call with something between it and its input.
  assert.deepEqual(content(writes("1", "a", "{}"), say("So."), toronto), [
    writes("1", "a", "{}"),
    say("So."),
    toronto,
  ]);
  // Text never joins tool input, nor tool input text.
  assert.deepEqual(content(say("{"), writes("1", "a", "}"), say("!")), [
    say("{"),
    writes("1", "a", "}"),
    say("!"),
  ]);
});

test("tool input whose call never arrived is kept for showing: it is no answer and asks for nothing", async () => {
  const half = writes("1", "get_weather", '{"city":"Tor');
  const reply = await collect(played(say("Checking."), half, stop));
  assert.deepEqual(reply, [
    { from: "model", content: [say("Checking."), half], end: "stop" },
  ]);
  assert.deepEqual(pendingToolCalls(reply), []);
  assert.equal(await text(played(say("Checking."), half, stop)), "Checking.");
  // It is part of a history any provider can be handed.
  const kept: PortableMessage = { from: "model", content: [half] };
  assert.deepEqual(JSON.parse(JSON.stringify(kept)), kept);
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
          : await respond(c),
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

test("a call's result is the caller's to make: a failure can be seen before the model reads it, and a mistake in the code can stop the loop", async () => {
  const does: Record<string, (c: ToolCall) => string> = {
    get_weather: run,
    flaky: () => {
      throw new Error("no such city");
    },
    broken: (c) =>
      (c.input as { city: { name: string } }).city.name.toUpperCase(),
  };
  const seen: unknown[] = [];
  const watched = async (c: ToolCall) => {
    try {
      return toolResult(c, does[c.name]!(c));
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
});

test("parse() reads a call's input: what fits comes back as it was, and what does not is named", async () => {
  assert.equal(parse(weather.schema, toronto.input), toronto.input);
  const wrong = call("2", "get_weather", { city: 42 });
  assert.throws(
    () => parse(weather.schema, wrong.input),
    /^Error: city must be a string$/,
  );
  // Thrown where a result is made, that is what the model reads, and it can correct the call.
  assert.deepEqual(await respond(wrong), {
    type: "tool_result",
    id: "2",
    content: [say("city must be a string")],
    error: true,
  });
});

test("parse(): the model is told everything wrong with a value at once, and where", () => {
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
  assert.equal(refused(schema, fine), undefined);
  assert.equal(
    refused(schema, { query: "cats", region: "ca" }),
    undefined,
  );

  assert.equal(refused(schema, "cats"), "value must be an object");
  assert.equal(
    refused(schema, {}),
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
    refused(schema, wrong),
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
    refused(schema, over),
    [
      "query must be 5 or fewer characters long",
      "limit must be 10 or less",
      "sites[1] must be a string",
      "sites must have 2 or fewer items",
      "where.lat is missing",
    ].join("; "),
  );
  assert.equal(
    refused(schema, { ...fine, limit: 0 }),
    "limit must be 1 or more",
  );
});

test("parse(): a keyword constrains only the kind of value it is about, and length is counted in characters", () => {
  assert.equal(
    refused({ minLength: 2, required: ["a"], minItems: 1 }, 5),
    undefined,
  );
  assert.equal(
    refused({ type: "array" }, { length: 0 }),
    "value must be an array",
  );
  assert.equal(
    refused({ type: "number" }, NaN),
    "value must be a number",
  );
  assert.equal(
    refused({ type: "array", items: { type: "integer" } }, [1, "2"]),
    "value[1] must be an integer",
  );
  // One emoji is one character, though it is two UTF-16 units.
  assert.equal(
    refused({ type: "string", maxLength: 1 }, "😀"),
    undefined,
  );
  // With nothing said about other properties, they are let through.
  assert.equal(
    refused({ type: "object", properties: {} }, { anything: 1 }),
    undefined,
  );
});

test("parse(): a schema that says something unenforced is refused, whatever the value", () => {
  const make = (schema: object) => () => parse(schema, toronto.input);
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
    reasoning: 0,
  });
  // Turns that report nothing, and messages that are not turns, count as nothing.
  assert.deepEqual(
    totalUsage([user("hi"), { from: "model", content: [], end: "stop" }]),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  );
});

test("usage: reasoning is the part of the output spent reasoning, counted where a turn reports it", async () => {
  const thought = (output: number, reasoning?: number): End => ({
    type: "end",
    reason: "stop",
    usage: { input: 10, output, ...(reasoning !== undefined && { reasoning }) },
  });
  // Three turns: one that reasoned, one that says it did not, one that does not say.
  const reply = await collect(
    played(say("a"), thought(50, 40), say("b"), thought(7, 0), say("c"), thought(9)),
  );
  assert.deepEqual(
    reply.map((turn) => turn.from === "model" && turn.usage),
    [
      { input: 10, output: 50, reasoning: 40 },
      { input: 10, output: 7, reasoning: 0 },
      { input: 10, output: 9 },
    ],
  );
  // It is within the output, never beside it: the total written is `output` alone.
  assert.deepEqual(totalUsage(reply), {
    input: 30,
    output: 66,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 40,
  });
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
const triage = {
  schema: {
    type: "object",
    properties: {
      category: { enum: ["billing", "bug", "other"] },
      urgent: { type: "boolean" },
      orderId: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["category", "urgent", "orderId"],
    additionalProperties: false,
  },
} as const;
// An answer arrives as text: JSON.parse reads it, and parse() checks what was read.
const ticketOf = (answer: string) => parse(triage.schema, JSON.parse(answer));
const threw = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

test("a shape is plain data on the request, and the answer is text for JSON.parse and parse() to read", async () => {
  const written = '{"category":"bug","urgent":true,"orderId":null}';
  const provider = scripted<TextPart>([
    say(written.slice(0, 9)),
    say(written.slice(9)),
    stop,
  ]);
  const ticket = ticketOf(
    await text(provider({ messages: [user("It crashes.")], shape: triage })),
  );
  assert.deepEqual(ticket, { category: "bug", urgent: true, orderId: null });
  // A provider that knows nothing of shapes was simply handed one more field.
  assert.equal(provider.seen[0]!.shape, triage);
  // A request needs nothing but the schema.
  const schema = { type: "string" };
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
  assert.deepEqual(ticketOf(turn.content[0].text), ticket);
});

test("parse() throws unless an answer fits, naming everything wrong; text that is not JSON never gets that far", () => {
  // That is JSON.parse's to say, in its own words.
  assert.throws(() => ticketOf("Sure! Here is the ticket."), SyntaxError);
  assert.throws(() => ticketOf('{"category":"bug","urg'), SyntaxError);
  assert.equal(
    threw(() => ticketOf('"bug"')),
    "value must be an object",
  );
  assert.equal(
    threw(() =>
      ticketOf('{"category":"Bug","urgent":"yes","note":"x","orderId":7}'),
    ),
    [
      'category must be "billing" or "bug" or "other"',
      "urgent must be a boolean",
      "orderId must be a string, or orderId must be null",
      "note is not expected",
    ].join("; "),
  );
  assert.equal(
    threw(() => ticketOf('{"category":"bug","urgent":true}')),
    "orderId is missing",
  );
  const counts = { type: "array", items: { type: "integer" } };
  assert.equal(
    threw(() => parse(counts, [1, 2.5])),
    "value[1] must be an integer",
  );
});

test("parse() is exact about null: where the schema does not accept one, it is wrong", () => {
  const loose = (answer: string) =>
    parse(
      { type: "object", properties: { note: { type: "string" } } },
      JSON.parse(answer),
    );
  assert.deepEqual(loose("{}"), {});
  assert.deepEqual(loose('{"note":"x"}'), { note: "x" });
  // Left out is not the same as null: an optional property is either absent or what its schema says.
  assert.equal(
    threw(() => loose('{"note":null}')),
    "note must be a string",
  );
});

test("a schema that says something unenforced is a schema error, whatever was to be read against it", () => {
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const pattern = { type: "string", pattern: "^a" };
  // Whether or not the value fits what the schema does enforce: the schema is what is wrong.
  const fits = thrown(() => parse(pattern, "abc"));
  const fitsNot = thrown(() => parse(pattern, toronto.input));
  for (const error of [fits, fitsNot]) {
    assert.equal(isSchemaError(error), true);
    assert.match(String(error), /"pattern" is not one this enforces/);
  }
  assert.equal(
    isSchemaError(
      thrown(() => parse({ type: ["string", "null"] }, "a")),
    ),
    true,
  );
  // What a model got wrong is not one, and neither is anything else that is thrown.
  assert.equal(isSchemaError(thrown(() => ticketOf("{}"))), false);
  assert.equal(isSchemaError(thrown(() => ticketOf("not JSON"))), false);
  assert.equal(
    isSchemaError(
      thrown(() => parse(weather.schema, { city: 42 })),
    ),
    false,
  );
  assert.equal(isSchemaError(new TypeError("x is undefined")), false);
  assert.equal(isSchemaError("SchemaError"), false);
  // It goes by its name: anything by that name will do, whoever threw it.
  assert.equal(isSchemaError({ name: "SchemaError", message: "x" }), true);
  // Where a result is made, it is let through and not told to the model.
  const strict = (c: ToolCall) => {
    try {
      return toolResult(c, String(parse(pattern, c.input)));
    } catch (error) {
      if (isSchemaError(error)) throw error;
      return toolFailure(c, error);
    }
  };
  assert.throws(() => strict(toronto), /^SchemaError: schema: /);
});

// ── JSON that is still being written ────────────────────────────────────────

// Documents of every kind of value, written tight and written spaced out.
const documents = [
  {
    path: "notes/rain.txt",
    text: 'Soft rain.\n\t"Quoted" \\ and / and é and 😀.',
    lines: [1, -2.5, 3e21, 0, -0.0001],
    flags: { done: true, draft: false, owner: null },
    nested: [[], {}, [[1, "a"], { b: [null] }], ""],
  },
  ["a", ["b", ["c"]], { d: "e" }],
  "just a string",
  true,
  null,
  {},
  [],
].flatMap((value) => [JSON.stringify(value), JSON.stringify(value, null, 2)]);
// Whether `more` is `less` grown: strings longer, objects and arrays with more in them, all else the same.
const grown = (less: unknown, more: unknown): boolean => {
  if (less === undefined) return true;
  if (typeof less === "string")
    return typeof more === "string" && more.startsWith(less);
  if (Array.isArray(less))
    return (
      Array.isArray(more) &&
      less.length <= more.length &&
      less.every((item, i) => grown(item, more[i]))
    );
  if (typeof less === "object" && less !== null)
    return (
      typeof more === "object" &&
      more !== null &&
      !Array.isArray(more) &&
      Object.entries(less).every(
        ([key, held]) =>
          Object.hasOwn(more, key) &&
          grown(held, (more as Record<string, unknown>)[key]),
      )
    );
  return less === more;
};
const beginnings = (text: string) =>
  Array.from({ length: text.length + 1 }, (_, n) => text.slice(0, n));

test("partial() reads a whole document exactly as JSON.parse does", () => {
  for (const text of documents)
    assert.deepEqual(partial(text), JSON.parse(text));
  for (const text of [
    "0",
    "-0",
    "12",
    "-1.5e-3",
    "1E+2",
    " \n 7 \t",
    '"\\u00e9\\ud83d\\ude00\\/"',
    '{"a":1,"a":2,"b":3}',
    '{"__proto__":{"x":1}}',
  ])
    assert.deepEqual(partial(text), JSON.parse(text));
  // A property named __proto__ is a property, as JSON.parse makes it, and nothing more.
  const named = partial('{"__proto__":{"x":1}}') as Record<string, unknown>;
  assert.ok(Object.hasOwn(named, "__proto__"));
  assert.equal(Object.getPrototypeOf(named), Object.prototype);
  assert.ok(Object.is(partial("-0"), -0));
});

test("partial() reads every beginning of a document, and what it reads only grows", () => {
  for (const text of documents) {
    const read = beginnings(text).map(partial);
    read.forEach((value, n) => {
      if (n === 0) return;
      assert.ok(
        grown(read[n - 1], value),
        `${JSON.stringify(text.slice(0, n))} lost something the text before it held`,
      );
    });
    assert.deepEqual(read.at(-1), JSON.parse(text));
  }
});

test("partial(): a string is there as far as it is written, and anything else unfinished is left out", () => {
  // Nothing to read yet.
  assert.equal(partial(""), undefined);
  assert.equal(partial("  \n"), undefined);
  assert.deepEqual(partial("{"), {});
  assert.deepEqual(partial("["), []);
  // A string grows; an escape cut short says nothing until it is whole.
  assert.equal(partial('"'), "");
  assert.equal(partial('"Soft ra'), "Soft ra");
  assert.equal(partial('"a\\'), "a");
  assert.equal(partial('"a\\u00e'), "a");
  assert.equal(partial('"a\\u00e9'), "aé");
  assert.deepEqual(partial('{"text":"Soft ra'), { text: "Soft ra" });
  assert.deepEqual(partial('["a","b'), ["a", "b"]);
  // A property's name is not a property, and neither is a name with no value yet.
  assert.deepEqual(partial('{"pa'), {});
  assert.deepEqual(partial('{"path"'), {});
  assert.deepEqual(partial('{"path":'), {});
  assert.deepEqual(partial('{"a":1,"pa'), { a: 1 });
  // A number is whole once something follows it: until then it may gain digits.
  assert.deepEqual(partial('{"n":1'), {});
  assert.deepEqual(partial('{"n":10'), {});
  assert.deepEqual(partial('{"n":104,'), { n: 104 });
  assert.deepEqual(partial('{"n":104}'), { n: 104 });
  assert.deepEqual(partial("[1,2"), [1]);
  assert.deepEqual(partial("[1,2 "), [1, 2]);
  assert.deepEqual(partial("[-"), []);
  assert.deepEqual(partial("[1.5e"), []);
  // Half a word is no value.
  assert.deepEqual(partial('{"ok":tr'), {});
  assert.deepEqual(partial('{"ok":true'), { ok: true });
  assert.deepEqual(partial("[nul"), []);
  assert.deepEqual(partial("[null"), [null]);
  // A document that is a bare number is read as it stands, the one thing that does not only grow.
  assert.equal(partial("1"), 1);
  assert.equal(partial("12"), 12);
  assert.equal(partial("12."), undefined);
  assert.equal(partial("-"), undefined);
  assert.equal(partial("tru"), undefined);
});

test("partial() throws on text that no JSON document begins with, as JSON.parse does", () => {
  for (const text of [
    "x",
    "tx",
    "nul1",
    "01",
    "+1",
    "1.e5",
    "1.5.2",
    "[1,]",
    "[1 2",
    "[,",
    '{"a" 1',
    '{"a":1,}',
    "{,",
    "{a",
    '{"a":1}}',
    '{"a":1} x',
    '"a\\x"',
    '"a\\u00zz"',
    '"line\nbreak"',
    "[1]]",
    "undefined",
  ]) {
    assert.throws(() => partial(text), SyntaxError, text);
    assert.throws(() => JSON.parse(text), SyntaxError, text);
  }
  assert.throws(
    () => partial('{"a" 1'),
    /^SyntaxError: not the beginning of JSON: unexpected "1" at 5$/,
  );
});

test("partial() reads a tool call's input and a shaped answer while they are being written", async () => {
  // A call's input: the one growing part of a reply still arriving.
  const add = append<ToolInputPart | ToolCall>;
  const empty: Reply<ToolInputPart | ToolCall> = [];
  const seen = [
    writes("1", "get_weather", ""),
    writes("1", "get_weather", '{"city":"Tor'),
    writes("1", "get_weather", 'onto","days":'),
    writes("1", "get_weather", "3}"),
  ].map(
    (
      (reply) => (piece) =>
        (reply = add(reply, piece))
    )(empty),
  );
  assert.deepEqual(
    seen.map((reply) => {
      const part = reply[0]?.content.at(-1);
      return part && isToolInput(part) ? partial(part.text) : part;
    }),
    [undefined, { city: "Tor" }, { city: "Toronto" }, { city: "Toronto", days: 3 }],
  );

  // An answer asked for in a shape: text like any other, read as it grows.
  const pieces = ['{"category":"bil', 'ling","urgent":tr', 'ue,"orderId":null}'];
  let written = "";
  const read: unknown[] = [];
  for await (const chunk of played(...pieces.map(say), stop)) {
    if (!isText(chunk)) continue;
    written += chunk.text;
    read.push(partial(written));
  }
  assert.deepEqual(read, [
    { category: "bil" },
    { category: "billing" },
    { category: "billing", urgent: true, orderId: null },
  ]);
  // Unfinished, it does not fit the schema, and nothing says it does. Finished, it is read as ever.
  assert.throws(() => parse(triage.schema, read[0]));
  assert.deepEqual(ticketOf(written), read.at(-1));
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

// What a schema gives `parse`, as the compiler sees it. `npm run typecheck` fails if one of these types is off.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export const typed = () => {
  const input = parse(
    {
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
    toronto.input,
  );
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
  String(same) + String(wrong);
  // An answer's schema types what parse() returns, the way a tool's schema types its input.
  const ticket = ticketOf("");
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
  const loose = parse(widened, toronto.input);
  const sameLoose: Same<typeof loose, unknown> = true;
  String(sameLoose);
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
  rich({
    messages: [
      // @ts-expect-error a reply is a list of messages, not the content of one
      { from: "model", content: await collect(rich({ messages: [] })) },
    ],
  });
  // @ts-expect-error a provider that cannot take tool messages cannot be sent tool results
  textOnly({ messages: [{ from: "tool", content: [answer] }] });
};
