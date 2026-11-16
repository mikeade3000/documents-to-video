import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { extractUploads, UserError } from './extract.js';
import { writeStoryboard, normalizeStoryboard } from './storyboard.js';
import { narrate } from './tts.js';
import { buildTimeline } from './timeline.js';
import { audioDuration, mixNarration, renderVideo } from './render.js';
import { storeEnabled, putFile, putJson, getFile, getJson } from './store.js';

const jobs = new Map();
const queue = [];
let running = 0;

export const jobDir = (id) => path.join(config.dataDir, 'jobs', id);
const isId = (id) => /^[0-9a-f-]{36}$/.test(id);

async function save(job) {
  const { files, ...rest } = job; // uploaded temp-file handles are not persisted
  await fs.writeFile(path.join(jobDir(job.id), 'job.json'), JSON.stringify(rest));
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  save(job).catch(() => {});
}

export async function getJob(id) {
  if (!isId(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  try {
    const job = JSON.parse(await fs.readFile(path.join(jobDir(id), 'job.json'), 'utf8'));
    // A job that was mid-flight when the server restarted can never finish.
    if (!['done', 'error'].includes(job.status)) Object.assign(job, { status: 'error', error: 'The server restarted while this video was being made. Please start it again.' });
    jobs.set(id, job);
    return job;
  } catch { return restoreJob(id); }
}

// --- Durable copies (only when STORAGE_URL is set) -----------------------------

const JOB_FILES = ['video.mp4', 'storyboard.json', 'player.json', 'narration.m4a'];

/** Copies a finished job to the object store so it survives the server's disk being wiped. */
async function persistJob(job) {
  if (!storeEnabled()) return;
  try {
    const dir = jobDir(job.id);
    for (const name of JOB_FILES) await putFile(`jobs/${job.id}/${name}`, path.join(dir, name)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    for (const name of await fs.readdir(path.join(dir, 'assets')).catch(() => [])) await putFile(`jobs/${job.id}/assets/${name}`, path.join(dir, 'assets', name));
    await persistJobRecord(job); // written last: its presence means the copy is complete
  } catch (err) { console.error(`[job ${job.id}] could not copy to storage:`, err.message); }
}

async function persistJobRecord(job) {
  if (!storeEnabled()) return;
  const { files, logo, presetStoryboard, ...rest } = job;
  await putJson(`jobs/${job.id}/job.json`, rest);
}

/** Brings a finished job back from the object store after the local disk was wiped. */
const restoring = new Map();
function restoreJob(id) {
  if (!storeEnabled()) return null;
  if (!restoring.has(id)) {
    restoring.set(id, (async () => {
      try {
        const job = await getJson(`jobs/${id}/job.json`);
        if (!job || job.status !== 'done') return null;
        const dir = jobDir(id);
        await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
        for (const name of JOB_FILES) await getFile(`jobs/${id}/${name}`, path.join(dir, name));
        const player = JSON.parse(await fs.readFile(path.join(dir, 'player.json'), 'utf8'));
        for (const name of [...Object.values(player.assets || {}), player.logo].filter(Boolean)) await getFile(`jobs/${id}/assets/${name}`, path.join(dir, 'assets', name));
        await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
        jobs.set(id, job);
        return job;
      } catch (err) { console.error(`[job ${id}] could not restore from storage:`, err.message); return null; }
      finally { restoring.delete(id); }
    })());
  }
  return restoring.get(id);
}

/** What the browser is allowed to see about a job. */
export function publicJob(job) {
  const pos = queue.indexOf(job.id);
  return {
    id: job.id, status: job.status, progress: job.progress ?? 0, error: job.error || null,
    title: job.title || null, duration: job.duration || null, scenes: job.sceneCount || null,
    previewReady: !!job.previewReady, silent: !!job.silent, paid: !!job.paid, queuePosition: pos >= 0 ? pos + 1 : 0,
  };
}

/**
 * Creates a job. `source` is either { files, logo, prompt } from the web form
 * or { storyboard } for a ready-made storyboard (used by the sample script).
 */
export async function createJob(source, options) {
  const id = crypto.randomUUID();
  await fs.mkdir(path.join(jobDir(id), 'assets'), { recursive: true });
  const job = { id, status: 'queued', progress: 0, createdAt: Date.now(), options, prompt: source.prompt || '', files: source.files || [], logo: source.logo || null, presetStoryboard: source.storyboard || null };
  jobs.set(id, job);
  await save(job);
  queue.push(id);
  pump();
  return job;
}

function pump() {
  while (running < config.concurrentJobs && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    running++;
    runJob(job)
      .catch((err) => {
        console.error(`[job ${job.id}]`, err);
        update(job, { status: 'error', error: err instanceof UserError ? err.message : `Something went wrong while making the video. (${String(err.message || err).slice(0, 240)})` });
      })
      .finally(() => { running--; pump(); });
  }
}

async function runJob(job) {
  const dir = jobDir(job.id);
  const assetsDir = path.join(dir, 'assets');
  const { options } = job;

  // 1. Read the uploads
  update(job, { status: 'reading', progress: 0 });
  let images = [];
  let storyboard;
  if (job.presetStoryboard) {
    storyboard = normalizeStoryboard(job.presetStoryboard, { options });
  } else {
    const extracted = await extractUploads(job.files);
    images = extracted.images;
    for (const img of images) await fs.rename(img.path, path.join(assetsDir, img.file));
    if (!extracted.documents.length && !extracted.pdfs.length && !images.length && !job.prompt.trim()) throw new UserError('Upload a document or describe the video you want.');

    // 2. Write the storyboard and script
    update(job, { status: 'writing' });
    // STORYBOARD_FIXTURE (development only) replays a saved storyboard instead of calling Claude.
    storyboard = process.env.STORYBOARD_FIXTURE
      ? normalizeStoryboard(JSON.parse(await fs.readFile(process.env.STORYBOARD_FIXTURE, 'utf8')), { images, options })
      : await writeStoryboard({ ...extracted, prompt: job.prompt.trim(), options });
  }
  let logo = null;
  if (job.logo) {
    logo = `logo${path.extname(job.logo.originalname).toLowerCase() || '.png'}`;
    await fs.rename(job.logo.path, path.join(assetsDir, logo));
  }
  for (const f of job.files) await fs.rm(f.path, { force: true });
  job.files = [];
  await fs.writeFile(path.join(dir, 'storyboard.json'), JSON.stringify(storyboard, null, 2));
  update(job, { title: storyboard.title, sceneCount: storyboard.scenes.length });

  // 3. Voice-over
  update(job, { status: 'voicing', progress: 0 });
  const audioFiles = await narrate(storyboard, { dir, voice: options.voice, style: options.style, onProgress: (p) => update(job, { progress: p }) });
  const speech = audioFiles ? await Promise.all(audioFiles.map((f) => (f ? audioDuration(f) : null))) : null;
  const timeline = buildTimeline(storyboard, speech, config.fps);
  const audioFile = audioFiles ? await mixNarration(audioFiles, timeline, path.join(dir, 'narration.m4a')) : null;
  await fs.writeFile(path.join(dir, 'player.json'), JSON.stringify({
    timeline,
    assets: Object.fromEntries(images.map((i) => [i.id, i.file])),
    logo,
    hasAudio: !!audioFile,
    captions: options.captions !== false,
  }));
  update(job, { duration: timeline.duration, previewReady: true, silent: !audioFile });

  // 4. Render
  update(job, { status: 'rendering', progress: 0 });
  await renderVideo({
    url: `http://127.0.0.1:${config.port}/player/?job=${job.id}&render=1`,
    timeline, audioFile, workDir: dir, outFile: path.join(dir, 'video.mp4'),
    height: options.resolution === '720' ? 720 : 1080,
    onProgress: (p) => update(job, { progress: p }),
  });
  update(job, { status: 'done', progress: 1 });
  await persistJob(job);
}

/** Records that a video has been paid for, which unlocks its download. */
export async function markPaid(id, txRef) {
  const job = await getJob(id);
  if (job && !job.paid) {
    update(job, { paid: true, paidRef: txRef, paidAt: Date.now() });
    await persistJobRecord(job).catch((err) => console.error(`[job ${id}] could not record payment in storage:`, err.message));
  }
}

/** Deletes jobs older than KEEP_HOURS (paid videos: PAID_KEEP_DAYS) so the disk does not fill up. */
export async function cleanup() {
  const root = path.join(config.dataDir, 'jobs');
  for (const id of await fs.readdir(root).catch(() => [])) {
    const stat = await fs.stat(path.join(root, id)).catch(() => null);
    const live = jobs.get(id);
    const job = live || (await getJob(id));
    const keepMs = job?.paid ? config.paidKeepDays * 86400_000 : config.keepHours * 3600_000;
    if (stat && stat.mtimeMs < Date.now() - keepMs && (!live || ['done', 'error'].includes(live.status))) {
      await fs.rm(path.join(root, id), { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}
