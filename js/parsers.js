// Document parsers: turn PPTX, DOCX and PDF files into a list of "slides".
//
// Every slide has the same shape so the rest of the app does not care where it came from:
// {
//   title:    string,             // heading shown on the slide
//   bullets:  string[],           // short points shown on the slide
//   text:     string,             // full readable text of the slide/page/section
//   notes:    string,             // speaker notes (PPTX only)
//   image:    ImageBitmap | null, // picture to show on the slide, if any
//   pdfPage:  number | null,      // page number, for drawing the original PDF page
// }

import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
// Cross-origin module workers are not allowed, so start the worker from a same-origin blob.
pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
  URL.createObjectURL(new Blob([`import "${PDF_WORKER}";`], { type: 'text/javascript' })),
  { type: 'module' },
);

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

export async function parseDocument(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  let doc;
  if (ext === 'pptx') doc = await parsePptx(buf);
  else if (ext === 'docx') doc = await parseDocx(buf);
  else if (ext === 'pdf') doc = await parsePdf(buf);
  else throw new Error(`Unsupported file type ".${ext}". Use .pptx, .docx or .pdf (older .ppt/.doc files must be re-saved in the new format first).`);
  doc.kind = ext;
  doc.fileName = file.name;
  // Ignore placeholder metadata titles that many tools write.
  doc.title = (doc.title || '').replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\.(docx?|pptx?)$/i, '').trim();
  if (/^(untitled|powerpoint presentation|presentation\d*|document\d*|slide \d+|page \d+)$/i.test(doc.title)) doc.title = '';
  if (!doc.title && doc.kind !== 'pdf') doc.title = doc.slides.find((s) => s.title)?.title || '';
  if (!doc.title) doc.title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  doc.slides = doc.slides.filter((s) => s.title || s.text || s.notes || s.image || s.pdfPage);
  if (!doc.slides.length) throw new Error('No readable content was found in this file.');
  return doc;
}

// ---------- shared helpers ----------

const xml = (str) => new DOMParser().parseFromString(str, 'application/xml');
const byTag = (el, tag) => Array.from(el.getElementsByTagNameNS('*', tag));
const clean = (s) => s.replace(/\s+/g, ' ').trim();

function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

async function readRels(zip, partPath) {
  const dir = partPath.substring(0, partPath.lastIndexOf('/'));
  const name = partPath.substring(partPath.lastIndexOf('/') + 1);
  const relFile = zip.file(`${dir}/_rels/${name}.rels`);
  const rels = {};
  if (!relFile) return rels;
  for (const r of byTag(xml(await relFile.async('string')), 'Relationship')) {
    rels[r.getAttribute('Id')] = {
      type: r.getAttribute('Type') || '',
      path: r.getAttribute('TargetMode') === 'External' ? null : resolvePath(dir, r.getAttribute('Target')),
    };
  }
  return rels;
}

async function loadZipImage(zip, path) {
  if (!path) return null;
  const ext = path.split('.').pop().toLowerCase();
  if (!IMAGE_TYPES[ext]) return null; // EMF/WMF/SVG etc. cannot be decoded reliably in the browser
  const f = zip.file(path);
  if (!f) return null;
  try {
    const blob = new Blob([await f.async('arraybuffer')], { type: IMAGE_TYPES[ext] });
    const bmp = await createImageBitmap(blob);
    if (bmp.width < 40 || bmp.height < 40) return null; // skip icons and bullets
    return bmp;
  } catch {
    return null;
  }
}

function paragraphsOf(el) {
  return byTag(el, 'p')
    .map((p) => clean(byTag(p, 't').map((t) => t.textContent).join('')))
    .filter(Boolean);
}

export function firstSentence(text, max = 120) {
  const m = text.match(/^.*?[.!?](\s|$)/);
  let s = (m ? m[0] : text).trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return s;
}

// ---------- PPTX ----------

