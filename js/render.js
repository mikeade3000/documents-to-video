// Draws video frames: designed slides, original PDF pages, part title cards, captions and progress bar.
// All layout is written for a 1280x720 canvas and scaled for other sizes.

export const THEMES = {
  midnight: { name: 'Midnight', bg1: '#0b1426', bg2: '#16294a', title: '#ffffff', text: '#dbe4f3', muted: '#8ea3c4', accent: '#38bdf8', panel: 'rgba(255,255,255,0.06)' },
  light: { name: 'Clean light', bg1: '#ffffff', bg2: '#eef2f8', title: '#0f172a', text: '#334155', muted: '#64748b', accent: '#2563eb', panel: 'rgba(15,23,42,0.04)' },
  emerald: { name: 'Emerald', bg1: '#062a24', bg2: '#0d4a3f', title: '#ffffff', text: '#d5efe8', muted: '#8cc4b5', accent: '#fbbf24', panel: 'rgba(255,255,255,0.06)' },
  sunset: { name: 'Sunset', bg1: '#2a1033', bg2: '#5b1f3d', title: '#fff7ed', text: '#fde6d8', muted: '#e0a9a0', accent: '#fb923c', panel: 'rgba(255,255,255,0.07)' },
};

const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function clampLines(ctx, lines, maxLines, maxWidth) {
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last && ctx.measureText(last + '…').width > maxWidth) last = last.replace(/\s*\S+$/, '');
  out[maxLines - 1] = last + '…';
  return out;
}

