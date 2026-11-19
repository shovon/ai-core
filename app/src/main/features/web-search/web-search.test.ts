import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolCall } from "@ai-agent-library/library";
import { cloudflareSearch } from "./cloudflare.ts";
import { listed, webSearch, type Found, type Search } from "./web-search.ts";

const page = (n: number, description = `About ${n}.`): Found => ({
  url: `https://example.com/${n}`,
  title: `Page ${n}`,
  description,
});
const call = (input: unknown): ToolCall => ({
  type: "tool_call",
  id: "c1",
  name: "web_search",
  input,
});

// ── The tool ────────────────────────────────────────────────────────────────

test("the tool searches for what the model asked and hands back the results as a numbered list", async () => {
  const asked: string[] = [];
  const search: Search = async (query) => (
    asked.push(query),
    [page(1), page(2)]
  );
  const result = await webSearch(search).run(
    call({ query: "  cayley bacharach  " }),
  );
  assert.deepEqual(asked, ["cayley bacharach"]);
  assert.equal(
    result,
    [
      "1. Page 1",
      "   https://example.com/1",
      "   About 1.",
      "",
      "2. Page 2",
      "   https://example.com/2",
      "   About 2.",
    ].join("\n"),
  );
});

test("no results is said plainly, not left empty", () => {
  assert.equal(listed([]), "No results.");
});

test("a long description is cut, kept on one line, and a result with no title goes by its address", () => {
  const long = listed([
    {
      url: "https://example.com/long",
      title: " ",
      description: `first line\n\n${"word ".repeat(1000)}`,
    },
  ]);
  const [title, address, description] = long.split("\n");
  assert.equal(title, "1. https://example.com/long");
  assert.equal(address, "   https://example.com/long");
  assert.match(description ?? "", /^ {3}first line word word .*…$/);
  assert.equal([...(description ?? "")].length <= 1504, true);
  assert.equal(long.split("\n").length, 3);
});

test("a call the model got wrong throws what is wrong with it, and nothing is searched", async () => {
  let searched = 0;
  const { run } = webSearch(async () => (searched++, []));
  for (const [input, why] of [
    [{}, /query is missing/],
    [{ query: 7 }, /query must be a string/],
    ["cats", /value must be an object/],
    [{ query: "" }, /query must be 1 or more characters long/],
    [{ query: "   " }, /query must not be empty/],
    [
      { query: "x".repeat(1025) },
      /query must be 1024 or fewer characters long/,
    ],
    [{ query: "cats", site: "example.com" }, /site is not expected/],
  ] as const) {
    await assert.rejects(run(call(input)), why);
  }
  assert.equal(searched, 0);
});

test("a search that fails throws what went wrong, for the model to be told", async () => {
  const { run } = webSearch(async () =>
    Promise.reject(new Error("web search failed: 403 Authentication error")),
  );
  await assert.rejects(
    run(call({ query: "cats" })),
    /web search failed: 403 Authentication error/,
  );
});

test("the tool tells the model when to use it, and takes one string", () => {
  const { name, description, schema } = webSearch(async () => []);
  assert.equal(name, "web_search");
  assert.match(description, /recent events/);
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description:
          "What to search for, as you would type it into a search engine.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  });
});

// ── Cloudflare ──────────────────────────────────────────────────────────────

// A stand-in for fetch that answers with the given reply and records what was asked.
const answering = (status: number, body: unknown) => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    );
  };
  return { fake, seen };
};
const settings = {
  accountId: "acc 1",
  token: "secret",
  gateway: "default",
  provider: "linkup",
  limit: 5,
} as const;

test("cloudflare: one search is one request, with the token in a header and never in the body", async () => {
  const { fake, seen } = answering(200, {
    items: [page(1)],
    metadata: { query: "cats", requestId: "r", latencyMs: 9 },
  });
  const found = await cloudflareSearch({ fetch: fake, ...settings })("cats");
  assert.deepEqual(found, [page(1)]);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0]?.url,
    "https://api.cloudflare.com/client/v4/accounts/acc%201/ai/websearch/",
  );
  assert.equal(seen[0]?.init?.method, "POST");
  assert.deepEqual(seen[0]?.init?.headers, {
    Authorization: "Bearer secret",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
    query: "cats",
    provider: "linkup",
    limit: 5,
    options: { gateway: { id: "default" } },
  });
});

test("cloudflare: results are read where they are, and what is missing from one is left empty", async () => {
  const wrapped = answering(200, {
    success: true,
    result: { items: [page(2)] },
  });
  assert.deepEqual(
    await cloudflareSearch({ fetch: wrapped.fake, ...settings })("cats"),
    [page(2)],
  );

  const ragged = answering(200, {
    items: [
      { url: "https://example.com/a" },
      { title: "no address" },
      "nonsense",
      { url: "https://example.com/b", title: 7, description: "B." },
    ],
  });
  assert.deepEqual(
    await cloudflareSearch({ fetch: ragged.fake, ...settings })("cats"),
    [
      { url: "https://example.com/a", title: "", description: "" },
      { url: "https://example.com/b", title: "", description: "B." },
    ],
  );

  // A title as it stood in the page's HTML is given back as it reads.
  const escaped = answering(200, {
    items: [
      {
        url: "https://example.com/c",
        title: "Today &amp; Tomorrow &#39;26",
        description: "A &lt;b&gt; tag",
      },
    ],
  });
  assert.deepEqual(
    await cloudflareSearch({ fetch: escaped.fake, ...settings })("cats"),
    [
      {
        url: "https://example.com/c",
        title: "Today & Tomorrow '26",
        description: "A <b> tag",
      },
    ],
  );

  const empty = answering(200, {});
  assert.deepEqual(
    await cloudflareSearch({ fetch: empty.fake, ...settings })("cats"),
    [],
  );
});

test("cloudflare: a refusal is an error that says what Cloudflare said", async () => {
  const denied = answering(403, {
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }],
  });
  await assert.rejects(
    cloudflareSearch({ fetch: denied.fake, ...settings })("cats"),
    /web search failed: 403 Authentication error/,
  );
  // As web search itself refuses: seen when the account had no credits.
  const unpaid = answering(402, {
    ok: false,
    error: {
      category: "gateway",
      code: "web_search_payment_required",
      status: 402,
      message: "Your AI Gateway credit balance is zero.",
    },
  });
  await assert.rejects(
    cloudflareSearch({ fetch: unpaid.fake, ...settings })("cats"),
    /web search failed: 402 Your AI Gateway credit balance is zero\.$/,
  );
  const broken = answering(502, "<html>bad gateway</html>");
  await assert.rejects(
    cloudflareSearch({ fetch: broken.fake, ...settings })("cats"),
    /web search failed: 502$/,
  );
});

test("cloudflare: the signal reaches the request, so a search can be stopped", async () => {
  const { fake, seen } = answering(200, { items: [] });
  const controller = new AbortController();
  await cloudflareSearch({ fetch: fake, ...settings })(
    "cats",
    controller.signal,
  );
  assert.equal(seen[0]?.init?.signal, controller.signal);
});
