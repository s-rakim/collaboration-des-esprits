import { checkUrl } from './web.js';

/**
 * User-defined HTTP tools the agents can call.
 *
 * A plugin is a request shape you describe once. The description matters as
 * much as the URL: it is what a model reads to decide whether to reach for the
 * thing, so a vague one gets called at the wrong moments or never at all.
 *
 * Every call is logged. A plugin is the point where the room touches the
 * outside world, which makes it the part most worth being able to audit.
 */

const TIMEOUT_MS = 30_000;

/**
 * The catalogue.
 *
 * Two kinds of entry, and the difference is the point. Some of these are
 * capabilities this room already has — reading a PDF, making a picture, saying
 * something aloud, searching the web — and for those the honest entry is a
 * pointer to where it already lives, not a plugin wrapping it. The rest are
 * real public endpoints, filled in and ready to call, every one of which works
 * without a key.
 *
 * Nothing here is a stub. If an entry is listed as built in, following the link
 * gets you the working thing; if it is listed as an endpoint, adding it makes a
 * call that returns data.
 */
export const BUILT_IN = [
  { name: 'PDF', icon: '📄', where: '/', how: 'attach',
    blurb: 'Drop a PDF into the chat and its text is pulled out and put in the brief, so every agent can read it.',
    detail: 'Parsed here, including subset fonts. A scanned page says so rather than returning nonsense.' },
  { name: 'Excel', icon: '📊', where: '/', how: 'attach',
    blurb: 'Attach a workbook and every sheet arrives as rows the agents can read.',
    detail: 'Each sheet keeps its name and its column alignment, so a number stays in its column.' },
  { name: 'Word', icon: '📝', where: '/', how: 'attach',
    blurb: 'Attach a document and the prose comes through with its paragraphs, tabs and tables.',
    detail: 'Headers, footers and footnotes are included. Field codes are left out.' },
  { name: 'PowerPoint', icon: '📽', where: '/', how: 'attach',
    blurb: 'Attach a deck and each slide arrives as its own block of text.',
    detail: 'In slide order, so a narrative deck still reads as one.' },
  { name: 'Image generation', icon: '🎨', where: '/design', how: 'connection:image',
    blurb: 'Make images in the chat or on the design page; everything made is kept in the library.',
    detail: 'Any endpoint with the usual /images/generations shape. Agents can call it themselves.' },
  { name: 'Video generation', icon: '🎬', where: '/design', how: 'connection:video',
    blurb: 'Make video from a prompt. Slow, and kept in the library like anything else.',
    detail: 'Handles both the providers that return a link and the ones that make you poll a job.' },
  { name: 'Audio generation', icon: '🔊', where: '/design', how: 'connection:speak',
    blurb: 'Say something in the room\'s voice, and keep the file.',
    detail: 'The same voice reads replies aloud in live chat, so the room sounds like one thing.' },
  { name: 'Web search', icon: '🌐', where: '/setup', how: 'connection:search',
    blurb: 'Lets agents look things up, so a claim can rest on something.',
    detail: 'Brave, Tavily or a local SearXNG. The prefect uses it to check what the room asserts.' },
  { name: 'Swarm', icon: '🐝', where: '/work', how: 'work',
    blurb: 'Split a job into pieces, run them in parallel across your models, and merge the answers.',
    detail: 'One planner, many workers, one merger. The result is saved as an artifact.' },
];

/**
 * Endpoints, ready to add. Every one is public and needs no key, so a preset
 * either works when you add it or tells you why not.
 */
