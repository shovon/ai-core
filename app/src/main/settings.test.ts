import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from './settings.ts';

test('web search is set up when it has a token and an account, through the default gateway unless told', () => {
  assert.deepEqual(settings({ CLOUDFLARE_AI_GATEWAY: ' tok ', CLOUDFLARE_ACCOUNT_ID: 'acc' }), {
    webSearch: { accountId: 'acc', token: 'tok', gateway: 'default', provider: 'linkup' },
    missing: [],
  });
  assert.equal(settings({ CLOUDFLARE_AI_GATEWAY: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_AI_GATEWAY_ID: 'mine' }).webSearch?.gateway, 'mine');
});

test('the search provider can be chosen, and a name that is not one of them is taken as unset', () => {
  const base = { CLOUDFLARE_AI_GATEWAY: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' };
  assert.equal(settings({ ...base, CLOUDFLARE_WEB_SEARCH_PROVIDER: ' Exa ' }).webSearch?.provider, 'exa');
  assert.equal(settings({ ...base, CLOUDFLARE_WEB_SEARCH_PROVIDER: 'ceramic' }).webSearch?.provider, 'ceramic');
  assert.equal(settings({ ...base, CLOUDFLARE_WEB_SEARCH_PROVIDER: 'altavista' }).webSearch?.provider, 'linkup');
});

test('without either it is off, and what is missing is named', () => {
  assert.deepEqual(settings({}), { missing: ['CLOUDFLARE_AI_GATEWAY', 'CLOUDFLARE_ACCOUNT_ID'] });
  assert.deepEqual(settings({ CLOUDFLARE_AI_GATEWAY: 'tok' }), { missing: ['CLOUDFLARE_ACCOUNT_ID'] });
  assert.deepEqual(settings({ CLOUDFLARE_AI_GATEWAY: 'tok', CLOUDFLARE_ACCOUNT_ID: '  ' }), { missing: ['CLOUDFLARE_ACCOUNT_ID'] });
});
