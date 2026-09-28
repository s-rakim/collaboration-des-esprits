import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { readDocument, readDocx, readXlsx, readPptx, readPdf, unzip } from '../src/documents.js';

// ---------------------------------------------------------------- zip building

/** A zip, written the way the Office tools write one, so the reader is tested
 *  against the real container and not a convenient simplification. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(0, 14);          // crc, which no reader here checks
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const body = Buffer.concat(locals);
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dirBuf, end]);
}

test('a zip is read through its central directory', () => {
  const files = unzip(zip({ 'a/b.txt': 'first', 'c.txt': 'second' }));
  assert.equal(files.get('a/b.txt').toString(), 'first');
  assert.equal(files.get('c.txt').toString(), 'second');
});

// ----------------------------------------------------------------------- docx

const docx = (body) => zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml':
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
});

test('Word: paragraphs become lines and runs are joined', () => {
  const out = readDocx(docx(
    '<w:p><w:r><w:t>Quarterly Review</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Revenue rose </w:t></w:r><w:r><w:t>18%</w:t></w:r></w:p>',
  ));
  assert.equal(out, 'Quarterly Review\nRevenue rose 18%');
});

test('Word: tabs and breaks survive, because they are content', () => {
  const out = readDocx(docx(
    '<w:p><w:r><w:t>Col A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Col B</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>One</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Two</w:t></w:r></w:p>',
  ));
  assert.equal(out, 'Col A\tCol B\nOne\nTwo');
});

test('Word: entities are decoded and field codes left out', () => {
  const out = readDocx(docx(
    '<w:p><w:r><w:instrText>PAGEREF _Toc1</w:instrText></w:r><w:r><w:t>Caf&#233; &amp; cr&#232;me</w:t></w:r></w:p>',
  ));
  assert.equal(out, 'Café & crème');
});

// ----------------------------------------------------------------------- xlsx

const xlsx = () => zip({
  'xl/sharedStrings.xml':
    '<sst><si><t>Region</t></si><si><t>Units</t></si><si><t>North</t></si><si><t>South</t></si></sst>',
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="Sales" r:id="rId1"/><sheet name="Notes" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1420</v></c></row>' +
    '<row><c r="A3" t="s"><v>3</v></c><c r="C3"><v>96.5</v></c></row>' +
    '<row><c r="A4" t="inlineStr"><is><t>inline</t></is></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
});

test('Excel: every sheet is named and shared strings resolved', () => {
  const out = readXlsx(xlsx());
  assert.match(out, /^## Sales\n/);
  assert.match(out, /## Notes\n7/);
  assert.match(out, /Region\tUnits/);
});

test('Excel: a gap keeps its column, so a number stays under its heading', () => {
  const out = readXlsx(xlsx());
  // South has nothing in B and 96.5 in C: two tabs, not one.
  assert.match(out, /South\t\t96\.5/);
});

// ----------------------------------------------------------------------- pptx

test('PowerPoint: one block per slide, in slide order', () => {
  const slide = (...lines) =>
    `<p:sld xmlns:a="a">${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:sld>`;
  const out = readPptx(zip({
    'ppt/slides/slide2.xml': slide('Second', 'bullet'),
    'ppt/slides/slide1.xml': slide('First', 'subtitle'),
  }));
  assert.equal(out.indexOf('First') < out.indexOf('Second'), true, 'slides must come out in order');
  assert.match(out, /## Slide 1\nFirst\nsubtitle/);
});

// ------------------------------------------------------------------------ pdf

/** A minimal but structurally real PDF. */
function pdf(objects) {
  let out = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const stream = (dict, data) => {
  const packed = deflateSync(Buffer.from(data, 'latin1'));
  return `<< /Filter /FlateDecode ${dict} /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream`;
};

test('PDF: text comes out with its lines, and TJ kerning becomes spaces', () => {
  const content =
    'BT /F1 12 Tf 72 720 Td (Hello from a PDF.) Tj 0 -16 Td (Second line.) Tj ' +
    '0 -16 Td [(Kerned) -300 (words)] TJ ET';
  const out = readPdf(pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]));
  assert.equal(out, 'Hello from a PDF.\nSecond line.\nKerned words');
});

test('PDF: escapes and octal codes are resolved', () => {
  const content = String.raw`BT /F1 12 Tf 72 700 Td (Parens \( and \) plus caf\351.) Tj ET`;
  const out = readPdf(pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]));
  assert.equal(out, 'Parens ( and ) plus café.');
});

test('PDF: a subset font is read through its ToUnicode map', () => {
  // Two-byte codes, as an Identity-H font uses — the common real case, and the
  // one that reads as gibberish if the map is ignored.
  const cmap = [
    '/CIDInit /ProcSet findresource begin begincmap /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfrange',
    '<0024> <0027> [<0057> <006F> <0072> <006B>]',
    '<0030> <0032> <0031>',
    'endbfrange endcmap end',
  ].join('\n');
  const out = readPdf(pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 5 0 R >> >> /Contents 4 0 R >>',
    stream('', 'BT /F2 11 Tf 40 700 Td <0024002500260027> Tj 0 -14 Td <003000310032> Tj ET'),
    '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>',
    stream('', cmap),
  ]));
  assert.equal(out, 'Work\n123');
});

test('PDF: a scanned page says it has no text rather than inventing some', () => {
  const out = readPdf(pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream('', 'q 612 0 0 792 0 0 cm /Im1 Do Q'),
    stream('/Type /XObject /Subtype /Image /Width 8 /Height 8', '\u0001\u0002\u0003\u0004'),
  ]));
  assert.equal(out, '');
});

// ------------------------------------------------------------------- the door

test('a format we do not read is reported as such, not as empty', () => {
  // null means "not one of ours"; '' means "ours, and there was nothing in it".
  assert.equal(readDocument(Buffer.from('anything'), 'photo.heic'), null);
  assert.equal(readDocument(Buffer.from('not a zip at all'), 'broken.docx'), '');
});

test('a corrupt file of a format we do read is empty, not a crash', () => {
  assert.equal(readDocument(Buffer.from('%PDF-1.7 truncated'), 'half.pdf'), '');
  assert.equal(readDocument(zip({ 'word/document.xml': '<w:document>' }), 'odd.docx'), '');
});

test('readDocument dispatches on the extension', () => {
  assert.match(readDocument(docx('<w:p><w:r><w:t>hello</w:t></w:r></w:p>'), 'a.docx'), /hello/);
  assert.match(readDocument(xlsx(), 'b.xlsx'), /## Sales/);
});
