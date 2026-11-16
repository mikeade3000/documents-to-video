import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, voiceList } from './src/config.js';
import { ACCEPTED_EXT } from './src/extract.js';
import { THEMES, resolveTheme } from './src/themes.js';
import { LENGTHS, STYLES } from './src/storyboard.js';
import { iconsFor } from './src/icons.js';
import { createJob, getJob, publicJob, jobDir, cleanup } from './src/jobs.js';
import { paymentInfo, paymentsEnabled, startPayment, verifyPayment, handleWebhook, PayError } from './src/payments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'jobs'), { recursive: true });

export const app = express();
app.set('trust proxy', 1);

app.use(express.static(path.join(here, 'public')));
app.use('/player', express.static(path.join(here, 'player')));
app.use('/fonts/inter', express.static(path.join(here, 'node_modules/@fontsource-variable/inter/files'), { maxAge: '30d' }));
app.use('/fonts/jakarta', express.static(path.join(here, 'node_modules/@fontsource-variable/plus-jakarta-sans/files'), { maxAge: '30d' }));

app.get('/api/config', (req, res) => {
  res.json({
    needsCode: !!config.accessCode,
    voiceProvider: config.ttsProvider,
    voices: voiceList(),
    themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, bg: t.vars.bg1, accent: t.vars.accent })),
    lengths: Object.entries(LENGTHS).map(([id, l]) => ({ id, label: l.label })),
    styles: Object.keys(STYLES),
    accept: ACCEPTED_EXT,
    maxFileMb: config.maxFileMb,
    maxFiles: config.maxFiles,
    payments: paymentInfo(),
  });
});

// --- Creating a video -------------------------------------------------------

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.maxFileMb * 1024 * 1024, files: config.maxFiles + 1 },
});

const recent = new Map(); // ip -> timestamps of recent jobs
function rateLimited(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= config.jobsPerHour) { recent.set(ip, list); return true; }
  list.push(now);
  recent.set(ip, list);
  return false;
}

const discard = (req) => Object.values(req.files || {}).flat().forEach((f) => fs.rm(f.path, { force: true }, () => {}));

app.post('/api/jobs', upload.fields([{ name: 'files', maxCount: config.maxFiles }, { name: 'logo', maxCount: 1 }]), async (req, res, next) => {
  try {
    const fail = (status, error) => { discard(req); res.status(status).json({ error }); };
    if (config.accessCode && req.get('x-access-code') !== config.accessCode) return fail(401, 'The access code is not correct.');
    const files = req.files?.files || [];
    const logo = req.files?.logo?.[0] || null;
    const b = req.body || {};
    const prompt = String(b.prompt || '').slice(0, 6000);
    if (!files.length && prompt.trim().length < 10) return fail(400, 'Upload a document or describe the video you want (a sentence or two).');
    const bad = files.find((f) => !ACCEPTED_EXT.includes(path.extname(f.originalname).toLowerCase()));
    if (bad) return fail(400, `"${bad.originalname}" is not a supported file type.`);
    if (logo && !/\.(png|jpe?g|webp|svg)$/i.test(logo.originalname)) return fail(400, 'The logo must be a PNG, JPG, WebP or SVG image.');
    if (rateLimited(req.ip)) return fail(429, 'You have made several videos in the last hour. Please try again a little later.');
    const options = {
      theme: b.theme === 'auto' || THEMES[b.theme] ? b.theme : 'auto',
      length: LENGTHS[b.length] ? b.length : 'standard',
      style: STYLES[b.style] ? b.style : 'explainer',
      voice: String(b.voice || '').slice(0, 64),
      resolution: b.resolution === '720' ? '720' : '1080',
      captions: b.captions !== 'off',
      brand: String(b.brand || '').slice(0, 48).trim(),
      primaryColor: /^#[0-9a-f]{6}$/i.test(b.primaryColor || '') ? b.primaryColor : '',
      accentColor: /^#[0-9a-f]{6}$/i.test(b.accentColor || '') ? b.accentColor : '',
    };
    const job = await createJob({ files, logo, prompt }, options);
    res.status(202).json(publicJob(job));
  } catch (err) { discard(req); next(err); }
});

