import { unzip } from './documents.js';

/**
 * Skills: the instructions you have already written, uploaded once.
 *
 * The difference between a skill and a plugin is worth being clear about,
 * because the catalogue lists both. A plugin does something — it calls an
 * endpoint and returns what came back. A skill tells a model *how* to do
 * something, in your words: the review checklist you use, the way you want a
 * commit message written, the house style for a proposal. A model reads it and
 * works that way.
 *
 * So the body is stored and handed over verbatim. Summarising somebody's
 * standards back at them defeats the point of having written them down.
 *
 * The format is the one skills already come in: a folder with a SKILL.md at its
 * root, front matter naming it, and whatever supporting files it needs. A single
 * .md file is a skill too, which is what most of them are.
 */

const MAX_BODY = 200_000;
const MAX_FILE_TEXT = 100_000;

/** Front matter, which is where a skill states its own name and description. */
export function parseFrontMatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: src.trim() };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    // A flow list, which is how `roles: [reviewer, critic]` is usually written.
    if (/^\[.*\]$/.test(value)) {
      data[kv[1]] = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
      continue;
    }
    data[kv[1]] = value;
  }
  return { data, body: src.slice(m[0].length).trim() };
}

/** A name a model can say and a URL can carry. */
export function slugify(raw) {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.(md|markdown|txt)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return name || 'skill';
}

/** The first heading, or the first sentence — a skill without front matter still needs a title. */
function inferTitle(body, fallback) {
  const heading = body.match(/^#{1,3}\s+(.+)$/m)?.[1];
  return (heading ?? fallback).trim().slice(0, 120);
}

function inferDescription(body) {
  const withoutHeadings = body.replace(/^#{1,6}\s+.*$/gm, '').replace(/^\s*[-*]\s+/gm, '');
  const sentence = withoutHeadings.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 20);
  return (sentence ?? '').replace(/\s+/g, ' ').slice(0, 300);
}

const TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|csv|tsv|xml|html?|js|mjs|ts|py|rb|go|rs|sh|sql|toml|ini|env|css|svg)$/i;

