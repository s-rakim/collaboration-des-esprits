import { inflateRawSync, inflateSync, unzipSync } from 'node:zlib';

/**
 * Reading the documents people actually send each other.
 *
 * A room whose agents can only read .txt is a room you cannot hand a contract,
 * a spreadsheet of numbers or a paper to. The formats below are the ones that
 * turn up, and every one of them is readable without a dependency: the Office
 * formats are zipped XML, and a PDF is a container of deflated streams. So this
 * is a parser rather than a wrapper, which means no native build step and
 * nothing to keep up to date.
 *
 * What it will not do is guess. A scanned PDF has no text in it, and saying so
 * is worth more than handing an agent a page of mojibake to reason over.
 */

const MAX_TEXT = 400_000; // past this, no brief is going to be improved by more

// --------------------------------------------------------------------- zip

/**
 * The central directory, read backwards from the end-of-central-directory
 * record. Reading the directory rather than scanning for local headers is what
 * makes this correct for files written in streaming mode, where the local
 * header's sizes are zero and the truth is in the directory.
 */
export function unzip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    // The local header repeats the name and extra field, at its own lengths.
    if (buf.readUInt32LE(offset) !== 0x04034b50) continue;
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(start, start + compressed);
    try {
      files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      // One unreadable entry must not cost the rest of the document.
    }
  }
  return files;
}

function findEOCD(buf) {
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// --------------------------------------------------------------------- xml

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescapeXml = (s) => String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(Number(e[1] === 'x' || e[1] === 'X' ? `0${e.slice(1)}` : e.slice(1)));
  return ENTITIES[e] ?? m;
});

/** Every occurrence of one element's text content, in document order. */
function textOf(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`, 'g');
  for (const m of xml.matchAll(re)) out.push(unescapeXml(m[1] ?? ''));
  return out;
}

const attr = (frag, name) => frag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

// -------------------------------------------------------------------- docx

/**
 * Word. Paragraphs become lines, tabs and breaks survive, and a table reads as
 * tab-separated rows — which is how a model gets the shape of it rather than
 * one long run of words.
 */
export function readDocx(buf) {
  const files = unzip(buf);
  const parts = ['word/document.xml', ...[...files.keys()].filter((n) => /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(n))];
  const lines = [];

  for (const part of parts) {
    const xml = files.get(part)?.toString('utf8');
    if (!xml) continue;
    const body = xml
      .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')   // field codes, not prose
      // Tabs and breaks are content, but they are empty elements, so they are
      // marked before the tags go and read back in position afterwards.
      .replace(/<w:tab\b[^>]*\/?>/g, '\u0001')
      .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\u0002');

    for (const para of body.split(/<\/w:p>/)) {
      if (!/<w:t[\s>]/.test(para)) continue;
      let line = '';
      for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|[\u0001\u0002]/g)) {
        if (m[1] !== undefined) line += unescapeXml(m[1]);
        else line += m[0] === '\u0001' ? '\t' : '\n';
      }
      lines.push(line.replace(/[ \t]+$/, ''));
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// -------------------------------------------------------------------- xlsx

const COL = (ref) => {
  const letters = String(ref).match(/^[A-Z]+/)?.[0] ?? 'A';
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
};

/**
 * Excel. Every sheet becomes tab-separated rows under its own heading, with
 * empty cells kept in place — a number in the wrong column is worse than no
 * number, and a model reading this has only the alignment to go on.
 */
export function readXlsx(buf) {
  const files = unzip(buf);

  // Shared strings: the cell holds an index into this table, not the text.
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared = sharedXml
    ? sharedXml.split(/<si>/).slice(1).map((si) => textOf(si, 't').join(''))
    : [];

  // Sheet order and names live in the workbook; the file each one is in is in
  // the rels. Falling back to the numbered sheets keeps odd writers working.
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = attr(m[1], 'Id');
    const path = attr(m[1], 'Target');
    if (id && path) target.set(id, `xl/${String(path).replace(/^\/?(xl\/)?/, '')}`);
  }

  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/>/g)].map((m, i) => ({
    name: unescapeXml(attr(m[1], 'name') ?? `Sheet${i + 1}`),
    path: target.get(attr(m[1], 'r:id') ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
  if (!sheets.length) {
    for (const name of [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
      sheets.push({ name: name.split('/').pop().replace('.xml', ''), path: name });
    }
  }

  const out = [];
  for (const sheet of sheets) {
    const xml = files.get(sheet.path)?.toString('utf8');
    if (!xml) continue;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rowMatch[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = cm[1];
        const inner = cm[2] ?? '';
        const type = attr(head, 't');
        const at = COL(attr(head, 'r') ?? '');
        let value;
        if (type === 's') value = shared[Number(textOf(inner, 'v')[0] ?? -1)] ?? '';
        else if (type === 'inlineStr') value = textOf(inner, 't').join('');
        else if (type === 'str') value = textOf(inner, 'v').join('');
        else value = textOf(inner, 'v')[0] ?? '';
        while (cells.length < at) cells.push('');
        cells[at] = String(value).replace(/[\t\n]+/g, ' ');
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(`## ${sheet.name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n').trim();
}

