// Plans the video parts (each no longer than the chosen limit) and encodes them to MP4
// with the browser's built-in WebCodecs encoders (H.264 video + AAC audio).

import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm';
import { drawDesignedSlide, drawPageSlide, drawTitleCard, drawCaption, drawProgress, captionChunks } from './render.js';
import { renderPdfPage } from './parsers.js';

export const TIMING = {
  titleCard: 3.0, // seconds of title card at the start of every part
  gap: 0.35, // pause between sentences
  slideEnd: 0.8, // pause at the end of each slide
  emptySlide: 3.0, // how long a slide with no narration stays on screen
  fade: 0.4, // cross-fade between slides
};
const SAMPLE_RATE = 48000;

const clipSeconds = (c) => c.samples.length / c.sampleRate;

// entries: [{ title, bullets, image, pdfPage, clips: [{text, samples, sampleRate}] }]
// Returns parts: [{ segments: [{ entry, clips, label, duration }], duration }]
export function planParts(entries, maxPartSeconds) {
  const budget = maxPartSeconds - TIMING.titleCard;
  const segDuration = (clips) => (clips.length
    ? clips.reduce((a, c) => a + clipSeconds(c) + TIMING.gap, 0) + TIMING.slideEnd
    : TIMING.emptySlide);

  // 1. Turn entries into segments, splitting a slide whose narration alone exceeds the budget.
  const segments = [];
  entries.forEach((entry, i) => {
    const label = `${i + 1} / ${entries.length}`;
    if (segDuration(entry.clips) <= budget) {
      segments.push({ entry, clips: entry.clips, label, duration: segDuration(entry.clips) });
      return;
    }
    let group = [];
    for (const c of entry.clips) {
      if (group.length && segDuration([...group, c]) > budget) {
        segments.push({ entry, clips: group, label, duration: segDuration(group) });
        group = [];
      }
      group.push(c);
    }
    if (group.length) segments.push({ entry, clips: group, label, duration: segDuration(group) });
  });

  // 2. Pack segments into parts, never exceeding the limit.
  const parts = [];
  let cur = null;
  for (const seg of segments) {
    if (!cur || cur.body + seg.duration > budget) {
      cur = { segments: [], body: 0 };
      parts.push(cur);
    }
    cur.segments.push(seg);
    cur.body += seg.duration;
  }
  // 3. Balance: if the last part is very short, even out the last two parts.
  if (parts.length >= 2) {
    const a = parts[parts.length - 2];
    const b = parts[parts.length - 1];
    while (a.segments.length > 1) {
      const moved = a.segments[a.segments.length - 1];
      const newA = a.body - moved.duration;
      const newB = b.body + moved.duration;
      if (newB > budget || newB - newA > moved.duration) break;
      if (Math.abs(newA - newB) >= Math.abs(a.body - b.body)) break;
      a.segments.pop();
      b.segments.unshift(moved);
      a.body = newA;
      b.body = newB;
    }
  }
  return parts.map((p) => ({ segments: p.segments, duration: p.body + TIMING.titleCard }));
}

function resampleInto(out, offset, samples, srcRate) {
  const ratio = srcRate / SAMPLE_RATE;
  const n = Math.floor(samples.length / ratio);
  const fade = Math.min(240, n / 4); // 5 ms fade in/out avoids clicks
  for (let i = 0; i < n && offset + i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    let v = samples[i0] + (samples[i1] - samples[i0]) * (pos - i0);
    if (i < fade) v *= i / fade;
    else if (i > n - fade) v *= (n - i) / fade;
    out[offset + i] = v;
  }
}

async function pickVideoCodec(width, height, fps) {
  const bitrate = width >= 1920 ? 6_000_000 : 3_000_000;
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f']) {
    const config = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch { /* try next */ }
  }
  throw new Error('This browser cannot encode H.264 video. Please use a recent Chrome, Edge or Safari on a desktop computer.');
}

async function pickAudioCodec() {
  const options = [
    { muxer: 'aac', config: { codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 128000 } },
    { muxer: 'opus', config: { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 96000 } },
  ];
  for (const o of options) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported(o.config);
      if (supported) return o;
    } catch { /* try next */ }
  }
  throw new Error('This browser cannot encode audio for MP4. Please use a recent Chrome or Edge.');
}

export function checkBrowserSupport() {
  const missing = ['VideoEncoder', 'AudioEncoder', 'VideoFrame', 'AudioData', 'OffscreenCanvas'].filter((k) => !(k in window));
  return missing.length ? `Your browser is missing: ${missing.join(', ')}. Use a recent desktop Chrome or Edge.` : null;
}

