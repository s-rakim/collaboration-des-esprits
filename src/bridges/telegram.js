/**
 * Telegram transport. Long polling, not webhooks, and that is the whole reason
 * this works on a machine at home: the server dials out to Telegram, so there
 * is no inbound port to open, no public hostname and no TLS certificate to get.
 *
 * It moves strings only. Commands are parsed in commands.js, and nothing here
 * generates a reply on an agent's behalf.
 */

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function call(token, method, payload, { timeoutMs = 70000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API(token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `telegram ${method} failed (${res.status})`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

export function createTelegram({ hub, router, token, log = (m) => process.stdout.write(`${m}\n`) }) {
  const db = hub.db;
  const getState = (k) => db.prepare('SELECT v FROM bridge_state WHERE k = ?').get(k)?.v ?? null;
  const setState = (k, v) =>
    db.prepare('INSERT INTO bridge_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));

  let stopped = false;

  /** Chunked so a long brief is never silently cut off by the 4096 limit. */
  async function send(chatId, body) {
    const { chunk } = await import('./commands.js');
    for (const part of chunk(body)) {
      if (!part.trim()) continue;
      await call(token, 'sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
    }
  }

  async function handleUpdate(u) {
    const msg = u.message ?? u.edited_message;
    if (!msg?.chat) return;
    const text = msg.text ?? msg.caption;
    if (!text) {
      // Nothing in this bridge understands media; say so rather than ignoring it.
      await send(msg.chat.id, 'I can only read text here. Type it out, or use the web room for anything richer.');
      return;
    }
    const { reply } = router.handle({
      platform: 'telegram',
      chatId: msg.chat.id,
      text,
      from: { username: msg.from?.username, first_name: msg.from?.first_name },
    });
    if (reply) await send(msg.chat.id, reply);
  }

  /** Push what agents need the human for, without relaying the whole room. */
  async function pushOut() {
    for (const p of router.pending()) {
      if (p.platform !== 'telegram') continue;
      try {
        await send(p.chatId, p.text);
        router.markDelivered(p.chat, p.upTo);
      } catch (err) {
        log(`telegram: push failed for ${p.chatId}: ${err.message}`);
      }
    }
    for (const o of router.optionsReady()) {
      if (o.platform !== 'telegram') continue;
      try {
        await send(o.chatId, o.text);
        router.markOptionsSent(o.stateKey, o.signature);
      } catch (err) {
        log(`telegram: options push failed for ${o.chatId}: ${err.message}`);
      }
    }
  }

  async function run() {
    const me = await call(token, 'getMe');
    log(`telegram: connected as @${me.username}`);

    // Notifications are pushed on their own cadence, so a quiet long-poll never
    // delays a nudge the human is waiting on.
    const pusher = setInterval(() => {
      pushOut().catch((err) => log(`telegram: push loop: ${err.message}`));
    }, 3000);

    let backoff = 1000;
    while (!stopped) {
      try {
        const offset = Number(getState('telegram.offset') ?? 0);
        const updates = await call(
          token,
          'getUpdates',
          { offset, timeout: 50, allowed_updates: ['message', 'edited_message'] },
          { timeoutMs: 70000 },
        );
        backoff = 1000;
        for (const u of updates) {
          try {
            await handleUpdate(u);
          } catch (err) {
            log(`telegram: update ${u.update_id} failed: ${err.message}`);
          }
          // Advance past every update we took, even a failed one — otherwise a
          // single bad message wedges the loop forever.
          setState('telegram.offset', u.update_id + 1);
        }
      } catch (err) {
        if (stopped) break;
        if (err.name === 'AbortError') continue; // long poll simply expired
        log(`telegram: ${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    clearInterval(pusher);
  }

  return { run, send, stop: () => { stopped = true; } };
}
