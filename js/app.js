import { parseDocument, renderPdfPage } from './parsers.js';
import { VOICES, loadVoiceEngine, speak, speakAll, splitSentences, stopVoiceEngine, setEnginePreference, engineLabel } from './tts.js';
import { THEMES, drawDesignedSlide, drawPageSlide } from './render.js';
import { planParts, encodePart, checkBrowserSupport, TIMING } from './video.js';
import { CLOUD_VOICES, cloudSpeak, cloudSpeakAll } from './cloud-tts.js';
import { CONFIG } from './config.js';
import { paymentsEnabled, getServerConfig, formatPrice, getReceipt, checkReceipt, purchase, aiScript as requestAiScript } from './payments.js';

const $ = (id) => document.getElementById(id);
const WPM = 140; // average narration pace at 1.0x

const state = {
  doc: null,
  script: [], // [{ title, bullets, narration, image, pdfPage }]
  results: [],
  cancelled: false,
  busy: false,
};

// ---------- setup ----------

const support = checkBrowserSupport();
if (support) {
  $('support-warning').textContent = support;
  $('support-warning').classList.remove('hidden');
}

for (const [id, th] of Object.entries(THEMES)) $('theme').add(new Option(th.name, id));

// ---------- voice service (free in-browser, Google Cloud or Azure) ----------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const provider = () => $('provider').value;
const ownerGoogleKey = (CONFIG.googleApiKey || '').trim();

function cloudCreds() {
  return {
    googleKey: $('google-key').value.trim() || ownerGoogleKey,
    azureKey: $('azure-key').value.trim(),
    azureRegion: $('azure-region').value.trim(),
  };
}

function saveCloudCreds() {
  const remember = $('remember-cloud').checked;
  store.set('d2v-remember-cloud', remember ? '1' : null);
  store.set('d2v-google-key', remember ? $('google-key').value.trim() || null : null);
  store.set('d2v-azure-key', remember ? $('azure-key').value.trim() || null : null);
  store.set('d2v-azure-region', remember ? $('azure-region').value.trim() || null : null);
}

function fillVoices() {
  const g = document.querySelector('input[name="gender"]:checked').value;
  const list = provider() === 'local' ? VOICES[g] : CLOUD_VOICES[provider()][g];
  const previous = $('voice').value;
  $('voice').innerHTML = '';
  for (const v of list) $('voice').add(new Option(v.label, v.id));
  if (list.some((v) => v.id === previous)) $('voice').value = previous;
}

function updateProvider() {
  const p = provider();
  $('google-fields').classList.toggle('hidden', p !== 'google' || !!ownerGoogleKey);
  $('azure-fields').classList.toggle('hidden', p !== 'azure');
  $('remember-cloud-row').classList.toggle('hidden', p === 'local' || (p === 'google' && !!ownerGoogleKey));
  $('cloud-note').classList.toggle('hidden', p === 'local');
  $('engine-field').classList.toggle('hidden', p !== 'local');
  store.set('d2v-provider', p);
  fillVoices();
}

$('google-key').value = store.get('d2v-google-key') || '';
$('azure-key').value = store.get('d2v-azure-key') || '';
$('azure-region').value = store.get('d2v-azure-region') || '';
$('remember-cloud').checked = store.get('d2v-remember-cloud') === '1';
$('provider').value = store.get('d2v-provider') || CONFIG.defaultProvider || 'local';
if (!$('provider').value) $('provider').value = 'local';
['google-key', 'azure-key', 'azure-region', 'remember-cloud'].forEach((id) => $(id).addEventListener('change', saveCloudCreds));
$('provider').addEventListener('change', updateProvider);
document.querySelectorAll('input[name="gender"]').forEach((r) => r.addEventListener('change', fillVoices));
updateProvider();

