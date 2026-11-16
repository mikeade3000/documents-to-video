import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

/** Runs a command and resolves with its stdout; rejects with the tail of stderr on failure. */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(`Could not start ${cmd}: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with code ${code}: ${err.slice(-800)}`))));
  });
}

export async function audioDuration(file) {
  const out = await run(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error(`Could not read the length of ${path.basename(file)}`);
  return d;
}

/** Places each scene's narration at its start time and mixes one continuous audio track. */
export async function mixNarration(files, timeline, outFile) {
  const used = files.map((f, i) => ({ f, at: timeline.scenes[i].audioAt })).filter((x) => x.f);
  if (!used.length) return null;
  const args = ['-y'];
  for (const u of used) args.push('-i', u.f);
  const chains = used.map((u, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round(u.at * 1000)}:all=1[a${i}]`);
  const mix = `${used.map((_, i) => `[a${i}]`).join('')}amix=inputs=${used.length}:normalize=0:duration=longest,apad,atrim=0:${timeline.duration}[out]`;
  args.push('-filter_complex', [...chains, mix].join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', outFile);
  await run(config.ffmpeg, args);
  return outFile;
}

// JPEG frames are full-range BT.601; convert properly so colours match in every player.
const COLOR_FILTER = 'scale=in_color_matrix=bt601:in_range=full:out_color_matrix=bt709:out_range=tv,format=yuv420p';

/** Captures frames [from, to) of the player page into one H.264 chunk. */
async function renderChunk({ browser, url, from, to, fps, height, outFile, onFrame }) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: height / 1080 });
  const page = await context.newPage();
  const ff = spawn(config.ffmpeg, [
    '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', COLOR_FILTER, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(fps), outFile,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-2000); });
  ff.stdin.on('error', () => {}); // surfaced through the exit code below
  const closed = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed while encoding: ${ffErr.slice(-500)}`))));
  });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
    let lastSig = null;
    let frame = null;
    for (let f = from; f < to; f++) {
      // The page reports a signature of everything visible; identical signatures mean an identical frame.
      const sig = await page.evaluate((t) => window.__seek(t), f / fps);
      if (sig !== lastSig || !frame) {
        frame = await page.screenshot({ type: 'jpeg', quality: 95 });
        lastSig = sig;
      }
      if (!ff.stdin.write(frame)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), closed]);
      onFrame();
    }
    ff.stdin.end();
    await closed;
  } catch (err) {
    ff.kill('SIGKILL');
    await closed.catch(() => {});
    throw err;
  } finally {
    await context.close();
  }
}

/**
 * Renders the finished MP4.
 * @param url       player page for this job in render mode
 * @param timeline  from buildTimeline()
 * @param audioFile mixed narration, or null for a silent video
 */
export async function renderVideo({ url, timeline, audioFile, workDir, outFile, height = 1080, onProgress }) {
  const { frames, fps } = timeline;
  const workers = Math.min(config.renderWorkers, Math.max(1, Math.floor(frames / (fps * 4))));
  const per = Math.ceil(frames / workers);
  const browser = await chromium.launch({
    executablePath: config.chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--force-color-profile=srgb'],
  });
  const chunks = [];
  let done = 0;
  try {
    await Promise.all(Array.from({ length: workers }, (_, w) => {
      const from = w * per;
      const to = Math.min(frames, from + per);
      if (from >= to) return null;
      const file = path.join(workDir, `chunk-${w}.mp4`);
      chunks[w] = file;
      return renderChunk({ browser, url, from, to, fps, height, outFile: file, onFrame: () => { done++; if (done % 15 === 0 || done === frames) onProgress?.(done / frames); } });
    }));
  } finally {
    await browser.close();
  }
  const list = path.join(workDir, 'chunks.txt');
  await fs.writeFile(list, chunks.filter(Boolean).map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (audioFile) args.push('-i', audioFile, '-c:a', 'copy');
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-c:a', 'aac', '-b:a', '96k');
  args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-shortest', '-movflags', '+faststart', outFile);
  await run(config.ffmpeg, args);
  await Promise.all([...chunks.filter(Boolean), list].map((f) => fs.rm(f, { force: true })));
  return outFile;
}
