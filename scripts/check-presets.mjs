#!/usr/bin/env node
import { openDb } from '../src/db.js';
import { createPlugins, PLUGIN_PRESETS } from '../src/plugins.js';

/**
 * Call every endpoint in the catalogue, for real.
 *
 * A catalogue of endpoints is a promise that they work, and the only way to
 * keep that promise is to make the calls. This runs each preset through the
 * same engine an agent uses — the same templating, the same guards, the same
 * timeout — with arguments chosen to return something recognisable, and then
 * checks the response actually contains it. A 200 holding an error page is
 * not a working endpoint.
 *
 * Nothing here needs a key. If a call fails behind a corporate proxy or a
 * restricted network, that is what it will say.
 *
 *   node scripts/check-presets.mjs            all of them
 *   node scripts/check-presets.mjs sec        only ones whose name matches
 */

/** Arguments that should come back with something we can recognise. */
const PROBES = {
  crossref: { args: { query: 'attention is all you need', rows: 3 }, expect: /"DOI"/ },
  openalex: { args: { query: 'transformer architecture' }, expect: /"cited_by_count"/ },
  exchange_rates: { args: { date: 'latest', from: 'USD', to: 'EUR,GBP' }, expect: /"EUR"/ },
  quote: { args: { symbol: 'aapl.us' }, expect: /^Symbol,Date/i },
  world_bank: { args: { country: 'NG', indicator: 'NY.GDP.MKTP.CD', years: 3 }, expect: /"NY\.GDP\.MKTP\.CD"/ },
  world_bank_find: { args: { query: 'life expectancy' }, expect: /"id"\s*:\s*"SP\./ },
  imf: { args: { indicator: 'NGDP_RPCH', country: 'NGA' }, expect: /NGA/ },
  who: { args: { indicator: 'WHOSIS_000001' }, expect: /"value"/i },
  country_facts: { args: { name: 'nigeria' }, expect: /"capital"/ },
  sec_company: { args: {}, expect: /"cik_str"/ },
  sec_filings: { args: { cik: '0000320193' }, expect: /"tickers".*AAPL/s },
  sec_financials: { args: { cik: '0000320193', concept: 'NetIncomeLoss' }, expect: /"units"/ },
};

const filter = process.argv[2];
const chosen = PLUGIN_PRESETS.filter((p) => !filter || p.name.includes(filter) || p.group.toLowerCase().includes(filter.toLowerCase()));

const plugins = createPlugins(openDb(':memory:'));
const results = [];

for (const preset of chosen) {
  plugins.save({
    name: preset.name,
    description: preset.description,
    method: preset.method,
    url: preset.url,
    headers: preset.headers ?? {},
    params: preset.params,
  });

  const probe = PROBES[preset.name];
  if (!probe) {
    results.push({ name: preset.name, state: 'SKIP', note: 'no probe defined for this preset' });
    continue;
  }

  const started = Date.now();
  try {
    const body = await plugins.call({ name: preset.name, args: probe.args, agent: 'check' });
    const ms = Date.now() - started;
    const flat = String(body).replace(/\s+/g, ' ').trim();
    if (probe.expect.test(String(body))) {
      results.push({ name: preset.name, state: 'OK', ms, note: flat.slice(0, 90) });
    } else {
      // A 200 that does not contain what it should is a changed API, not a
      // working one, and saying "OK" here would be the whole point missed.
      results.push({ name: preset.name, state: 'ODD', ms, note: `answered, but ${probe.expect} was not in it: ${flat.slice(0, 90)}` });
    }
  } catch (err) {
    results.push({ name: preset.name, state: 'FAIL', ms: Date.now() - started, note: err.message.slice(0, 140) });
  }
}

const width = Math.max(...results.map((r) => r.name.length), 8);
for (const r of results) {
  const ms = r.ms === undefined ? '' : `${String(r.ms).padStart(5)}ms`;
  process.stdout.write(`${r.state.padEnd(5)} ${r.name.padEnd(width)} ${ms}  ${r.note}\n`);
}

const bad = results.filter((r) => r.state === 'FAIL' || r.state === 'ODD');
const ok = results.filter((r) => r.state === 'OK');
process.stdout.write(`\n${ok.length}/${results.length} answered as expected\n`);

if (results.some((r) => /allowlist|denied|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|403/.test(r.note))) {
  process.stdout.write(
    'Some of those look like a network policy rather than a broken endpoint: ' +
    'a proxy that only allows named hosts will refuse these the same way.\n',
  );
}
process.exit(bad.length ? 1 : 0);
