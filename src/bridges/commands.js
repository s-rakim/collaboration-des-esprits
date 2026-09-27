/**
 * The phone-side command language, kept free of any network code so it can be
 * tested without a Telegram token. telegram.js does nothing but move strings
 * between the Bot API and this router.
 *
 * Design rules, because the client is a thumb on a phone:
 *  - bare text is the common case: it posts to whatever idea the chat is on
 *  - every command works lowercase, with or without the leading slash
 *  - replies are plain text, never Markdown — no parse_mode means no escaping
 *    bug can swallow a message
 */

const TELEGRAM_LIMIT = 4096;

/** Split a long reply on line boundaries so nothing is silently truncated. */
export function chunk(textBody, limit = TELEGRAM_LIMIT - 96) {
  const out = [];
  let buf = '';
  for (const line of String(textBody).split('\n')) {
    // A single line longer than the limit has to be hard-split.
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) { out.push(buf); buf = line; }
    else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [''];
}

const HELP = [
  'What you can do from here:',
  '',
  'Just type — it posts to the idea this chat is on.',
  '',
  '/idea <title>        drop a new idea (put the detail on the next lines)',
  '/ideas               list ideas',
  '/use <slug>          switch this chat to an idea',
  '/brief [slug]        the full context pack',
  '/status              what is stuck and why',
  '/who                 who is in the room',
  '/q                   questions waiting on you',
  '/a <id> <answer>     answer one',
  '/props [slug]        where the proposals stand',
  '/choose <id> [why]   pick a route',
  '/decide <text>       record a decision',
  '/remember k=v        store a durable fact',
  '/tasks [slug]        the board',
  '/search <text>       search everything ever said',
  '/notify on|off       push when agents need you',
  '/me <handle>         change your handle',
  '/stop                unpair this chat',
].join('\n');

/** Sanitise a chat display name into a valid room handle. */
function handleFrom(raw, fallback = 'me') {
  const h = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '');
  return h.slice(0, 32) || fallback;
}

