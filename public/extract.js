/*
 * Pulls the text out of a study file in the player's own browser, so only
 * plain text ever goes to the server. PDF (pdf.js, in public/pdfjs/), Word
 * (.docx), PowerPoint (.pptx) and plain text. Photos and scans aren't read.
 *
 * extractText(file) → { text, truncated } or throws an Error whose message is
 * safe to show the player.
 */

export const MAX_CHARS = 200000;      // what we keep from one file
const MAX_FILE = 30 * 1024 * 1024;    // bytes
const MAX_ENTRY = 40 * 1024 * 1024;   // one unzipped part of a docx/pptx
const MAX_PAGES = 400;

// ---- zip (docx and pptx are zip files of XML) ----
const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

function zipEntries(buf) {
  const v = new DataView(buf);
  let end = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (u32(v, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("That file doesn't look like a Word or PowerPoint file.");
  const count = u16(v, end + 10);
  let p = u32(v, end + 16);
  const out = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || u32(v, p) !== 0x02014b50) break;
    const nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), cmtLen = u16(v, p + 32);
    out.push({
      name: dec.decode(new Uint8Array(buf, p + 46, nameLen)),
      method: u16(v, p + 10),
      size: u32(v, p + 24),
      at: u32(v, p + 42),
      comp: u32(v, p + 20),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

async function zipRead(buf, entry) {
  const v = new DataView(buf);
  if (entry.size > MAX_ENTRY) throw new Error('That file is too big to read.');
  if (u32(v, entry.at) !== 0x04034b50) throw new Error("That file looks damaged.");
  const start = entry.at + 30 + u16(v, entry.at + 26) + u16(v, entry.at + 28);
  const raw = new Uint8Array(buf, start, entry.comp);
  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) throw new Error("That file uses a zip format we can't read.");
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY) { reader.cancel(); throw new Error('That file is too big to read.'); }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

// every paragraph in an Office XML part, as lines of its text runs
function xmlParagraphs(xml, para, run) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const lines = [];
  for (const p of doc.getElementsByTagNameNS('*', para)) {
    let line = '';
    for (const n of p.getElementsByTagName('*')) {
      const name = n.localName;
      if (name === run) line += n.textContent;
      else if (name === 'tab') line += ' ';
      else if (name === 'br') line += '\n';
    }
    line = line.trim();
    if (line) lines.push(line);
  }
  return lines;
}

async function fromDocx(buf) {
  const e = zipEntries(buf).find(x => x.name === 'word/document.xml');
  if (!e) throw new Error("That doesn't look like a Word (.docx) file.");
  return xmlParagraphs(await zipRead(buf, e), 'p', 't').join('\n');
}

async function fromPptx(buf) {
  const slides = zipEntries(buf)
    .map(x => ({ x, n: /^ppt\/slides\/slide(\d+)\.xml$/.exec(x.name) }))
    .filter(s => s.n)
    .sort((a, b) => Number(a.n[1]) - Number(b.n[1]));
  if (!slides.length) throw new Error("That doesn't look like a PowerPoint (.pptx) file.");
  const out = [];
  for (const s of slides) {
    const lines = xmlParagraphs(await zipRead(buf, s.x), 'p', 't');
    if (lines.length) out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

let pdfjs = null;
async function fromPdf(buf) {
  if (!pdfjs) {
    pdfjs = await import('./pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  let doc;
  const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
  try { doc = await task.promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('That PDF is password protected.');
    throw new Error("We couldn't open that PDF.");
  }
  const pages = [];
  let chars = 0;
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && chars < MAX_CHARS; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    let page = '';
    for (const it of tc.items) page += it.str + (it.hasEOL ? '\n' : '');
    pages.push(page);
    chars += page.length;
  }
  task.destroy();
  return pages.join('\n\n');
}

function tidy(s) {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractText(file) {
  if (file.size > MAX_FILE) throw new Error('That file is over 30 MB.');
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [])[1];
  const kind = (ext || '').toLowerCase();
  let raw;
  if (kind === 'txt' || kind === 'md') raw = await file.text();
  else if (kind === 'docx') raw = await fromDocx(await file.arrayBuffer());
  else if (kind === 'pptx') raw = await fromPptx(await file.arrayBuffer());
  else if (kind === 'pdf') raw = await fromPdf(await file.arrayBuffer());
  else if (kind === 'doc' || kind === 'ppt') throw new Error('Save it as .docx or .pptx first, then add it.');
  else throw new Error('Use a PDF, Word (.docx), PowerPoint (.pptx) or text file.');
  const text = tidy(raw);
  if (text.length < 20) throw new Error(kind === 'pdf'
    ? 'That PDF has no text we can read. It may be scanned pictures. Paste the text in instead.'
    : "We couldn't find any text in that file.");
  return { text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}