async function parsePptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const presPath = 'ppt/presentation.xml';
  const presRels = await readRels(zip, presPath);
  const pres = xml(await zip.file(presPath).async('string'));
  const slidePaths = byTag(pres, 'sldId')
    .map((s) => presRels[s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')])
    .filter(Boolean)
    .map((r) => r.path);

  let docTitle = '';
  const core = zip.file('docProps/core.xml');
  if (core) docTitle = clean(byTag(xml(await core.async('string')), 'title')[0]?.textContent || '');

  const slides = [];
  for (const path of slidePaths) {
    const f = zip.file(path);
    if (!f) continue;
    const sx = xml(await f.async('string'));
    const rels = await readRels(zip, path);
    let title = '';
    const body = [];
    for (const sp of byTag(sx, 'sp')) {
      const ph = byTag(sp, 'ph')[0];
      const type = ph?.getAttribute('type') || '';
      const paras = paragraphsOf(sp);
      if (!paras.length) continue;
      if ((type === 'title' || type === 'ctrTitle') && !title) title = paras.join(' ');
      else if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
      else body.push(...paras);
    }
    // Tables and other graphic frames
    for (const gf of byTag(sx, 'graphicFrame')) {
      for (const row of byTag(gf, 'tr')) {
        const cells = byTag(row, 'tc').map((c) => paragraphsOf(c).join(' ')).filter(Boolean);
        if (cells.length) body.push(cells.join(' — '));
      }
    }
    // Largest picture on the slide
    let image = null;
    let best = 0;
    for (const pic of byTag(sx, 'pic')) {
      const blip = byTag(pic, 'blip')[0];
      const id = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
      const ext = byTag(pic, 'ext').find((e) => e.getAttribute('cx'));
      const area = ext ? Number(ext.getAttribute('cx')) * Number(ext.getAttribute('cy')) : 1;
      if (id && rels[id] && area > best) {
        const bmp = await loadZipImage(zip, rels[id].path);
        if (bmp) { image = bmp; best = area; }
      }
    }
    // Speaker notes
    let notes = '';
    const notesRel = Object.values(rels).find((r) => r.type.endsWith('/notesSlide'));
    if (notesRel && zip.file(notesRel.path)) {
      const nx = xml(await zip.file(notesRel.path).async('string'));
      const parts = [];
      for (const sp of byTag(nx, 'sp')) {
        const type = byTag(sp, 'ph')[0]?.getAttribute('type');
        if (type === 'body') parts.push(...paragraphsOf(sp));
      }
      notes = parts.join(' ');
    }
    if (!title && body.length) title = body.shift();
    slides.push({ title, bullets: body.slice(0, 8), text: body.join('. '), notes, image, pdfPage: null });
  }
  if (!docTitle && slides[0]) docTitle = slides[0].title;
  return { title: docTitle, slides };
}

// ---------- DOCX ----------

async function parseDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const docPath = 'word/document.xml';
  const dx = xml(await zip.file(docPath).async('string'));
  const rels = await readRels(zip, docPath);

  // Map style ids to style names, so localized "Heading 1" styles are still detected.
  const styleNames = {};
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) {
    for (const st of byTag(xml(await stylesFile.async('string')), 'style')) {
      const id = st.getAttribute('w:styleId');
      const name = byTag(st, 'name')[0]?.getAttribute('w:val');
      if (id) styleNames[id] = name || id;
    }
  }
  const headingLevel = (p) => {
    const ps = byTag(p, 'pStyle')[0]?.getAttribute('w:val') || '';
    const name = (styleNames[ps] || ps).toLowerCase();
    if (/^title$/.test(name)) return 0;
    const m = name.match(/heading\s*(\d)/);
    if (m) return Number(m[1]);
    const ol = byTag(p, 'outlineLvl')[0]?.getAttribute('w:val');
    return ol != null ? Number(ol) + 1 : -1;
  };

  const body = byTag(dx, 'body')[0];
  const blocks = []; // {kind: 'heading'|'para', level, text, imageId}
  for (const el of Array.from(body.children)) {
    if (el.localName === 'p') {
      const text = clean(byTag(el, 't').map((t) => t.textContent).join(''));
      const blip = byTag(el, 'blip')[0];
      const imageId = blip && (blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'));
      const level = headingLevel(el);
      if (text && level >= 0 && level <= 3 && text.length < 160) blocks.push({ kind: 'heading', level, text });
      else if (text || imageId) blocks.push({ kind: 'para', text, imageId });
    } else if (el.localName === 'tbl') {
      for (const row of byTag(el, 'tr')) {
        const cells = byTag(row, 'tc').map((c) => clean(byTag(c, 't').map((t) => t.textContent).join(' '))).filter(Boolean);
        if (cells.length) blocks.push({ kind: 'para', text: cells.join(' — ') });
      }
    }
  }

  let docTitle = '';
  const core = zip.file('docProps/core.xml');
  if (core) docTitle = clean(byTag(xml(await core.async('string')), 'title')[0]?.textContent || '');
  const titleBlock = blocks.find((b) => b.kind === 'heading' && b.level === 0);
  if (!docTitle && titleBlock) docTitle = titleBlock.text;

  // Group into sections by heading.
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.kind === 'heading') {
      if (b.level === 0 && b.text === docTitle && !cur) continue;
      cur = { title: b.text, paras: [], imageIds: [] };
      sections.push(cur);
    } else {
      if (!cur) { cur = { title: '', paras: [], imageIds: [] }; sections.push(cur); }
      if (b.text) cur.paras.push(b.text);
      if (b.imageId) cur.imageIds.push(b.imageId);
    }
  }

  // Long sections are split so each slide holds roughly 120 words of narration.
  const MAX_WORDS = 120;
  const slides = [];
  for (const sec of sections) {
    let image = null;
    for (const id of sec.imageIds) {
      image = await loadZipImage(zip, rels[id]?.path);
      if (image) break;
    }
    const chunks = [];
    let chunk = [];
    let words = 0;
    for (const p of sec.paras) {
      const w = p.split(/\s+/).length;
      if (chunk.length && words + w > MAX_WORDS) { chunks.push(chunk); chunk = []; words = 0; }
      chunk.push(p);
      words += w;
    }
    if (chunk.length || !chunks.length) chunks.push(chunk);
    chunks.forEach((paras, i) => {
      const title = sec.title
        ? (i === 0 ? sec.title : `${sec.title} (continued)`)
        : (paras[0] ? firstSentence(paras[0], 70) : docTitle);
      slides.push({
        title,
        bullets: [...new Set(paras.map((p) => firstSentence(p)))].slice(0, 6),
        text: paras.join(' '),
        notes: '',
        image: i === 0 ? image : null,
        pdfPage: null,
      });
    });
  }
  return { title: docTitle, slides };
}