// Encode one part. opts: { width, height, fps, theme, docTitle, partNo, partCount, captions, pageMode, pdf, onProgress }
export async function encodePart(part, opts) {
  const { width: W, height: H, fps, theme: th } = opts;
  const total = part.duration;
  const totalSamples = Math.ceil(total * SAMPLE_RATE);
  const audio = new Float32Array(totalSamples);

  // ---- Timeline: slide spans and caption spans ----
  const spans = [];
  const captions = [];
  let t = TIMING.titleCard;
  for (const seg of part.segments) {
    const start = t;
    if (!seg.clips.length) t += TIMING.emptySlide;
    for (const c of seg.clips) {
      const d = clipSeconds(c);
      resampleInto(audio, Math.round(t * SAMPLE_RATE), c.samples, c.sampleRate);
      const chunks = captionChunks(c.text);
      const chars = chunks.reduce((a, s) => a + s.length, 0);
      let ct = t;
      for (const ch of chunks) {
        const cd = d * (ch.length / chars);
        captions.push({ start: ct, end: ct + cd, text: ch });
        ct += cd;
      }
      t += d + TIMING.gap;
    }
    if (seg.clips.length) t += TIMING.slideEnd;
    spans.push({ start, end: t, seg });
  }

  // ---- Pre-render the static slide images ----
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const pages = new Map();
  for (const span of spans) {
    const e = span.seg.entry;
    if (opts.pageMode && e.pdfPage && opts.pdf && !pages.has(e.pdfPage)) {
      pages.set(e.pdfPage, await renderPdfPage(opts.pdf, e.pdfPage, W, H));
    }
  }
  const staticBitmaps = new Map();
  const firstTitle = part.segments[0]?.entry.title || '';
  const lastTitle = part.segments[part.segments.length - 1]?.entry.title || '';
  drawTitleCard(ctx, W, H, th, opts.docTitle, opts.partNo, opts.partCount,
    opts.partCount > 1 ? (firstTitle === lastTitle ? firstTitle : `${firstTitle}  →  ${lastTitle}`) : '');
  const titleBitmap = canvas.transferToImageBitmap();
  for (const span of spans) {
    const e = span.seg.entry;
    const key = `${span.seg.label}|${e.pdfPage}`;
    if (staticBitmaps.has(key)) { span.bitmap = staticBitmaps.get(key); continue; }
    if (opts.pageMode && e.pdfPage && pages.has(e.pdfPage)) drawPageSlide(ctx, W, H, pages.get(e.pdfPage), th, opts.docTitle, span.seg.label);
    else drawDesignedSlide(ctx, W, H, e, th, opts.docTitle, span.seg.label);
    span.bitmap = canvas.transferToImageBitmap();
    staticBitmaps.set(key, span.bitmap);
  }

  // ---- Encoders + muxer ----
  const videoConfig = await pickVideoCodec(W, H, fps);
  const audioChoice = await pickAudioCodec();
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: { codec: audioChoice.muxer, numberOfChannels: 1, sampleRate: SAMPLE_RATE },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure(videoConfig);
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  audioEncoder.configure(audioChoice.config);

  // Audio, in 0.1 s blocks
  const block = SAMPLE_RATE / 10;
  for (let i = 0; i < totalSamples; i += block) {
    const data = audio.slice(i, Math.min(totalSamples, i + block));
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data });
    audioEncoder.encode(ad);
    ad.close();
  }

  // Video frames
  const nFrames = Math.ceil(total * fps);
  let spanIdx = 0;
  let capIdx = 0;
  for (let f = 0; f < nFrames; f++) {
    if (encodeError) throw encodeError;
    const ft = f / fps;
    while (spanIdx < spans.length - 1 && ft >= spans[spanIdx].end) spanIdx++;
    const span = ft >= TIMING.titleCard ? spans[spanIdx] : null;
    if (!span) {
      ctx.drawImage(titleBitmap, 0, 0);
    } else {
      const since = ft - span.start;
      const prev = spanIdx > 0 ? spans[spanIdx - 1].bitmap : titleBitmap;
      if (since < TIMING.fade && prev !== span.bitmap) {
        ctx.globalAlpha = 1;
        ctx.drawImage(prev, 0, 0);
        ctx.globalAlpha = since / TIMING.fade;
        ctx.drawImage(span.bitmap, 0, 0);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(span.bitmap, 0, 0);
      }
      if (opts.captions) {
        while (capIdx < captions.length - 1 && ft >= captions[capIdx].end) capIdx++;
        const cap = captions[capIdx];
        if (cap && ft >= cap.start && ft < cap.end + TIMING.gap * 0.8) drawCaption(ctx, W, H, cap.text);
      }
    }
    drawProgress(ctx, W, H, th, ft / total);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(ft * 1e6), duration: Math.round(1e6 / fps) });
    videoEncoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();
    if (videoEncoder.encodeQueueSize > 6) {
      await new Promise((r) => videoEncoder.addEventListener('dequeue', r, { once: true }));
    }
    if (f % fps === 0) {
      opts.onProgress?.(f / nFrames);
      await new Promise((r) => setTimeout(r, 0)); // let the UI update
    }
  }
  await videoEncoder.flush();
  await audioEncoder.flush();
  if (encodeError) throw encodeError;
  videoEncoder.close();
  audioEncoder.close();
  muxer.finalize();
  titleBitmap.close();
  for (const b of staticBitmaps.values()) b.close();
  for (const b of pages.values()) b.close();
  opts.onProgress?.(1);
  return {
    blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
    duration: total,
    audioCodec: audioChoice.muxer,
  };
}