$('speed').addEventListener('input', () => {
  $('speed-out').textContent = `${Number($('speed').value).toFixed(2)}×`;
  if (state.script.length) renderSummary();
});
$('max-len').addEventListener('change', () => state.script.length && renderSummary());
['style', 'theme'].forEach((id) => $(id).addEventListener('change', () => state.script.length && renderScript()));

// ---------- paid features ----------

// Without a payment server configured, AI narration is hidden and downloads are free.
if (!paymentsEnabled()) {
  $('ai-box').classList.add('hidden');
} else {
  getServerConfig().then((cfg) => {
    $('ai-price').textContent = `(${formatPrice(cfg.prices.ai, cfg.currency)} per document, ${cfg.aiUsesPerPayment} rewrites)`;
    $('download-price').textContent = formatPrice(cfg.prices.download, cfg.currency);
  }).catch(() => {
    $('ai-status').textContent = 'The payment server is not reachable right now, so paid features are unavailable.';
  });
}

async function refreshAiStatus() {
  if (!paymentsEnabled() || !state.jobId) return;
  const r = await checkReceipt('ai', state.jobId);
  $('ai-status').textContent = r ? `✓ Paid for this document — ${r.aiUsesLeft} AI rewrite${r.aiUsesLeft === 1 ? '' : 's'} left.` : '';
}

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- step 1: file ----------

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && $('file').click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
$('file').addEventListener('change', () => $('file').files[0] && loadFile($('file').files[0]));

async function loadFile(file) {
  $('file-info').textContent = `Reading ${file.name}…`;
  $('build-script').disabled = true;
  try {
    state.doc = await parseDocument(file);
    state.jobId = await sha256Hex(await file.arrayBuffer()); // identifies this document for payments
    refreshAiStatus();
    const d = state.doc;
    const words = d.slides.reduce((a, s) => a + countWords(s.notes || s.text), 0);
    const unit = d.kind === 'pdf' ? 'pages' : d.kind === 'docx' ? 'sections/slides' : 'slides';
    $('file-info').textContent = `✓ ${file.name} — “${d.title}”: ${d.slides.length} ${unit}, about ${words.toLocaleString()} words.`;
    $('style').value = d.kind === 'pdf' ? 'page' : 'designed';
    $('style').options[1].disabled = d.kind !== 'pdf';
    const hasNotes = d.slides.some((s) => s.notes);
    $('source').value = hasNotes ? 'notes' : 'text';
    $('build-script').disabled = false;
    $('script-card').classList.add('hidden');
  } catch (err) {
    console.error(err);
    state.doc = null;
    $('file-info').textContent = `✗ ${err.message || err}`;
  }
}

// ---------- step 3: script ----------

const countWords = (t) => (t ? t.trim().split(/\s+/).filter(Boolean).length : 0);
const sentence = (t) => { t = t.trim(); return t && !/[.!?:;]$/.test(t) ? `${t}.` : t; };

function defaultNarration(slide, source) {
  if (source === 'notes' && slide.notes) return slide.notes;
  if (state.doc.kind === 'pptx') return [slide.title, ...slide.bullets].map(sentence).join(' ');
  return [sentence(slide.title), slide.text].filter(Boolean).join(' ');
}