// -------------------------------------------------------------------- pptx

/** PowerPoint: one block per slide, in slide order. */
export function readPptx(buf) {
  const files = unzip(buf);
  const slides = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  return slides.map((name, i) => {
    const xml = files.get(name).toString('utf8');
    const lines = xml.split(/<\/a:p>/).map((p) => textOf(p, 'a:t').join('')).filter((t) => t.trim());
    return `## Slide ${i + 1}\n${lines.join('\n')}`;
  }).filter((s) => s.includes('\n')).join('\n\n').trim();
}

// --------------------------------------------------------------------- pdf

/** Inflate a stream, trying both wrappers, since producers differ. */
function inflate(bytes) {
  try { return inflateSync(bytes); } catch {}
  try { return inflateRawSync(bytes); } catch {}
  try { return unzipSync(bytes); } catch {}
  return null;
}

/** A PDF string literal, with its escapes and octal codes resolved. */
function pdfString(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out.push(c); continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out.push(String.fromCharCode(parseInt(oct, 8)));
    } else if (next === 'n') out.push('\n');
    else if (next === 'r') out.push('\r');
    else if (next === 't') out.push('\t');
    else if (next === 'b') out.push('\b');
    else if (next === 'f') out.push('\f');
    else if (next === '\n') { /* a line continuation is not a character */ }
    else out.push(next);
  }
  return out.join('');
}

/**
 * ToUnicode CMaps, which are how a PDF says what its bytes actually mean.
 *
 * Without this, a document using a subset font reads as gibberish — the byte
 * for "A" may be 3. With it, most PDFs that carry text come out as the text
 * they show.
 */
function readCMap(src) {
  const map = new Map();
  const hex = (h) => parseInt(h, 16);
  const toChars = (h) => {
    const s = [];
    for (let i = 0; i + 3 < h.length + 1; i += 4) s.push(String.fromCharCode(hex(h.slice(i, i + 4))));
    return s.join('');
  };

  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(hex(m[1]), toChars(m[2]));
    }
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // <lo> <hi> <start>  — a run of codes mapped to consecutive characters.
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const [lo, hi, start] = [hex(m[1]), hex(m[2]), hex(m[3])];
      for (let c = lo; c <= hi && c - lo < 65_536; c++) map.set(c, String.fromCharCode(start + (c - lo)));
    }
    // <lo> <hi> [ <a> <b> … ] — a run mapped to a list.
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = hex(m[1]);
      const list = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => toChars(x[1]));
      list.forEach((ch, i) => map.set(lo + i, ch));
    }
  }

  /**
   * How many bytes a code is. The codespace range says so; where it does not,
   * the width of the keys does. Getting this wrong is the difference between
   * the document's words and a page of control characters, because a two-byte
   * reader fed one-byte codes finds nothing in the map at all.
   */
  const range = src.match(/begincodespacerange([\s\S]*?)endcodespacerange/)?.[1];
  const first = range?.match(/<([0-9A-Fa-f]+)>/)?.[1];
  const keyed = src.match(/beginbf(?:char|range)[\s\S]*?<([0-9A-Fa-f]+)>/)?.[1];
  const width = Math.max(1, Math.round((first?.length ?? keyed?.length ?? 4) / 2));

  return { map, width };
}

/**
 * Text out of a PDF.
 *
 * Every object is found by scanning rather than by trusting the cross-reference
 * table, because a PDF that has been appended to, or written by something
 * careless, has an xref that does not match the file — and the objects are all
 * still there to be read.
 */
