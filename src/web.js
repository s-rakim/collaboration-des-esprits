/**
 * WebBridge: letting agents look things up.
 *
 * This exists so a claim can rest on something. An agent that cannot check
 * anything has only its training to go on, and the failure mode of that is
 * confident invention — which is precisely what the prefect is there to catch.
 *
 * Search goes through a user-defined connection, because every provider differs
 * in shape; the differences are described per connection rather than hard-coded.
 * Fetch needs no provider at all.
 */

const TIMEOUT_MS = 25_000;
const MAX_BYTES = 3_000_000;

/** Walk a dotted path, since providers bury results at different depths. */
function at(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

async function withTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuse anything that is not plainly a public web page.
 *
 * An agent choosing the URL means the URL is untrusted input, and a server that
 * will fetch any address on request can be pointed at the machine's own network
 * — cloud metadata endpoints, admin panels on localhost, printers. Blocking the
 * private ranges is the difference between a browser and an open proxy.
 */
export function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('that is not a URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https are allowed');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('refusing to fetch a local address');
  }
  // IPv4 private, loopback, link-local (which includes cloud metadata at 169.254.169.254).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || a >= 224) {
      throw new Error('refusing to fetch a private address');
    }
  }
  // IPv6 loopback and unique-local.
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) {
    throw new Error('refusing to fetch a private address');
  }
  return u;
}

/** Strip a page down to something a model can actually read. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function createWebBridge({ connections, log = () => {} }) {
  /**
   * Search. The differences between providers live in the connection's `extra`:
   * which HTTP verb, where the query goes, which header carries the key, and
   * where the results are buried.
   */
  async function search({ query, limit = 6 }) {
    const name = connections.ofKind('search')[0]?.name;
    const conn = name ? connections.resolve(name) : null;
    if (!conn) throw new Error('no web search connection is configured — add one at /setup');
    if (!String(query ?? '').trim()) throw new Error('a query is required');

    const e = conn.extra ?? {};
    const base = String(conn.baseURL).replace(/\/+$/, '');
    const headers = { Accept: 'application/json', ...(e.headers ?? {}) };
    if (conn.apiKey) headers[e.headerName ?? 'Authorization'] = e.headerName ? conn.apiKey : `Bearer ${conn.apiKey}`;

    let res;
    if ((e.method ?? 'GET').toUpperCase() === 'POST') {
      res = await withTimeout(`${base}${e.path ?? ''}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ [e.bodyKey ?? 'query']: query, max_results: limit, ...(e.body ?? {}) }),
      });
    } else {
      const u = new URL(`${base}${e.path ?? ''}`);
      u.searchParams.set(e.query ?? 'q', query);
      if (e.format) u.searchParams.set('format', e.format);
      u.searchParams.set(e.countKey ?? 'count', String(limit));
      res = await withTimeout(u, { headers });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${conn.name} returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const rows = at(data, e.resultsPath ?? 'results');
    if (!Array.isArray(rows)) throw new Error(`could not find results in ${conn.name}'s response`);

    return rows.slice(0, limit).map((r) => ({
      title: r.title ?? r.name ?? '',
      url: r.url ?? r.link ?? r.href ?? '',
      snippet: (r.description ?? r.snippet ?? r.content ?? '').slice(0, 600),
    })).filter((r) => r.url);
  }

  /** Fetch one page as readable text. */
  async function fetchPage({ url, maxChars = 30_000 }) {
    const u = checkUrl(url);
    const res = await withTimeout(u, {
      headers: { 'User-Agent': 'collaboration-des-esprits/0.1 (+agent web bridge)', Accept: 'text/html,text/plain,application/json;q=0.9' },
    });
    if (!res.ok) throw new Error(`${u.host} returned ${res.status}`);

    const type = res.headers.get('content-type') ?? '';
    if (!/text\/|json|xml/.test(type)) throw new Error(`${u.host} served ${type || 'an unreadable type'}`);

    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new Error('that page is too large to read');

    const raw = (await res.text()).slice(0, MAX_BYTES);
    const text = /html/.test(type) ? htmlToText(raw) : raw.trim();
    const title = raw.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1]?.trim();

    log(`web: fetched ${u.host} (${text.length} chars)`);
    return {
      url: u.toString(),
      title: title ?? u.host,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  }

  return { search, fetchPage, available: () => connections.ofKind('search').length > 0 };
}
