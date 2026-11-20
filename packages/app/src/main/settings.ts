// What the app is set up with, read from the environment. Pure: it is handed
// the variables and says what they amount to.
import { PROVIDERS, type SearchProvider } from './features/web-search/cloudflare.ts';

export type Settings = {
  /** Present when everything web search needs is set. */
  webSearch?: { accountId: string; token: string; gateway: string; provider: SearchProvider };
  /** The variables web search still needs. Empty when it has them all. */
  missing: readonly string[];
};

/**
 * - CLOUDFLARE_AI_GATEWAY: a Cloudflare API token allowed to read Workers AI and AI Gateway.
 * - CLOUDFLARE_ACCOUNT_ID: the account the token belongs to.
 * - CLOUDFLARE_AI_GATEWAY_ID: which AI Gateway to search through. Optional; every account has `default`.
 * - CLOUDFLARE_WEB_SEARCH_PROVIDER: `linkup`, `exa` or `ceramic`. Optional, and anything else is taken as unset.
 *   Linkup unless told: at $5 per 1,000 searches it costs twenty times what Ceramic does, but tried side by
 *   side Ceramic found nothing, or the wrong thing, for plain questions that Linkup and Exa answered.
 */
export const settings = (env: Readonly<Record<string, string | undefined>>): Settings => {
  const token = env.CLOUDFLARE_AI_GATEWAY?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const wanted = env.CLOUDFLARE_WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  const provider = PROVIDERS.find((known) => known === wanted) ?? 'linkup';
  const missing = [...(token ? [] : ['CLOUDFLARE_AI_GATEWAY']), ...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID'])];
  return token && accountId
    ? { webSearch: { accountId, token, gateway: env.CLOUDFLARE_AI_GATEWAY_ID?.trim() || 'default', provider }, missing }
    : { missing };
};
