import { parseDocument, renderPdfPage } from './parsers.js';
import { VOICES, loadVoiceEngine, speak, speakAll, splitSentences } from './tts.js';
import { THEMES, drawDesignedSlide, drawPageSlide } from './render.js';
import { planParts, encodePart, checkBrowserSupport, TIMING } from './video.js';

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

function fillVoices() {
  const g = document.querySelector('input[name="gender"]:checked').value;
  $('voice').innerHTML = '';
  for (const v of VOICES[g]) $('voice').add(new Option(v.label, v.id));
}
document.querySelectorAll('input[name="gender"]').forEach((r) => r.addEventListener('change', fillVoices));
fillVoices();

$('speed').addEventListener('input', () => {
  $('speed-out').textContent = `${Number($('speed').value).toFixed(2)}×`;
  if (state.script.length) renderSummary();
});
$('max-len').addEventListener('change', () => state.script.length && renderSummary());
['style', 'theme'].forEach((id) => $(id).addEventListener('change', () => state.script.length && renderScript()));

try {
  const saved = localStorage.getItem('d2v-api-key');
  if (saved) { $('api-key').value = saved; $('remember-key').checked = true; }
} catch { /* storage unavailable */ }
$('use-ai').addEventListener('change', () => $('ai-fields').classList.toggle('hidden', !$('use-ai').checked));

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
      const apiKey = $('api-key').value.trim();
      if (!apiKey) throw new Error('Enter your Anthropic API key, or untick the AI option.');
      try {
        if ($('remember-key').checked) localStorage.setItem('d2v-api-key', apiKey);
        else localStorage.removeItem('d2v-api-key');
      } catch { /* ignore */ }
      $('script-status').textContent = 'Claude is writing the narration script… (this can take a minute for long documents)';
      const { writeScriptWithClaude, describeApiError } = await import('./script-ai.js');
      try {
        const docForAi = {
          ...state.doc,
          slides: state.doc.slides.map((s) => ({ ...s, notes: source === 'notes' ? s.notes : '' })),
        };
        aiScript = await writeScriptWithClaude({
          apiKey,
          doc: docForAi,
          instructions: $('instructions').value,
          wordsPerMinute: Math.round(WPM * Number($('speed').value)),
          maxPartSeconds: Number($('max-len').value),
        });
      } catch (err) {
        throw new Error(describeApiError(err));
      }
    }
    state.script = state.doc.slides.map((s, i) => {
      const ai = aiScript?.[i];
      return {
        title: ai?.title || s.title,
        bullets: ai?.bullets || s.bullets,
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
    $('script-status').textContent = aiScript ? '✓ Script written by Claude. Review it below.' : '✓ Script ready. Review and edit it below.';
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
    await loadVoiceEngine((p) => { btn.textContent = `${Math.round((p.loaded / p.total) * 100)}%`; });
    btn.textContent = '…';
    const label = $('voice').selectedOptions[0].textContent.split(' — ')[0];
    const out = await speak(`Hello, I'm ${label}. I will narrate your presentation.`, $('voice').value, Number($('speed').value));
    await play(out.samples, out.sampleRate);
  } catch (err) {
    alert(`Could not load the voice engine: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

// ---------- step 4: generate ----------

function setProgress(frac, text) {
  $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
  if (text) $('gen-status').textContent = text;
}

$('cancel').addEventListener('click', () => { state.cancelled = true; });

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
    setProgress(0, 'Loading the voice engine…');
    const device = await loadVoiceEngine((p) => setProgress(p.loaded / p.total * 0.05, `Downloading voice model (first time only): ${Math.round(p.loaded / 1e6)} / ${Math.round(p.total / 1e6)} MB`));

    // 2. Speech for every sentence
    const entries = state.script.map((s) => ({ ...s, sentences: splitSentences(s.narration) }));
    const texts = entries.flatMap((e) => e.sentences);
    const t0 = performance.now();
    const audio = await speakAll(texts, voice, speed, (done, nWorkers) => {
      const elapsed = (performance.now() - t0) / 1000;
      const eta = done > 2 ? Math.round((elapsed / done) * (texts.length - done)) : null;
      const engine = device === 'webgpu' ? 'GPU' : `CPU × ${nWorkers}`;
      setProgress(0.05 + (done / texts.length) * 0.55,
        `Recording narration (${engine}): sentence ${done} of ${texts.length}${eta != null ? ` — about ${fmt(eta)} left` : ''}`);
    }, () => state.cancelled);
    let k = 0;
    for (const e of entries) {
      e.clips = e.sentences.map((text) => {
        const out = audio[k++];
        return { text, samples: out.samples, sampleRate: out.sampleRate };
      });
    }

    // 3. Split into parts and encode
    const parts = planParts(entries, maxLen);
    for (let p = 0; p < parts.length; p++) {
      if (state.cancelled) throw new Error('Cancelled.');
      const base = 0.6 + (p / parts.length) * 0.4;
      const res = await encodePart(parts[p], {
        width: W, height: H, fps: 24, theme: th,
        docTitle: state.doc.title,
        partNo: p + 1, partCount: parts.length,
        captions: $('captions').checked,
        pageMode, pdf: state.doc.pdf,
        onProgress: (f) => setProgress(base + f * (0.4 / parts.length), `Creating video ${p + 1} of ${parts.length}… ${Math.round(f * 100)}%`),
      });
      addResult(res, p + 1, parts.length, parts[p]);
    }
    setProgress(1, `✓ Done — ${parts.length} video${parts.length > 1 ? 's' : ''} created.`);
  } catch (e) {
    console.error(e);
    $('gen-status').className = 'status err';
    $('gen-status').textContent = e.message || String(e);
  } finally {
    state.busy = false;
    $('generate').disabled = false;
    $('build-script').disabled = false;
    $('cancel').classList.add('hidden');
  }
});

function safeName(s) {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'video';
}

function addResult(res, partNo, partCount, part) {
  const url = URL.createObjectURL(res.blob);
  const name = `${safeName(state.doc.title)}${partCount > 1 ? `-part-${partNo}-of-${partCount}` : ''}.mp4`;
  state.results.push({ url, name });
  const first = part.segments[0];
  const last = part.segments[part.segments.length - 1];
  const el = document.createElement('div');
  el.className = 'result';
  el.innerHTML = `
    <video controls preload="metadata" src="${url}"></video>
    <div class="row"><strong>Part ${partNo} of ${partCount}</strong><span class="muted">${fmt(res.duration)} · ${(res.blob.size / 1e6).toFixed(1)} MB</span></div>
    <div class="muted">Slides ${first.label.split(' /')[0]}–${last.label.split(' /')[0]}</div>
    <a class="dl" download="${name}" href="${url}"><button type="button" class="primary" style="width:100%">Download MP4</button></a>`;
  $('results').appendChild(el);
  $('results-card').classList.remove('hidden');
  $('results-note').textContent = res.audioCodec === 'aac'
    ? 'MP4 (H.264 video, AAC audio).'
    : 'MP4 (H.264 video, Opus audio — this browser has no AAC encoder; use Chrome/Edge on Windows or macOS for AAC).';
}

$('download-all').addEventListener('click', async () => {
  for (const r of state.results) {
    const a = document.createElement('a');
    a.href = r.url;
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((res) => setTimeout(res, 600));
  }
});
