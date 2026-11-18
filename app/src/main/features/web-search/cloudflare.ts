// Cloudflare's Web Search API, as a `Search`. Thin: it turns a query into one
// request and the reply into results, and knows nothing of tools or threads.
// https://developers.cloudflare.com/web-search/how-to-use/
import type { Found, Search } from './web-search.ts';

/** Whose search Cloudflare passes the query to. They differ in price, and a good deal in what they find. */
export const PROVIDERS = ['linkup', 'exa', 'ceramic'] as const;
export type SearchProvider = (typeof PROVIDERS)[number];

export type CloudflareSearch = {
  /** How requests are made; the real `fetch`, or a stand-in under test. */
  fetch: typeof fetch;
  accountId: string;
  /** An API token allowed to read Workers AI and AI Gateway. */
  token: string;
  /** The AI Gateway the search runs through and is billed to. */
  gateway: string;
  provider: SearchProvider;
  /** How many results to ask for, from 1 to 10. */
  limit: number;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

// Some providers hand back titles as they stood in the page's HTML.
const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };
const plain = (text: string) => text.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (entity) => ENTITIES[entity] ?? entity);

/**
 * Why a request failed, as Cloudflare put it, when it said. Web search answers
 * with `{ error: { message } }`; the rest of Cloudflare's API with
 * `{ errors: [{ message }] }`. Neither is in the documentation.
 */
const reason = (body: unknown): string => {
  const { error, errors, message } = record(body);
  const [first] = Array.isArray(errors) ? (errors as unknown[]) : [];
  return string(record(error).message) || string(error) || string(record(first).message) || string(message);
};

/** The results in a reply. A result with no address is not one; anything else missing is left empty. */
const found = (body: unknown): readonly Found[] => {
  // As documented the results are at the top; Cloudflare's other APIs wrap theirs in `result`.
  const items = record(body).items ?? record(record(body).result).items;
  return (Array.isArray(items) ? items : [])
    .map(record)
    .filter((item) => string(item.url) !== '')
    .map((item) => ({ url: string(item.url), title: plain(string(item.title)), description: plain(string(item.description)) }));
};

export const cloudflareSearch =
  ({ fetch, accountId, token, gateway, provider, limit }: CloudflareSearch): Search =>
  async (query, signal) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/websearch/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, provider, limit, options: { gateway: { id: gateway } } }),
      signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`web search failed: ${[response.status, reason(body)].filter(Boolean).join(' ')}`);
    return found(body);
  };