// --- Following and collecting a video ---------------------------------------

async function withJob(req, res, next) {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That video was not found. Finished videos are kept for a limited time.' });
  req.job = job;
  next();
}

app.get('/api/jobs/:id', withJob, (req, res) => res.json(publicJob(req.job)));

app.get('/api/jobs/:id/player.json', withJob, async (req, res, next) => {
  try {
    const dir = jobDir(req.job.id);
    const storyboard = JSON.parse(await fsp.readFile(path.join(dir, 'storyboard.json'), 'utf8'));
    const player = JSON.parse(await fsp.readFile(path.join(dir, 'player.json'), 'utf8'));
    res.json({ storyboard, ...player, theme: resolveTheme(storyboard.theme, req.job.options), icons: iconsFor(storyboard) });
  } catch (err) { err.code === 'ENOENT' ? res.status(409).json({ error: 'The preview is not ready yet.' }) : next(err); }
});

const sendJobFile = (name, type) => (req, res) => {
  const file = path.join(jobDir(req.job.id), name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not ready yet.' });
  if (req.query.dl) {
    const base = (req.job.title || 'video').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'video';
    res.attachment(`${base}${path.extname(name)}`);
  }
  res.type(type).sendFile(file);
};
// With payments on, the MP4 is only served once the video has been paid for (the live preview stays free).
const paidOnly = (req, res, next) => (paymentsEnabled() && !req.job.paid ? res.status(402).json({ error: 'Pay to download this video.' }) : next());
app.get('/api/jobs/:id/video.mp4', withJob, paidOnly, sendJobFile('video.mp4', 'video/mp4'));
app.get('/api/jobs/:id/narration.m4a', withJob, sendJobFile('narration.m4a', 'audio/mp4'));
app.get('/api/jobs/:id/storyboard.json', withJob, sendJobFile('storyboard.json', 'application/json'));
app.get('/api/jobs/:id/assets/:file', withJob, (req, res) => {
  const file = path.basename(req.params.file); // never leave the job's assets folder
  res.sendFile(path.join(jobDir(req.job.id), 'assets', file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

// --- Payments (Flutterwave) --------------------------------------------------

const json = express.json({ limit: '100kb' });
const pay = (fn) => async (req, res, next) => {
  try { res.json(await fn(req.body || {})); } catch (err) { err instanceof PayError ? res.status(err.status).json({ error: err.message }) : next(err); }
};
app.post('/api/pay/start', json, pay((b) => startPayment(b)));
app.post('/api/pay/verify', json, pay((b) => verifyPayment(b.tx_ref)));
app.post('/api/pay/webhook', json, async (req, res) => res.sendStatus(await handleWebhook(req.get('verif-hash'), req.body)));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be under ${config.maxFileMb} MB.` : `Too many files (the limit is ${config.maxFiles}).`;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'The server ran into a problem. Please try again.' });
});

export function start(port = config.port) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      config.port = server.address().port; // the renderer loads the player from this port
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await start();
  console.log(`Doc-to-Video Studio running on http://localhost:${server.address().port}`);
  console.log(`  storyboard: ${config.claudeModel}${process.env.ANTHROPIC_API_KEY ? '' : '  (ANTHROPIC_API_KEY is not set)'}`);
  console.log(`  payments:   ${paymentsEnabled() ? `on (${config.currency} ${config.priceDownload} per download)` : 'off - downloads are free'}`);
  console.log(`  voice-over: ${config.ttsProvider === 'none' ? 'none configured - videos will be silent with captions' : config.ttsProvider}`);
  cleanup();
  setInterval(cleanup, 3600_000).unref();
}