export function createRouter({ hub, pairCode = '', defaultHandle = '' }) {
  const db = hub.db;

  const getChat = (platform, chatId) =>
    db.prepare('SELECT * FROM bridge_chats WHERE platform = ? AND chat_id = ?').get(platform, String(chatId));

  const upsertChat = (platform, chatId, fields) => {
    const existing = getChat(platform, chatId);
    if (!existing) {
      db.prepare('INSERT INTO bridge_chats (platform, chat_id, created_at) VALUES (?, ?, ?)')
        .run(platform, String(chatId), new Date().toISOString());
    }
    for (const [k, v] of Object.entries(fields ?? {})) {
      db.prepare(`UPDATE bridge_chats SET ${k} = ? WHERE platform = ? AND chat_id = ?`).run(v, platform, String(chatId));
    }
    return getChat(platform, chatId);
  };

  /** The idea this chat is currently talking about, as a slug, or null. */
  const currentSlug = (chat) => {
    if (!chat?.current_idea) return null;
    const row = db.prepare('SELECT slug FROM ideas WHERE id = ?').get(chat.current_idea);
    return row?.slug ?? null;
  };

  function handle({ platform = 'telegram', chatId, text, from = {} }) {
    const raw = String(text ?? '').trim();
    let chat = getChat(platform, chatId);

    // ---- pairing gate -----------------------------------------------------
    // Until a chat is paired it can do exactly one thing. Otherwise anybody
    // who guesses the bot's handle would have the whole project.
    const paired = chat?.paired_at && chat.agent_name;
    const [cmdRaw, ...restParts] = raw.split(/\s+/);
    const cmd = cmdRaw.toLowerCase().replace(/^\//, '').replace(/@.*$/, '');
    const rest = raw.slice(cmdRaw.length).trim();

    if (!paired) {
      if (cmd !== 'pair' && cmd !== 'start') {
        return { reply: 'This chat is not paired. Send:\n/pair <code>\n\nThe code is whatever ESPRITS_PAIR_CODE is set to on your server.' };
      }
      if (cmd === 'start') return { reply: 'Send /pair <code> to link this chat to your room.' };
      const [code, wanted] = restParts;
      if (!pairCode) return { reply: 'Pairing is disabled: ESPRITS_PAIR_CODE is not set on the server.' };
      if (code !== pairCode) return { reply: 'Wrong code.' };

      const name = handleFrom(wanted ?? defaultHandle ?? from.username ?? from.first_name, 'me');
      try {
        hub.join({ name, role: 'human', kind: 'human', model: `telegram` });
      } catch (err) {
        return { reply: `Could not join as "${name}": ${err.message}\nTry /pair <code> <another_handle>` };
      }
      // Start the watermark at the current head: pairing should not replay the
      // entire history to the phone.
      chat = upsertChat(platform, chatId, {
        agent_name: name,
        paired_at: new Date().toISOString(),
        last_notified_id: hub.head(),
      });
      return {
        reply: `Paired. You are "${name}" in the room, as a human — agents cannot answer questions addressed to you, and you can overrule them when they deadlock.\n\n${HELP}`,
      };
    }

    const as = chat.agent_name;
    const idea = currentSlug(chat);
    const on = idea ? `on "${idea}"` : 'in the lobby';

    const ok = (s) => ({ reply: s, chat });
    const err = (e) => ({ reply: `✖ ${e.message ?? e}`, chat });

    try {
      switch (cmd) {
        case '':
          return ok('Say something, or /help.');

        case 'help':
        case 'start':
          return ok(HELP);

        case 'me': {
          const name = handleFrom(rest);
          if (!rest.trim()) return ok(`You are "${as}". Change it with /me <handle>.`);
          hub.join({ name, role: 'human', kind: 'human', model: 'telegram' });
          upsertChat(platform, chatId, { agent_name: name });
          return ok(`You are now "${name}".`);
        }

        case 'stop':
        case 'unpair':
          db.prepare('DELETE FROM bridge_chats WHERE platform = ? AND chat_id = ?').run(platform, String(chatId));
          return ok('Unpaired. Send /pair <code> to link again.');

        case 'notify': {
          const want = restParts[0]?.toLowerCase();
          if (want !== 'on' && want !== 'off') return ok(`Notifications are ${chat.notify ? 'on' : 'off'}. Use /notify on|off.`);
          upsertChat(platform, chatId, { notify: want === 'on' ? 1 : 0 });
          return ok(`Notifications ${want}.`);
        }

        // ---- ideas --------------------------------------------------------
        case 'idea':
        case 'new': {
          if (!rest) return ok('Give it a title: /idea <title>\nPut the detail on the following lines.');
          // First line is the title, the rest is the dump. "|" works too, for
          // one-line typing on a phone.
          const nl = rest.indexOf('\n');
          let title = nl === -1 ? rest : rest.slice(0, nl).trim();
          let body = nl === -1 ? '' : rest.slice(nl + 1).trim();
          if (nl === -1 && title.includes('|')) {
            const bar = title.indexOf('|');
            body = title.slice(bar + 1).trim();
            title = title.slice(0, bar).trim();
          }
          const i = hub.dropIdea({ title, raw: body, by: as });
          upsertChat(platform, chatId, { current_idea: i.id });
          return ok(
            `Dropped "${i.title}" as ${i.slug}. This chat is now on it.\n\n` +
              `Your agents will pick it up, propose approaches and score each other's. ` +
              `I'll message you when they need a decision — /props to look sooner.`,
          );
        }

        case 'ideas':
        case 'list': {
          const list = hub.listIdeas({ limit: 25 });
          if (!list.length) return ok('No ideas yet. /idea <title> to drop one.');
          return ok(
            list
              .map((i) => `${i.slug === idea ? '▸ ' : '  '}${i.slug} [${i.stage}] ${i.title}` +
                (i.openQuestions ? ` · ${i.openQuestions}q` : '') +
                (i.openProposals ? ` · ${i.openProposals} proposals` : '') +
                (i.openTasks ? ` · ${i.openTasks} open` : ''))
              .join('\n') + '\n\n/use <slug> to switch.',
          );
        }

        case 'use':
        case 'u': {
          if (!rest) return ok(`This chat is ${on}. /use <slug>, or /use lobby.`);
          if (/^lobby$/i.test(rest)) {
            upsertChat(platform, chatId, { current_idea: null });
            return ok('Switched to the lobby.');
          }
          const i = hub.getIdea(rest.trim());
          upsertChat(platform, chatId, { current_idea: i.id });
          return ok(`Now on "${i.title}" (${i.slug}, ${i.stage}).`);
        }

        case 'brief': {
          const target = rest.trim() || idea;
          if (!target) return ok('Which idea? /brief <slug>, or /use <slug> first.');
          return ok(hub.brief({ idea: target, messages: 12, by: as }).digest);
        }

        case 'status':
        case 'overview': {
          const o = hub.overview();
          const L = [
            Object.entries(o.byStage).map(([k, v]) => `${v} ${k}`).join(' · ') || 'No ideas yet.',
            `${o.totals.openProposals} open proposals · ${o.totals.openQuestions} open questions · ${o.totals.openTasks} open tasks`,
          ];
          if (o.needsAttention.length) {
            L.push('', 'Needs attention:');
            for (const a of o.needsAttention) L.push(`• ${a.idea} (${a.stage}): ${a.reasons.join('; ')}`);
          } else L.push('', 'Nothing is stuck.');
          return ok(L.join('\n'));
        }

        case 'who': {
          const r = hub.roster();
          if (!r.length) return ok('Nobody has joined yet.');
          return ok(
            r.map((a) => `• ${a.name} — ${a.role} (${a.status})` +
              (a.workingOn.length ? ` on #${a.workingOn[0].id} ${a.workingOn[0].title}` : '')).join('\n'),
          );
        }

        // ---- the human's actual job ---------------------------------------
        case 'q':
        case 'questions': {
          const qs = hub.questions({ idea: rest.trim() || undefined, open: true })
            .filter((q) => q.audience === 'human');
          if (!qs.length) return ok('Nothing is waiting on you.');
          return ok(
            qs.map((q) => `Q${q.id}${q.blocking ? ' (blocking)' : ''}${q.idea ? ` [${q.idea}]` : ''}\n${q.body}\n— ${q.askedBy}`).join('\n\n') +
              '\n\nAnswer with: /a <id> <your answer>',
          );
        }

        case 'a':
        case 'answer': {
          const id = Number(restParts[0]);
          const body = rest.slice(String(restParts[0] ?? '').length).trim();
          if (!Number.isInteger(id) || !body) return ok('Use: /a <question id> <your answer>');
          hub.answer({ id, answer: body, by: as });
          return ok(`Answered Q${id}. The agents can move on.`);
        }

        case 'props':
        case 'proposals': {
          const target = rest.trim() || idea;
          if (!target) return ok('Which idea? /props <slug>, or /use <slug> first.');
          const s = hub.standing({ idea: target });
          if (!s.contests.length) return ok(`Nothing proposed on ${s.idea} yet.`);
          const L = [];
          for (const c of s.contests) {
            L.push(`— ${c.topic} —`, c.verdict, '');
            for (const p of c.ranked) {
              L.push(`P${p.id} ${p.title} (${p.author})`);
              L.push(`   support ${p.support} · feasibility ${p.feasibility ?? '—'} · ${p.voters} scored${p.choosable ? '' : ' · HELD'}`);
              for (const o of p.blockingObjections) L.push(`   ✖ ${o.agent}: ${o.reasoning}`);
            }
            if (c.chosen) L.push(`✓ chosen: P${c.chosen.id} ${c.chosen.title}`);
            L.push('');
          }
          L.push('/choose <id> to settle it.');
          return ok(L.join('\n'));
        }

        case 'choose': {
          const id = Number(restParts[0]);
          if (!Number.isInteger(id)) return ok('Use: /choose <proposal id> [why]');
          const why = rest.slice(String(restParts[0]).length).trim();
          const r = hub.choose({ proposal: id, rationale: why || 'chosen by the human', by: as });
          return ok(`Chose P${r.proposal.id} "${r.proposal.title}". Recorded as decision #${r.decision.id}; the other routes are closed.`);
        }

        case 'decide': {
          if (!rest) return ok('Use: /decide <what you decided>');
          const d = hub.decide({ idea: idea ?? null, choice: rest, rationale: 'decided by the human', by: as });
          return ok(`Recorded decision #${d.id}. No agent will re-open it without new information.`);
        }

        case 'remember': {
          const m = rest.match(/^([^=]+)=(.*)$/s);
          if (!m) return ok('Use: /remember key=value');
          const f = hub.remember({ idea: idea ?? null, key: m[1].trim(), value: m[2].trim(), source: 'telegram', by: as });
          return ok(`Remembered ${f.key} (${f.scope}).`);
        }

        case 'tasks':
        case 'board': {
          const target = rest.trim() || idea;
          const list = hub.tasks({ idea: target ?? undefined });
          if (!list.length) return ok('The board is empty.');
          return ok(
            list.map((t) => `${t.status === 'done' ? '✓' : t.runnable ? '○' : '·'} #${t.id} [${t.role}] ${t.title} — ${t.status}${t.owner ? ` (${t.owner})` : ''}`).join('\n'),
          );
        }

        case 'search': {
          if (!rest) return ok('Use: /search <text>');
          const hits = hub.search({ query: rest, limit: 12 });
          if (!hits.length) return ok('Nothing found.');
          return ok(hits.map((m) => `${m.author}${m.idea ? ` [${m.idea}]` : ''}: ${m.body.replace(/\n+/g, ' ').slice(0, 220)}`).join('\n\n'));
        }

        // ---- bare text is the common case --------------------------------
        default: {
          if (raw.startsWith('/')) return ok(`Unknown command "${cmd}".\n\n${HELP}`);
          const m = hub.post({ idea, body: raw, by: as, kind: 'message' });
          return ok(`Posted ${on}${m.mentions.length ? ` — pinged ${m.mentions.join(', ')}` : ''}.`);
        }
      }
    } catch (e) {
      return err(e);
    }
  }

  /**
   * What to push out, per paired chat: only messages actually addressed to
   * that person. Advancing the watermark is the caller's job, after a send
   * succeeds, so a failed delivery is retried rather than lost.
   */
  function pending() {
    const chats = db.prepare('SELECT * FROM bridge_chats WHERE notify = 1 AND agent_name IS NOT NULL AND paired_at IS NOT NULL').all();
    const out = [];
    for (const chat of chats) {
      let n;
      try {
        n = hub.notifications({ name: chat.agent_name, since: chat.last_notified_id });
      } catch {
        continue; // identity was removed from the room; nothing to push
      }
      if (!n.messages.length) {
        if (n.head > chat.last_notified_id) markDelivered(chat, n.head);
        continue;
      }
      const body = n.messages
        .map((m) => {
          const where = m.idea ? ` [${m.idea}]` : '';
          const tag = m.kind === 'message' ? '' : ` (${m.kind})`;
          return `${m.author}${tag}${where}:\n${m.body}`;
        })
        .join('\n\n———\n\n');
      out.push({
        platform: chat.platform,
        chatId: chat.chat_id,
        text: body,
        upTo: n.messages[n.messages.length - 1].id,
        chat,
      });
    }
    return out;
  }

  /**
   * The payload the human actually wants: "your agents have converged, here are
   * the viable routes, pick one". Pushed once per contest, and again only if the
   * options themselves change — so it is a result, not a running commentary.
   */
  function optionsReady() {
    const chats = db
      .prepare('SELECT * FROM bridge_chats WHERE notify = 1 AND agent_name IS NOT NULL AND paired_at IS NOT NULL')
      .all();
    if (!chats.length) return [];

    const out = [];
    for (const i of hub.listIdeas({ limit: 100 })) {
      if (['done', 'parked'].includes(i.stage)) continue;
      for (const c of hub.standing({ idea: i.id }).contests) {
        // Only once the room has actually converged: something on the table,
        // nothing chosen yet, and every agent has had its say.
        if (c.chosen || !c.ranked.length || c.awaitingScores.length) continue;

        const signature = JSON.stringify(c.ranked.map((p) => [p.id, p.support, p.feasibility, p.choosable]));
        const body = [
          `Your agents have ${c.ranked.length} viable option${c.ranked.length === 1 ? '' : 's'} on "${i.title}"`,
          `(${c.topic})`,
          '',
          ...c.ranked.flatMap((p) => [
            `${p.choosable ? '' : '⚠ '}P${p.id} — ${p.title}`,
            `   proposed by ${p.author} · ${p.voters} agents scored it`,
            `   feasibility ${p.feasibility ?? '—'}/5 · support ${p.support}`,
            ...p.blockingObjections.map((o) => `   unresolved: ${o.agent} says ${o.reasoning}`),
            '',
          ]),
          `/props ${i.slug}   see the full reasoning`,
          `/choose <id>      pick one and they start building`,
        ].join('\n');

        for (const chat of chats) {
          const key = `opts:${chat.platform}:${chat.chat_id}:${i.id}:${c.topic}`;
          const seen = db.prepare('SELECT v FROM bridge_state WHERE k = ?').get(key)?.v;
          if (seen === signature) continue;
          out.push({ platform: chat.platform, chatId: chat.chat_id, text: body, stateKey: key, signature });
        }
      }
    }
    return out;
  }

  /** Called after a successful send, so a failed delivery is retried next tick. */
  function markOptionsSent(stateKey, signature) {
    db.prepare('INSERT INTO bridge_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(stateKey, signature);
  }

  function markDelivered(chat, upTo) {
    db.prepare(
      `UPDATE bridge_chats SET last_notified_id = MAX(last_notified_id, ?)
       WHERE platform = ? AND chat_id = ?`,
    ).run(upTo, chat.platform, chat.chat_id);
  }

  return { handle, pending, optionsReady, markOptionsSent, markDelivered, getChat, HELP };
}