export const PLUGIN_PRESETS = [
  {
    group: 'Academic data',
    name: 'crossref',
    label: 'Crossref',
    description:
      'Search the published literature by title, author or subject. Returns titles, authors, journals, ' +
      'years and DOIs. Use it to find the paper behind a claim, or to check that one exists.',
    method: 'GET',
    url: 'https://api.crossref.org/works?query.bibliographic={{query}}&rows={{rows}}&select=title,author,issued,DOI,container-title,is-referenced-by-count',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title, author or subject.' },
        rows: { type: 'integer', description: 'How many results, 1-20.' },
      },
      required: ['query'],
    },
  },
  {
    group: 'Academic data',
    name: 'openalex',
    label: 'OpenAlex',
    description:
      'Search 250 million scholarly works, with citation counts and open-access links. Broader than ' +
      'Crossref and better for "how well cited is this".',
    method: 'GET',
    url: 'https://api.openalex.org/works?search={{query}}&per-page=5&select=id,title,publication_year,cited_by_count,doi,open_access',
    params: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
  },
  {
    group: 'Global finance data',
    name: 'exchange_rates',
    label: 'Exchange rates',
    description:
      'Official exchange rates from the European Central Bank, current or historical. Pass date as ' +
      '"latest" or YYYY-MM-DD, and currencies as three-letter codes.',
    method: 'GET',
    url: 'https://api.frankfurter.app/{{date}}?from={{from}}&to={{to}}',
    params: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '"latest" or YYYY-MM-DD.' },
        from: { type: 'string', description: 'Base currency, e.g. USD.' },
        to: { type: 'string', description: 'Target currency or comma-separated list, e.g. EUR,GBP.' },
      },
      required: ['date', 'from', 'to'],
    },
  },
  {
    group: 'Global finance data',
    name: 'quote',
    label: 'Market quote',
    description:
      'Last price for a stock, index, commodity or crypto pair, as CSV. Symbols are Stooq symbols: ' +
      'aapl.us, msft.us, ^spx, btcusd, xauusd.',
    method: 'GET',
    url: 'https://stooq.com/q/l/?s={{symbol}}&f=sd2t2ohlcv&h&e=csv',
    params: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'e.g. aapl.us, ^spx, btcusd.' } },
      required: ['symbol'],
    },
  },
  {
    group: 'World Bank open data',
    name: 'world_bank',
    label: 'World Bank indicator',
    description:
      'Any World Bank indicator for any country, most recent values first. Country is an ISO code or ' +
      '"all"; indicator is a World Bank code — NY.GDP.MKTP.CD for GDP, SP.POP.TOTL for population, ' +
      'FP.CPI.TOTL.ZG for inflation, SL.UEM.TOTL.ZS for unemployment.',
    method: 'GET',
    url: 'https://api.worldbank.org/v2/country/{{country}}/indicator/{{indicator}}?format=json&mrv={{years}}',
    params: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'ISO code (NG, US, GB) or "all".' },
        indicator: { type: 'string', description: 'World Bank indicator code.' },
        years: { type: 'integer', description: 'How many recent years, 1-30.' },
      },
      required: ['country', 'indicator'],
    },
  },
  {
    group: 'World Bank open data',
    name: 'world_bank_find',
    label: 'Find an indicator',
    description:
      'Search the World Bank catalogue for the code of an indicator by name. Use this first when you ' +
      'do not know the code, then pass what it returns to world_bank.',
    method: 'GET',
    url: 'https://api.worldbank.org/v2/indicator?format=json&per_page=20&source=2&search={{query}}',
    params: {
      type: 'object',
      properties: { query: { type: 'string', description: 'e.g. "life expectancy".' } },
      required: ['query'],
    },
  },
  {
    group: 'IMF data',
    name: 'imf',
    label: 'IMF DataMapper',
    description:
      'IMF macro series and forecasts. Indicator codes: NGDP_RPCH (real GDP growth), PCPIPCH ' +
      '(inflation), LUR (unemployment), GGXWDG_NGDP (government debt to GDP), BCA_NGDPD (current ' +
      'account). Country is an ISO3 code, or several separated by slashes.',
    method: 'GET',
    url: 'https://www.imf.org/external/datamapper/api/v1/{{indicator}}/{{country}}',
    params: {
      type: 'object',
      properties: {
        indicator: { type: 'string', description: 'IMF indicator code.' },
        country: { type: 'string', description: 'ISO3 code, e.g. NGA, USA.' },
      },
      required: ['indicator', 'country'],
    },
  },
  {
    group: 'International organizations',
    name: 'who',
    label: 'WHO health data',
    description:
      'World Health Organization indicator data. Call it with no indicator to list what exists, then ' +
      'with a code — WHOSIS_000001 is life expectancy at birth.',
    method: 'GET',
    url: 'https://ghoapi.azureedge.net/api/{{indicator}}',
    params: {
      type: 'object',
      properties: { indicator: { type: 'string', description: 'GHO indicator code, or "Indicator" to list them.' } },
      required: ['indicator'],
    },
  },
  {
    group: 'International organizations',
    name: 'country_facts',
    label: 'Country facts',
    description:
      'Capital, population, region, currencies, languages and borders for a country. Good for settling ' +
      'the small factual questions that otherwise get guessed at.',
    method: 'GET',
    url: 'https://restcountries.com/v3.1/name/{{name}}?fields=name,capital,population,region,subregion,currencies,languages,borders,cca3',
    params: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Country name, full or partial.' } },
      required: ['name'],
    },
  },
  {
    group: 'SEC filings',
    name: 'sec_company',
    label: 'SEC company lookup',
    description:
      'Every company that files with the SEC, by ticker and name, with its CIK number. The CIK is what ' +
      'the other SEC tools need, so start here.',
    method: 'GET',
    url: 'https://www.sec.gov/files/company_tickers.json',
    headers: { 'User-Agent': 'collaboration-des-esprits (set-a-contact-address@example.com)' },
    params: { type: 'object', properties: {} },
    needsEdit: 'Put a real contact address in the User-Agent header — the SEC asks every caller to identify itself.',
  },
  {
    group: 'SEC filings',
    name: 'sec_filings',
    label: 'SEC filings',
    description:
      'Every filing a company has made, newest first, with form types and dates. CIK is the ten-digit ' +
      'zero-padded number from sec_company — Apple is 0000320193.',
    method: 'GET',
    url: 'https://data.sec.gov/submissions/CIK{{cik}}.json',
    headers: { 'User-Agent': 'collaboration-des-esprits (set-a-contact-address@example.com)' },
    params: {
      type: 'object',
      properties: { cik: { type: 'string', description: 'Ten digits, zero-padded, e.g. 0000320193.' } },
      required: ['cik'],
    },
    needsEdit: 'Put a real contact address in the User-Agent header — the SEC asks every caller to identify itself.',
  },
  {
    group: 'SEC filings',
    name: 'sec_financials',
    label: 'SEC reported figures',
    description:
      'One reported figure for one company across every filing it appears in — the audited number, not ' +
      'a summary of it. Concepts are US-GAAP tags: Revenues, NetIncomeLoss, Assets, Liabilities, ' +
      'CashAndCashEquivalentsAtCarryingValue, EarningsPerShareDiluted.',
    method: 'GET',
    url: 'https://data.sec.gov/api/xbrl/companyconcept/CIK{{cik}}/us-gaap/{{concept}}.json',
    headers: { 'User-Agent': 'collaboration-des-esprits (set-a-contact-address@example.com)' },
    params: {
      type: 'object',
      properties: {
        cik: { type: 'string', description: 'Ten digits, zero-padded.' },
        concept: { type: 'string', description: 'A US-GAAP tag, e.g. NetIncomeLoss.' },
      },
      required: ['cik', 'concept'],
    },
    needsEdit: 'Put a real contact address in the User-Agent header — the SEC asks every caller to identify itself.',
  },
];