export function readPdf(buf) {
  const latin = buf.toString('latin1');

  // Streams, inflated, indexed by object number.
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
  for (const m of latin.matchAll(re)) {
    const num = Number(m[1]);
    const body = m[3];
    const at = body.indexOf('stream');
    if (at < 0) { objects.set(num, { dict: body, data: null }); continue; }
    // The data begins after the EOL that follows the keyword.
    let start = at + 'stream'.length;
    if (body[start] === '\r') start++;
    if (body[start] === '\n') start++;
    const end = body.lastIndexOf('endstream');
    if (end < 0) { objects.set(num, { dict: body.slice(0, at), data: null }); continue; }
    const dict = body.slice(0, at);
    const raw = Buffer.from(body.slice(start, end), 'latin1');
    const data = /FlateDecode/.test(dict) ? inflate(raw) : raw;
    objects.set(num, { dict, data });
  }

  // Fonts, so a byte can be turned back into a character.
  const cmaps = new Map(); // font name (as used by Tf) → Map(code → text)
  for (const [, obj] of objects) {
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    const resources = obj.dict.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? '';
    for (const f of resources.matchAll(/\/([A-Za-z0-9#+.-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const font = objects.get(Number(f[2]));
      const ref = font?.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)?.[1];
      const cmap = ref && objects.get(Number(ref))?.data;
      if (cmap) cmaps.set(f[1], readCMap(cmap.toString('latin1')));
    }
  }

  const pieces = [];
  for (const [, obj] of objects) {
    if (!obj.data) continue;
    const content = obj.data.toString('latin1');
    if (!/\bTj\b|\bTJ\b|\bTD\b|\bTd\b/.test(content)) continue;

    let font = null;
    // One pass over the text-showing operators, in order, so the layout of the
    // page survives as line breaks rather than becoming one paragraph.
    const ops = /\/([A-Za-z0-9#+.-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)|<([0-9A-Fa-f\s]+)>|\[((?:[^\][]|\\.)*)\]\s*TJ|(T\*|Td|TD|'|")/g;
    let line = [];
    for (const m of content.matchAll(ops)) {
      if (m[1] !== undefined) { font = m[1]; continue; }
      const cmap = cmaps.get(font);
      // A code the map does not cover falls back to the byte itself, but only
      // when that is a character somebody could have typed — a stray control
      // byte in the middle of a sentence is noise, not a recovered letter.
      const fallback = (code) => (code >= 32 && code !== 127 ? String.fromCharCode(code) : '');
      const codes = (bytes, width) => {
        const out = [];
        for (let i = 0; i + width <= bytes.length; i += width) {
          let code = 0;
          for (let b = 0; b < width; b++) code = (code << 8) | bytes[i + b];
          out.push(code);
        }
        return out;
      };
      const decodeBytes = (bytes) => {
        if (!cmap) return Buffer.from(bytes).toString('latin1');
        return codes(bytes, cmap.width).map((c) => cmap.map.get(c) ?? fallback(c)).join('');
      };
      const decodeHex = (h) => {
        const clean = h.replace(/\s+/g, '').replace(/[^0-9A-Fa-f]/g, '');
        const padded = clean.length % 2 ? `${clean}0` : clean; // a lone nibble means a trailing zero
        const bytes = Buffer.from(padded, 'hex');
        return decodeBytes(bytes);
      };
      const decode = (s) => decodeBytes(Buffer.from(s, 'latin1'));

      if (m[0][0] === '(') line.push(decode(pdfString(m[0].slice(1, -1))));
      else if (m[2] !== undefined) line.push(decodeHex(m[2]));
      else if (m[3] !== undefined) {
        // A TJ array: strings with kerning numbers between them. A big enough
        // negative kern is a word space, which is how a PDF writes one.
        for (const part of m[3].matchAll(/\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>|(-?[\d.]+)/g)) {
          if (part[0][0] === '(') line.push(decode(pdfString(part[0].slice(1, -1))));
          else if (part[1] !== undefined) line.push(decodeHex(part[1]));
          else if (Number(part[2]) < -120) line.push(' ');
        }
      } else if (m[4] !== undefined) {
        // A move to a new line.
        if (line.join('').trim()) pieces.push(line.join(''));
        line = [];
      }
    }
    if (line.join('').trim()) pieces.push(line.join(''));
  }

  const text = pieces.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // A scanned page inflates to drawing operators and no text. Saying so beats
  // handing back whatever punctuation happened to survive.
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\s]/gu, '');
  if (!text || printable.length < text.length * 0.7 || !/\p{L}{3}/u.test(printable)) return '';
  return text;
}

// ------------------------------------------------------------------ the door

const BY_EXT = {
  docx: readDocx, docm: readDocx,
  xlsx: readXlsx, xlsm: readXlsx,
  pptx: readPptx, pptm: readPptx,
  pdf: readPdf,
};

export const READABLE = Object.keys(BY_EXT);

/**
 * Pull the text out of a document, if it is one of the formats we can read.
 *
 * Returns null when the format is not one of these, so the caller can tell
 * "there is nothing in it" apart from "I do not read this", and say the right
 * thing to the room.
 */
export function readDocument(buf, filename = '') {
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const reader = BY_EXT[ext];
  if (!reader) return null;
  try {
    const text = reader(Buffer.from(buf));
    return text ? text.slice(0, MAX_TEXT) : '';
  } catch {
    // A corrupt or password-protected file is not a crash; it is a file with no
    // readable text, and the link to it is still worth having.
    return '';
  }
}