$('build-script').addEventListener('click', async () => {
  if (!state.doc) return;
  const btn = $('build-script');
  btn.disabled = true;
  $('script-status').className = 'status';
  const source = $('source').value;
  let aiScript = null;
  try {
    if ($('use-ai').checked) {
      if (!getReceipt('ai', state.jobId) || !(await checkReceipt('ai', state.jobId))) {
        const cfg = await getServerConfig();
        const receipt = await purchase('ai', state.jobId, {
          title: 'AI narration',
          description: `AI writes the narration for “${state.doc.title}” following your instructions. Includes ${cfg.aiUsesPerPayment} rewrites of this document.`,
        });
        if (!receipt) throw new Error('Payment cancelled. Untick the AI option to build the script for free.');
      }
      $('script-status').textContent = 'AI is writing the narration script… (this can take a minute for long documents)';
      const out = await requestAiScript(state.jobId, {
        doc: {
          title: state.doc.title,
          kind: state.doc.kind,
          slides: state.doc.slides.map((s) => ({ title: s.title, text: s.text, notes: source === 'notes' ? s.notes : '' })),
        },
        instructions: $('instructions').value,
        wordsPerMinute: Math.round(WPM * Number($('speed').value)),
        maxPartSeconds: Number($('max-len').value),
      });
      const byIndex = new Map(out.slides.map((x) => [x.index, x]));
      aiScript = state.doc.slides.map((_, i) => byIndex.get(i) || null);
      refreshAiStatus();
    }
    state.script = state.doc.slides.map((s, i) => {
      const ai = aiScript?.[i];
      return {
        title: ai?.title || s.title,
        bullets: ai?.bullets?.length ? ai.bullets : s.bullets,
        narration: ai?.narration ?? defaultNarration(s, source),
        image: s.image,
        pdfPage: s.pdfPage,
      };
    });
    const intro = $('intro').value.trim();
    const outro = $('outro').value.trim();
    if (intro) state.script[0].narration = `${sentence(intro)} ${state.script[0].narration}`;
    if (outro) {
      const last = state.script[state.script.length - 1];
      last.narration = `${last.narration} ${sentence(outro)}`;
    }
    $('script-status').textContent = aiScript ? '✓ Script written by AI. Review it below.' : '✓ Script ready. Review and edit it below.';
    renderScript();
    $('script-card').classList.remove('hidden');
    $('script-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    $('script-status').className = 'status err';
    $('script-status').textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
});

function estSeconds(text) {
  const speed = Number($('speed').value);
  const w = countWords(text);
  if (!w) return TIMING.emptySlide;
  const sentences = splitSentences(text).length;
  return (w / (WPM * speed)) * 60 + sentences * TIMING.gap + TIMING.slideEnd;
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function renderSummary() {
  const total = state.script.reduce((a, s) => a + estSeconds(s.narration), 0);
  // Rough estimate of the number of parts (the exact split happens after the voice is generated).
  const fake = state.script.map((s) => {
    const sec = estSeconds(s.narration);
    const n = Math.max(1, splitSentences(s.narration).length);
    return { clips: s.narration.trim() ? Array.from({ length: n }, () => ({ samples: { length: Math.max(0, Math.round(((sec - TIMING.slideEnd) / n - TIMING.gap) * 1000)) }, sampleRate: 1000 })) : [] };
  });
  const parts = planParts(fake, Number($('max-len').value)).length;
  $('summary').innerHTML = `
    <div>Slides<br><b>${state.script.length}</b></div>
    <div>Estimated narration<br><b>${fmt(total)}</b></div>
    <div>Estimated videos<br><b>${parts}</b> <span class="muted">(max ${fmt(Number($('max-len').value))} each)</span></div>`;
}

function renderScript() {
  const list = $('script-list');
  list.innerHTML = '';
  const th = THEMES[$('theme').value];
  const pageMode = $('style').value === 'page' && state.doc.kind === 'pdf';
  state.script.forEach((s, i) => {
    const item = document.createElement('div');
    item.className = 'script-item';
    const left = document.createElement('div');
    const cv = document.createElement('canvas');
    cv.width = 640;
    cv.height = 360;
    left.appendChild(cv);
    const meta = document.createElement('div');
    meta.className = 'meta';
    left.appendChild(meta);
    const fields = document.createElement('div');
    fields.className = 'fields';
    fields.innerHTML = `
      <input type="text" class="t" aria-label="Slide ${i + 1} title" />
      <textarea class="b" rows="3" aria-label="Slide ${i + 1} on-screen points (one per line)" placeholder="On-screen points, one per line"></textarea>
      <textarea class="narr" aria-label="Slide ${i + 1} narration" placeholder="What the narrator says on this slide"></textarea>`;
    const t = fields.querySelector('.t');
    const b = fields.querySelector('.b');
    const n = fields.querySelector('.narr');
    t.value = s.title;
    b.value = s.bullets.join('\n');
    n.value = s.narration;
    const draw = async () => {
      const ctx = cv.getContext('2d');
      if (pageMode && s.pdfPage) {
        const bmp = await renderPdfPage(state.doc.pdf, s.pdfPage, 640, 360);
        drawPageSlide(ctx, 640, 360, bmp, th, state.doc.title, `${i + 1} / ${state.script.length}`);
        bmp.close();
      } else {
        drawDesignedSlide(ctx, 640, 360, s, th, state.doc.title, `${i + 1} / ${state.script.length}`);
      }
    };
    const updateMeta = () => {
      meta.textContent = `Slide ${i + 1} · ${countWords(s.narration)} words · ~${fmt(estSeconds(s.narration))}`;
    };
    t.addEventListener('input', () => { s.title = t.value; if (!pageMode) draw(); });
    b.addEventListener('input', () => { s.bullets = b.value.split('\n').map((x) => x.trim()).filter(Boolean); if (!pageMode) draw(); });
    n.addEventListener('input', () => { s.narration = n.value; updateMeta(); renderSummary(); });
    item.append(left, fields);
    list.appendChild(item);
    updateMeta();
    // draw thumbnails lazily
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { obs.disconnect(); draw(); }
    }).observe(cv);
  });
  renderSummary();
}

// ---------- voice preview ----------

let audioCtx = null;
async function play(samples, rate) {
  audioCtx = audioCtx || new AudioContext();
  const buf = audioCtx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start();
}

$('preview-voice').addEventListener('click', async () => {
  const btn = $('preview-voice');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '…';
  try {
    const label = $('voice').selectedOptions[0].textContent.split(' — ')[0];
    const sample = `Hello, I'm ${label}. I will narrate your presentation.`;
    let out;
    if (provider() === 'local') {
      await loadVoiceEngine((p) => { btn.textContent = `${Math.round((p.loaded / p.total) * 100)}%`; });
      btn.textContent = '…';
      out = await speak(sample, $('voice').value, Number($('speed').value));
    } else {
      out = await cloudSpeak(provider(), cloudCreds(), sample, $('voice').value, Number($('speed').value));
    }
    await play(out.samples, out.sampleRate);
  } catch (err) {
    alert(`Could not play the voice: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

// ---------- step 4: generate ----------

// The status line shows the current step plus a live clock, so it never looks frozen.
let statusText = '';
let stepStart = 0;
let jobStart = 0;
let ticker = null;
function showStatus() {
  if (!statusText) return;
  const now = performance.now();
  const step = (now - stepStart) / 1000;
  const total = (now - jobStart) / 1000;
  const waiting = step > 15 ? ` · still working (${fmt(step)} on this step)` : '';
  $('gen-status').textContent = `${statusText}${waiting} · ${fmt(total)} elapsed`;
}
function setProgress(frac, text) {
  $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
  if (text && text !== statusText) {
    statusText = text;
    stepStart = performance.now();
  }
  showStatus();
}

$('engine').addEventListener('change', () => {
  setEnginePreference($('engine').value);
  try { localStorage.setItem('d2v-engine', $('engine').value); } catch { /* ignore */ }
});
try {
  const savedEngine = localStorage.getItem('d2v-engine');
  if (savedEngine) $('engine').value = savedEngine;
} catch { /* ignore */ }
setEnginePreference($('engine').value);

$('cancel').addEventListener('click', () => {
  state.cancelled = true;
  stopVoiceEngine(); // stops the sentence being recorded right now
});

$('generate').addEventListener('click', async () => {
  if (state.busy) return;
  const err = checkBrowserSupport();
  if (err) { alert(err); return; }
  state.busy = true;
  state.cancelled = false;
  $('generate').disabled = true;
  $('build-script').disabled = true;
  $('cancel').classList.remove('hidden');
  $('progress-wrap').classList.remove('hidden');
  $('gen-status').className = 'status';
  jobStart = performance.now();
  statusText = '';
  clearInterval(ticker);
  ticker = setInterval(showStatus, 1000);
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $('results').innerHTML = '';
  $('results-card').classList.add('hidden');

  const voice = $('voice').value;
  const speed = Number($('speed').value);
  const [W, H] = $('resolution').value.split('x').map(Number);
  const maxLen = Number($('max-len').value);
  const th = THEMES[$('theme').value];
  const pageMode = $('style').value === 'page' && state.doc.kind === 'pdf';

  try {
    // 1. Voice engine
    const cloud = provider() !== 'local';
    if (!cloud) {
      setProgress(0, 'Loading the voice engine…');
      await loadVoiceEngine(
        (p) => setProgress(p.loaded / p.total * 0.05, `Downloading voice model (first time only): ${Math.round(p.loaded / 1e6)} / ${Math.round(p.total / 1e6)} MB`),
        (msg) => setProgress(0.05, msg),
      );
    }
    const engine = () => (cloud ? (provider() === 'google' ? 'Google Cloud' : 'Azure') : engineLabel());

    // 2. Speech for every sentence
    const entries = state.script.map((s) => ({ ...s, sentences: splitSentences(s.narration) }));
    const texts = entries.flatMap((e) => e.sentences);
    const t0 = performance.now();
    setProgress(0.05, `Recording narration (${engine()}): working on sentence 1 of ${texts.length}…`);
    const onEach = (done) => {
      const elapsed = (performance.now() - t0) / 1000;
      const eta = done > 2 ? Math.round((elapsed / done) * (texts.length - done)) : null;
      setProgress(0.05 + (done / texts.length) * 0.55,
        `Recording narration (${engine()}): ${done} of ${texts.length} sentences done${eta != null ? ` — about ${fmt(eta)} left` : ''}`);
    };
    const audio = cloud
      ? await cloudSpeakAll(provider(), cloudCreds(), texts, voice, speed, onEach, () => state.cancelled)
      : await speakAll(texts, voice, speed, onEach, () => state.cancelled);
    let k = 0;
    for (const e of entries) {
      e.clips = e.sentences.map((text) => {
        const out = audio[k++];
        return { text, samples: out.samples, sampleRate: out.sampleRate };
      });
    }

    // 3. Split into parts and encode (watermarked previews until the download is paid for)
    const parts = planParts(entries, maxLen);
    state.lastRun = {
      parts,
      jobId: state.jobId,
      opts: { width: W, height: H, fps: 24, theme: th, docTitle: state.doc.title, captions: $('captions').checked, pageMode, pdf: state.doc.pdf },
    };
    const watermark = paymentsEnabled() && !getReceipt('download', state.jobId);
    await renderParts(watermark, 0.6, 0.4);
    clearInterval(ticker);
    setProgress(1, `✓ Done — ${parts.length} video${parts.length > 1 ? 's' : ''} created${watermark ? ' (previews)' : ''}`);
  } catch (e) {
    console.error(e);
    clearInterval(ticker);
    $('gen-status').className = 'status err';
    $('gen-status').textContent = state.cancelled
      ? 'Cancelled. Sentences already recorded are kept, so pressing Generate again continues faster.'
      : (e.message || String(e));
  } finally {
    clearInterval(ticker);
    state.busy = false;
    $('generate').disabled = false;
    $('build-script').disabled = false;
    $('cancel').classList.add('hidden');
  }
});

function safeName(s) {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'video';
}

// Encode every part of the last run and show the results.
async function renderParts(watermark, progressStart, progressSpan) {
  const { parts, opts } = state.lastRun;
  for (const r of state.results) URL.revokeObjectURL(r.url);
  state.results = [];
  $('results').innerHTML = '';
  for (let p = 0; p < parts.length; p++) {
    if (state.cancelled) throw new Error('Cancelled.');
    const base = progressStart + (p / parts.length) * progressSpan;
    const res = await encodePart(parts[p], {
      ...opts,
      partNo: p + 1,
      partCount: parts.length,
      watermark,
      onProgress: (f) => setProgress(base + f * (progressSpan / parts.length), `${watermark ? 'Creating preview' : 'Creating video'} ${p + 1} of ${parts.length}… ${Math.round(f * 100)}%`),
    });
    addResult(res, p + 1, parts.length, parts[p], watermark);
  }
  state.watermarked = watermark;
  $('paywall').classList.toggle('hidden', !watermark);
}

function addResult(res, partNo, partCount, part, watermark) {
  const url = URL.createObjectURL(res.blob);
  const name = `${safeName(state.doc.title)}${partCount > 1 ? `-part-${partNo}-of-${partCount}` : ''}.mp4`;
  state.results.push({ url, name });
  const first = part.segments[0];
  const last = part.segments[part.segments.length - 1];
  const el = document.createElement('div');
  el.className = 'result';
  el.innerHTML = `
    <video controls controlslist="nodownload" preload="metadata" src="${url}"></video>
    <div class="row"><strong>Part ${partNo} of ${partCount}${watermark ? ' · preview' : ''}</strong><span class="muted">${fmt(res.duration)} · ${(res.blob.size / 1e6).toFixed(1)} MB</span></div>
    <div class="muted">Slides ${first.label.split(' /')[0]}–${last.label.split(' /')[0]}</div>
    <button type="button" class="primary dl-btn" style="width:100%">${watermark ? 'Unlock &amp; download MP4' : 'Download MP4'}</button>`;
  el.querySelector('video').addEventListener('contextmenu', (e) => watermark && e.preventDefault());
  el.querySelector('.dl-btn').addEventListener('click', () => downloadParts([partNo - 1]));
  $('results').appendChild(el);
  $('results-card').classList.remove('hidden');
  $('download-all').textContent = watermark ? 'Unlock & download all' : 'Download all';
  $('results-note').textContent = res.audioCodec === 'aac'
    ? 'MP4 (H.264 video, AAC audio).'
    : 'MP4 (H.264 video, Opus audio — this browser has no AAC encoder; use Chrome/Edge on Windows or macOS for AAC).';
}

function saveFile(r) {
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Pay (if needed), re-render without the watermark, then download.
async function downloadParts(indexes) {
  if (state.busy) return;
  if (state.watermarked) {
    const jobId = state.lastRun.jobId;
    let receipt = getReceipt('download', jobId);
    if (receipt && !(await checkReceipt('download', jobId))) receipt = null;
    if (!receipt) {
      receipt = await purchase('download', jobId, {
        title: 'Download your videos',
        description: `Clean MP4 videos without watermark for “${state.lastRun.opts.docTitle}” — all ${state.lastRun.parts.length} part${state.lastRun.parts.length > 1 ? 's' : ''}, and any re-renders of this document.`,
      });
      if (!receipt) return;
    }
    state.busy = true;
    state.cancelled = false;
    $('generate').disabled = true;
    $('progress-wrap').classList.remove('hidden');
    $('gen-status').className = 'status';
    jobStart = performance.now();
    statusText = '';
    clearInterval(ticker);
    ticker = setInterval(showStatus, 1000);
    try {
      await renderParts(false, 0, 1);
      setProgress(1, '✓ Payment confirmed — your videos are ready to download');
    } catch (e) {
      console.error(e);
      $('gen-status').className = 'status err';
      $('gen-status').textContent = e.message || String(e);
      return;
    } finally {
      clearInterval(ticker);
      state.busy = false;
      $('generate').disabled = false;
    }
    $('results-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  for (const i of indexes) {
    saveFile(state.results[i]);
    await new Promise((res) => setTimeout(res, 600));
  }
}

$('download-all').addEventListener('click', () => downloadParts(state.results.map((_, i) => i)));

