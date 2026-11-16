// Renders samples/sample-storyboard.json to an MP4 without calling the Claude API.
// Useful to check that Chromium and ffmpeg work on a new server:  npm run sample
import fs from 'node:fs/promises';
import path from 'node:path';
import { start } from '../server.js';
import { createJob, getJob, jobDir } from '../src/jobs.js';

const file = process.argv[2] || 'samples/sample-storyboard.json';
const storyboard = JSON.parse(await fs.readFile(file, 'utf8'));
const server = await start(0);
const began = Date.now();
const job = await createJob({ storyboard }, { theme: 'auto', resolution: process.env.RES || '1080', captions: true, style: 'explainer', voice: process.env.VOICE || '' });
let last = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 1000));
  const j = await getJob(job.id);
  const line = `${j.status} ${Math.round((j.progress || 0) * 100)}%`;
  if (line !== last) { console.log(line); last = line; }
  if (j.status === 'done') {
    const out = path.resolve('sample-output.mp4');
    await fs.copyFile(path.join(jobDir(job.id), 'video.mp4'), out);
    console.log(`Done in ${Math.round((Date.now() - began) / 1000)}s: ${out} (${j.duration}s of video)`);
    break;
  }
  if (j.status === 'error') { console.error(j.error); process.exitCode = 1; break; }
}
server.close();