// ---------- PDF ----------

async function parsePdf(buf) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  let docTitle = '';
  try {
    const meta = await pdf.getMetadata();
    docTitle = clean(meta?.info?.Title || '');
  } catch { /* no metadata */ }

  const slides = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    // Rebuild lines from positioned text items.
    const lines = [];
    let line = null;
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      const size = Math.abs(it.transform[3]) || it.height || 0;
      if (!line || Math.abs(line.y - y) > Math.max(2, size * 0.4)) {
        line = { y, size, text: '' };
        lines.push(line);
      }
      line.text += it.str + (it.hasEOL ? ' ' : '');
      line.size = Math.max(line.size, size);
    }
    const textLines = lines.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text && !/^\d{1,4}$/.test(l.text));
    // Title = the first line among the biggest font on the page.
    let title = '';
    if (textLines.length) {
      const maxSize = Math.max(...textLines.map((l) => l.size));
      const titleLines = textLines.filter((l) => l.size >= maxSize * 0.92).slice(0, 2);
      title = titleLines.map((l) => l.text).join(' ');
      if (title.length > 120) title = firstSentence(title, 90);
    }
    // Join lines into paragraphs and fix words hyphenated across line breaks.
    const full = textLines.map((l) => l.text).join('\n')
      .replace(/(\w)-\n(\w)/g, '$1$2')
      .replace(/\n/g, ' ');
    let bodyText = clean(full);
    if (title && bodyText.startsWith(title)) bodyText = bodyText.slice(title.length).trim();
    const bullets = textLines
      .filter((l) => l.text !== title)
      .map((l) => l.text.replace(/^[•\-–·▪●○◦*]\s*/, ''))
      .filter((t) => t.length > 2);
    slides.push({
      title: title || `Page ${n}`,
      bullets: [...new Set(bullets.map((b) => firstSentence(b)))].slice(0, 6),
      text: bodyText,
      notes: '',
      image: null,
      pdfPage: n,
    });
  }
  if (!docTitle && slides[0]) docTitle = slides[0].title;
  return { title: docTitle, slides, pdf };
}

// Render one PDF page into an ImageBitmap that fits inside w x h.
export async function renderPdfPage(pdf, pageNum, w, h) {
  const page = await pdf.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(w / vp1.width, h / vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return createImageBitmap(canvas);
}
