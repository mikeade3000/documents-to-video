import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { config } from './config.js';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.rtf']);
export const ACCEPTED_EXT = ['.pdf', '.docx', '.pptx', ...TEXT_EXT, ...Object.keys(IMAGE_TYPES)];

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.files[name].async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('')).filter((t) => t.trim());
    out.push(`--- Slide ${i + 1} ---\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

/**
 * Reads uploaded files into what the storyboard writer needs:
 *  - documents: [{ name, text }]            plain-text content
 *  - pdfs:      [{ name, base64 }]          scanned PDFs with no text layer (sent to Claude natively)
 *  - images:    [{ id, name, file, mediaType, base64? }]  usable inside scenes
 */
export async function extractUploads(files) {
  const documents = [];
  const pdfs = [];
  const images = [];
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    const buffer = await fs.readFile(f.path);
    if (IMAGE_TYPES[ext]) {
      images.push({
        id: `img${images.length + 1}`,
        name: f.originalname,
        file: path.basename(f.path) + ext,
        path: f.path,
        mediaType: IMAGE_TYPES[ext],
        // Claude accepts images up to 5 MB; larger ones are still usable in scenes by name.
        base64: buffer.length <= 4.5 * 1024 * 1024 ? buffer.toString('base64') : null,
      });
    } else if (ext === '.pdf') {
      let text = '';
      try { text = (await pdfParse(buffer)).text || ''; } catch { /* fall through to native PDF */ }
      if (text.replace(/\s+/g, '').length >= 200) documents.push({ name: f.originalname, text });
      else pdfs.push({ name: f.originalname, base64: buffer.toString('base64') });
    } else if (ext === '.docx') {
      documents.push({ name: f.originalname, text: (await mammoth.extractRawText({ buffer })).value });
    } else if (ext === '.pptx') {
      documents.push({ name: f.originalname, text: await pptxText(buffer) });
    } else if (TEXT_EXT.has(ext)) {
      let text = buffer.toString('utf8');
      if (ext === '.html' || ext === '.htm') text = decodeXml(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
      documents.push({ name: f.originalname, text });
    } else {
      throw new UserError(`"${f.originalname}" is not a supported file type. Use PDF, Word (.docx), PowerPoint (.pptx), text, or images.`);
    }
  }
  for (const d of documents) d.text = d.text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  const total = documents.reduce((n, d) => n + d.text.length, 0);
  if (total > config.maxDocChars) {
    throw new UserError(`The uploaded documents contain about ${Math.round(total / 1000)}k characters, above the ${Math.round(config.maxDocChars / 1000)}k limit. Upload a shorter document or only the relevant section.`);
  }
  return { documents, pdfs, images };
}

/** An error whose message is safe and useful to show to the end user. */
export class UserError extends Error {}