export function createSkills(db, { store = null } = {}) {
  /** Save one markdown file as a skill, front matter and all. */
  const fromMarkdown = ({ filename, text, source }) => {
    const { data, body } = parseFrontMatter(text);
    if (!body.trim()) throw new Error(`${filename} has front matter but no instructions under it`);
    const roles = Array.isArray(data.roles) ? data.roles
      : typeof data.roles === 'string' && data.roles ? data.roles.split(/[,\s]+/).filter(Boolean)
      : [];
    return api.save({
      name: data.name || filename,
      // A stated title wins; otherwise the document's own heading reads better
      // than the handle, which is a slug and looks like one.
      title: data.title || '',
      description: data.description || '',
      body,
      source,
      roles,
    });
  };

  /** Keep the files a skill folder brought with it. */
  const attachFiles = (skill, contents, manifestName) => {
    db.prepare('DELETE FROM skill_files WHERE skill = ?').run(skill);
    for (const [path, data] of contents) {
      if (path === manifestName) continue;
      const readable = TEXT_FILE.test(path);
      let text = '';
      if (readable) {
        const decoded = data.toString('utf8');
        if (!/\uFFFD/.test(decoded.slice(0, 2000))) text = decoded.slice(0, MAX_FILE_TEXT);
      }
      // A binary file is kept on disk so the skill can still point at it.
      const url = !text && store ? store(path, data) : '';
      db.prepare('INSERT OR REPLACE INTO skill_files (skill, path, text, url, bytes) VALUES (?, ?, ?, ?, ?)')
        .run(skill, path, text, url, data.length);
    }
  };

  const view = (r, files = undefined) => ({
    name: r.name,
    title: r.title,
    description: r.description,
    body: r.body,
    source: r.source,
    roles: (() => { try { return JSON.parse(r.roles); } catch { return []; } })(),
    enabled: Boolean(r.enabled),
    used: r.used,
    lastUsed: r.last_used ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(files ? { files } : {}),
  });

  const filesOf = (name) =>
    db.prepare('SELECT path, url, bytes, length(text) AS chars FROM skill_files WHERE skill = ? ORDER BY path')
      .all(name)
      .map((f) => ({ path: f.path, url: f.url || undefined, bytes: f.bytes, readable: f.chars > 0 }));

  const api = {
    all({ includeBody = false } = {}) {
      return db.prepare('SELECT * FROM skills ORDER BY name').all().map((r) => {
        const out = view(r, filesOf(r.name));
        if (!includeBody) delete out.body;
        return out;
      });
    },

    enabled() {
      return db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY name').all().map((r) => view(r));
    },

    /** What an agent is told exists: enough to choose one, not the whole text. */
    menu({ role = undefined } = {}) {
      return this.enabled()
        .filter((s) => !s.roles.length || !role || s.roles.includes(role))
        .map((s) => ({ name: s.name, title: s.title, description: s.description }));
    },

    get(name) {
      const r = db.prepare('SELECT * FROM skills WHERE name = ?').get(String(name));
      return r ? view(r, filesOf(r.name)) : null;
    },

    /** Read one for use, verbatim, and record that it was used. */
    use(name, { by = 'unknown' } = {}) {
      const s = this.get(name);
      if (!s) throw new Error(`no skill named "${name}"`);
      if (!s.enabled) throw new Error(`the skill "${name}" is switched off`);
      db.prepare('UPDATE skills SET used = used + 1, last_used = ? WHERE name = ?').run(new Date().toISOString(), s.name);

      const attached = db.prepare('SELECT path, text FROM skill_files WHERE skill = ? AND text != \'\' ORDER BY path').all(s.name);
      return {
        ...s,
        by,
        // The supporting files come with it. A checklist that the instructions
        // refer to is no use if the model cannot see it.
        attached: attached.map((f) => ({ path: f.path, text: f.text })),
      };
    },

    save({ name, title, description, body, source = '', roles = [], enabled = true, rename }) {
      const handle = slugify(name);
      const text = String(body ?? '').trim();
      if (!text) throw new Error('a skill needs a body — the instructions themselves');
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO skills (name, title, description, body, source, roles, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           title = excluded.title, description = excluded.description, body = excluded.body,
           source = excluded.source, roles = excluded.roles, enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(handle, String(title ?? '').slice(0, 120) || inferTitle(text, handle),
            String(description ?? '').slice(0, 300) || inferDescription(text),
            text.slice(0, MAX_BODY), String(source), JSON.stringify(Array.isArray(roles) ? roles : []),
            enabled ? 1 : 0, now, now);

      if (rename && slugify(rename) !== handle) {
        db.prepare('UPDATE skills SET name = ? WHERE name = ?').run(slugify(rename), handle);
        return this.get(slugify(rename));
      }
      return this.get(handle);
    },

    remove(name) {
      return db.prepare('DELETE FROM skills WHERE name = ?').run(String(name)).changes > 0;
    },

    setEnabled(name, on) {
      const s = this.get(name);
      if (!s) throw new Error(`no skill named "${name}"`);
      db.prepare('UPDATE skills SET enabled = ?, updated_at = ? WHERE name = ?')
        .run(on ? 1 : 0, new Date().toISOString(), s.name);
      return this.get(s.name);
    },

    /**
     * Take an uploaded file and make skills of it.
     *
     * Three shapes, because three shapes is what people have: a single markdown
     * file, a zipped skill folder with a SKILL.md at its root, and a zip holding
     * several of those. A zip of loose markdown files is treated as one skill
     * each, which is the only reading that does not throw somebody's work away.
     */
    upload({ filename, bytes }) {
      const buf = Buffer.from(bytes);
      const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
      if (!isZip) {
        const text = buf.toString('utf8');
        if (/�/.test(text.slice(0, 2000))) throw new Error(`${filename} is not text — a skill is markdown, or a zip of it`);
        return [fromMarkdown({ filename, text, source: filename })];
      }

      const files = unzip(buf);
      const saved = [];

      // Group by folder. A folder containing a SKILL.md is one skill and its
      // files; anything else is judged on its own.
      const folders = new Map();
      for (const [path, data] of files) {
        if (path.endsWith('/')) continue;
        if (/(^|\/)(__MACOSX|\.DS_Store|\.git)(\/|$)/i.test(path)) continue;
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (!folders.has(dir)) folders.set(dir, new Map());
        folders.get(dir).set(path.slice(dir ? dir.length + 1 : 0), data);
      }

      for (const [dir, contents] of folders) {
        const manifestName = [...contents.keys()].find((n) => /^skill\.(md|markdown)$/i.test(n));
        if (manifestName) {
          const skill = fromMarkdown({
            filename: dir ? dir.split('/').pop() : manifestName,
            text: contents.get(manifestName).toString('utf8'),
            source: `${filename}:${dir ? `${dir}/` : ''}${manifestName}`,
          });
          attachFiles(skill.name, contents, manifestName);
          saved.push(this.get(skill.name));
          continue;
        }
        // No manifest: every markdown file here is its own skill.
        for (const [name, data] of contents) {
          if (!/\.(md|markdown)$/i.test(name)) continue;
          saved.push(fromMarkdown({
            filename: name,
            text: data.toString('utf8'),
            source: `${filename}:${dir ? `${dir}/` : ''}${name}`,
          }));
        }
      }

      if (!saved.length) throw new Error(`no skill found in ${filename} — expected a SKILL.md, or markdown files`);
      return saved;
    },

  };

  return api;
}