function background(ctx, W, H, th) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, th.bg1);
  g.addColorStop(1, th.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawImageFit(ctx, img, x, y, w, h, radius = 0) {
  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  if (radius) {
    ctx.beginPath();
    ctx.roundRect(dx, dy, dw, dh, radius);
    ctx.clip();
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
  return { dx, dy, dw, dh };
}

function footer(ctx, W, H, k, th, docTitle, label) {
  ctx.fillStyle = th.muted;
  ctx.font = `${16 * k}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(clampLines(ctx, [docTitle], 1, W * 0.6)[0] || '', 64 * k, H - 30 * k);
  ctx.textAlign = 'right';
  ctx.fillText(label, W - 64 * k, H - 30 * k);
  ctx.textAlign = 'left';
}

// Static part of a designed slide (everything except captions/progress).
export function drawDesignedSlide(ctx, W, H, slide, th, docTitle, label) {
  const k = W / 1280;
  background(ctx, W, H, th);
  ctx.fillStyle = th.accent;
  ctx.fillRect(0, 0, W, 8 * k);
  ctx.fillRect(64 * k, 64 * k, 6 * k, 64 * k);

  const hasImage = !!slide.image;
  const textW = (hasImage ? 640 : 1120) * k;

  // Title
  ctx.fillStyle = th.title;
  let titleSize = 46;
  let titleLines;
  do {
    ctx.font = `700 ${titleSize * k}px ${FONT}`;
    titleLines = wrap(ctx, slide.title || '', textW - 24 * k);
    titleSize -= 2;
  } while (titleLines.length > 2 && titleSize > 30);
  titleLines = clampLines(ctx, titleLines, 2, textW - 24 * k);
  ctx.textBaseline = 'top';
  titleLines.forEach((l, i) => ctx.fillText(l, 88 * k, (66 + i * (titleSize + 10)) * k));
  const bodyTop = (66 + titleLines.length * (titleSize + 10) + 34) * k;

  // Bullets — shrink font until they fit
  const bullets = (slide.bullets || []).filter(Boolean).slice(0, 7);
  const bottom = H - 150 * k; // leave room for captions
  let size = 30;
  let layout;
  for (; size >= 18; size -= 2) {
    ctx.font = `${size * k}px ${FONT}`;
    const lh = size * 1.35 * k;
    layout = bullets.map((b) => clampLines(ctx, wrap(ctx, b, textW - 70 * k), 3, textW - 70 * k));
    const total = layout.reduce((a, ls) => a + ls.length * lh + size * 0.6 * k, 0);
    if (bodyTop + total <= bottom) break;
  }
  ctx.font = `${size * k}px ${FONT}`;
  const lh = size * 1.35 * k;
  let y = bodyTop;
  layout.forEach((ls) => {
    if (y + lh > bottom) return;
    ctx.fillStyle = th.accent;
    ctx.beginPath();
    ctx.arc(100 * k, y + lh / 2, 6 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = th.text;
    ls.forEach((l) => {
      if (y + lh <= bottom) ctx.fillText(l, 124 * k, y + (lh - size * k) / 2);
      y += lh;
    });
    y += size * 0.6 * k;
  });

  if (hasImage) {
    const x = 740 * k;
    const w = 480 * k;
    const top = 70 * k;
    const h = H - top - 160 * k;
    ctx.fillStyle = th.panel;
    ctx.beginPath();
    ctx.roundRect(x - 12 * k, top - 12 * k, w + 24 * k, h + 24 * k, 18 * k);
    ctx.fill();
    drawImageFit(ctx, slide.image, x, top, w, h, 10 * k);
  }
  footer(ctx, W, H, k, th, docTitle, label);
}

// Original PDF page, centred on the theme background.
export function drawPageSlide(ctx, W, H, pageBitmap, th, docTitle, label) {
  const k = W / 1280;
  background(ctx, W, H, th);
  const pad = 24 * k;
  const area = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 - 40 * k };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24 * k;
  drawImageFit(ctx, pageBitmap, area.x, area.y, area.w, area.h);
  ctx.restore();
  footer(ctx, W, H, k, th, docTitle, label);
}

export function drawTitleCard(ctx, W, H, th, docTitle, partNo, partCount, subtitle) {
  const k = W / 1280;
  background(ctx, W, H, th);
  ctx.fillStyle = th.accent;
  ctx.fillRect(0, 0, W, 8 * k);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = th.title;
  let size = 60;
  let lines;
  do {
    ctx.font = `700 ${size * k}px ${FONT}`;
    lines = wrap(ctx, docTitle, 1080 * k);
    size -= 4;
  } while (lines.length > 3 && size > 34);
  lines = clampLines(ctx, lines, 3, 1080 * k);
  const lh = (size + 18) * k;
  const top = H / 2 - (lines.length * lh) / 2 - 30 * k;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, top + i * lh));
  const after = top + lines.length * lh + 20 * k;
  ctx.fillStyle = th.accent;
  ctx.fillRect(W / 2 - 60 * k, after, 120 * k, 5 * k);
  if (partCount > 1) {
    ctx.fillStyle = th.text;
    ctx.font = `600 ${30 * k}px ${FONT}`;
    ctx.fillText(`Part ${partNo} of ${partCount}`, W / 2, after + 50 * k);
  }
  if (subtitle) {
    ctx.fillStyle = th.muted;
    ctx.font = `${22 * k}px ${FONT}`;
    ctx.fillText(clampLines(ctx, [subtitle], 1, 1000 * k)[0], W / 2, after + (partCount > 1 ? 95 : 55) * k);
  }
  ctx.textAlign = 'left';
}

export function drawCaption(ctx, W, H, text) {
  if (!text) return;
  const k = W / 1280;
  ctx.font = `600 ${26 * k}px ${FONT}`;
  const lines = clampLines(ctx, wrap(ctx, text, 1040 * k), 2, 1040 * k);
  const lh = 36 * k;
  const boxH = lines.length * lh + 22 * k;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 48 * k;
  const y = H - 70 * k - boxH;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath();
  ctx.roundRect((W - boxW) / 2, y, boxW, boxH, 12 * k);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 11 * k + i * lh + 4 * k));
  ctx.textAlign = 'left';
}

export function drawProgress(ctx, W, H, th, fraction) {
  const k = W / 1280;
  ctx.fillStyle = 'rgba(127,127,127,0.25)';
  ctx.fillRect(0, H - 6 * k, W, 6 * k);
  ctx.fillStyle = th.accent;
  ctx.fillRect(0, H - 6 * k, W * Math.min(1, Math.max(0, fraction)), 6 * k);
}

// Split a sentence caption into chunks of at most ~2 lines, timed by character count.
export function captionChunks(text, maxChars = 110) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}
