// Searching the web, as a tool the model may call. Written against one thing
// it needs: something that searches. Where the results come from is an
// adapter's business; see cloudflare.ts.
import { tool, type Tool } from '@ai-agent-library/library';

/** One search result. */
export type Found = { url: string; title: string; description: string };

/** Searches the web. Throws if the search could not be made. */
export type Search = (query: string, signal?: AbortSignal) => Promise<readonly Found[]>;

/** The longest query a search takes. */
export const QUERY_LENGTH = 1024;
/** How much of each result's description the model is given. Some run to thousands of characters. */
const DESCRIPTION_LENGTH = 1500;

const cut = (text: string, length: number) => {
  const letters = [...text];
  return letters.length <= length ? text : `${letters.slice(0, length).join('').trimEnd()}…`;
};

/** The results as the model reads them: numbered, each with its title, its address and what it says. */
export const listed = (found: readonly Found[]): string =>
  found.length === 0
    ? 'No results.'
    : found
        .map(({ title, url, description }, i) =>
          [`${i + 1}. ${title.trim() || url}`, `   ${url}`, ...(description.trim() ? [`   ${cut(description.trim().replace(/\s+/g, ' '), DESCRIPTION_LENGTH)}`] : [])].join('\n'),
        )
        .join('\n\n');

/** The tool. The model decides when a question needs it; the description is what it goes by. */
export const webSearch = (search: Search): Tool =>
  tool({
    name: 'web_search',
    description:
      'Search the web and get back titles, addresses and descriptions of matching pages. ' +
      'Use it when the answer depends on recent events, on live or changing facts such as prices, versions or schedules, ' +
      'or on something you are not sure of and a page could settle. ' +
      'Do not use it for what you already know well, or for reasoning, writing or mathematics. ' +
      'When you rely on a result, give its address.',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: QUERY_LENGTH,
          description: 'What to search for, as you would type it into a search engine.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async ({ query }, { signal }) => {
      // A schema cannot say "not only spaces", so that is checked here. A throw goes back to the model.
      const wanted = query.trim();
      if (wanted === '') throw new Error('query must not be empty');
      return listed(await search(wanted, signal));
    },
  });