/** Substitute {{field}} from the model's arguments, escaping for the context. */
function fill(template, args, { encode = 'none' } = {}) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), args);
    if (value === undefined || value === null) return '';
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // A model supplies these, so they are untrusted: encoded for wherever they
    // land rather than pasted in raw.
    if (encode === 'url') return encodeURIComponent(s);
    if (encode === 'json') return JSON.stringify(s).slice(1, -1);
    return s;
  });
}

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/**
 * What the server said, not just the number it said it with.
 *
 * "HTTP 403" leaves an agent with nowhere to go. "HTTP 403: Host not in
 * allowlist: api.example.com" names the thing to fix, and the agent can say so
 * to the human instead of retrying a call that will never work.
 */
export function formatFailure(status, body) {
  const why = String(body ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return why ? `HTTP ${status}: ${why}` : `HTTP ${status}`;
}

export function createPlugins(db, { log = () => {} } = {}) {
  const view = (r) => ({
    name: r.name,
    description: r.description,
    method: r.method,
    url: r.url,
    headers: parse(r.headers, {}),
    body: r.body,
    params: parse(r.params, { type: 'object', properties: {} }),
    enabled: Boolean(r.enabled),
    lastUsed: r.last_used ?? null,
    createdAt: r.created_at,
  });

  return {
    all() {
      return db.prepare('SELECT * FROM plugins ORDER BY created_at, name').all().map(view);
    },

    enabled() {
      return this.all().filter((p) => p.enabled);
    },

    get(name) {
      const r = db.prepare('SELECT * FROM plugins WHERE name = ?').get(String(name));
      return r ? view(r) : null;
    },

    save({ name, description = '', method = 'GET', url, headers = {}, body = '', params, enabled = true, rename }) {
      const handle = String(name ?? '').trim();
      if (!handle) throw new Error('a plugin needs a name');
      if (!/^[a-z0-9_]{1,48}$/i.test(handle)) throw new Error('use letters, numbers and underscores — the model calls it by this name');
      if (!String(url ?? '').trim()) throw new Error('a plugin needs a URL');
      // Validate the template with the placeholders removed, so a URL that is
      // only valid once filled still passes.
      checkUrl(String(url).replace(/\{\{[^}]*\}\}/g, 'x'));
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())) {
        throw new Error('method must be GET, POST, PUT, PATCH or DELETE');
      }

      db.prepare(
        `INSERT INTO plugins (name, description, method, url, headers, body, params, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description, method = excluded.method, url = excluded.url,
           headers = excluded.headers, body = excluded.body, params = excluded.params,
           enabled = excluded.enabled`,
      ).run(handle, String(description), String(method).toUpperCase(), String(url).trim(),
            JSON.stringify(headers ?? {}), String(body ?? ''),
            JSON.stringify(params ?? { type: 'object', properties: {} }),
            enabled ? 1 : 0, new Date().toISOString());

      if (rename && rename !== handle) {
        if (!/^[a-z0-9_]{1,48}$/i.test(rename)) throw new Error('bad new name');
        db.prepare('UPDATE plugins SET name = ? WHERE name = ?').run(rename, handle);
        return this.get(rename);
      }
      return this.get(handle);
    },

    remove(name) {
      return db.prepare('DELETE FROM plugins WHERE name = ?').run(String(name)).changes > 0;
    },

    /** Call one. Returns what the model should see, and logs what happened. */
    async call({ name, args = {}, agent = 'unknown' }) {
      const p = this.get(name);
      if (!p) throw new Error(`no plugin named "${name}"`);
      if (!p.enabled) throw new Error(`the plugin "${name}" is switched off`);

      const started = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let status = null;
      let ok = false;
      let out = '';
      let error = '';

      try {
        // Inside the logged path on purpose. A model filling a template so that
        // the URL points at the machine's own network is the single call most
        // worth having in the log, and it is refused before a socket is opened.
        const url = checkUrl(fill(p.url, args, { encode: 'url' }));
        const headers = Object.fromEntries(
          Object.entries(p.headers).map(([k, v]) => [k, fill(v, args)]),
        );
        const body = p.body ? fill(p.body, args, { encode: 'json' }) : undefined;
        if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }

        const res = await fetch(url, {
          method: p.method,
          headers,
          body: p.method === 'GET' || p.method === 'DELETE' ? undefined : body,
          signal: ctl.signal,
        });
        status = res.status;
        ok = res.ok;
        out = (await res.text()).slice(0, 40_000);
        if (!res.ok) error = formatFailure(res.status, out);
      } catch (err) {
        error = err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
      } finally {
        clearTimeout(timer);
      }

      const ms = Date.now() - started;
      db.prepare(
        `INSERT INTO plugin_calls (plugin, agent, args, status, ok, response, error, ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.name, agent, JSON.stringify(args).slice(0, 4000), status, ok ? 1 : 0,
            out.slice(0, 8000), error, ms, new Date().toISOString());
      db.prepare('UPDATE plugins SET last_used = ? WHERE name = ?').run(new Date().toISOString(), p.name);

      log(`plugin ${p.name} by ${agent}: ${error || status} in ${ms}ms`);
      if (error) throw new Error(`${p.name}: ${error}`);
      return out;
    },

    calls({ plugin = undefined, limit = 50 } = {}) {
      const rows = plugin
        ? db.prepare('SELECT * FROM plugin_calls WHERE plugin = ? ORDER BY id DESC LIMIT ?').all(plugin, limit)
        : db.prepare('SELECT * FROM plugin_calls ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map((r) => ({
        id: r.id, plugin: r.plugin, agent: r.agent, args: parse(r.args, {}),
        status: r.status, ok: Boolean(r.ok), error: r.error || undefined,
        ms: r.ms, createdAt: r.created_at,
        // The response body is kept but not listed; it can be large.
        preview: r.response.slice(0, 200),
      }));
    },
  };
}
