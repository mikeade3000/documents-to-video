/*
 * Scene player. Draws every scene of a storyboard on a 1920x1080 stage and exposes seek(t),
 * a pure function of time. The same code powers the live preview (driven by the audio clock)
 * and the MP4 render (driven frame by frame by the server).
 */
(async function () {
  const qs = new URLSearchParams(location.search);
  const jobId = qs.get('job');
  const RENDER = qs.get('render') === '1';
  const api = (p) => `/api/jobs/${jobId}/${p}`;

  const res = await fetch(api('player.json'));
  if (!res.ok) { document.body.textContent = 'This preview is not available.'; return; }
  const DATA = await res.json();
  const { storyboard: SB, timeline: TL, icons: ICONS } = DATA;

  // ---------- helpers ----------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const easeBack = (p) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) rich(n, text);
    return n;
  }
  /** Sets text, turning *marked* words into accent-coloured spans. Never uses innerHTML for content. */
  function rich(node, text) {
    node.textContent = '';
    String(text || '').split(/\*([^*]+)\*/).forEach((part, i) => {
      if (!part) return;
      if (i % 2) { const s = document.createElement('span'); s.className = 'hl'; s.textContent = part; node.append(s); }
      else node.append(document.createTextNode(part));
    });
    return node;
  }
  /** Icons are trusted SVG markup that the server reads from its own icon package. */
  function icon(name, cls) {
    const d = document.createElement('div');
    d.className = 'ico ' + (cls || '');
    d.innerHTML = ICONS[name] || ICONS.sparkles || '';
    return d;
  }
  const add = (parent, ...kids) => { parent.append(...kids.filter(Boolean)); return parent; };

  // ---------- stage ----------
  const root = document.documentElement;
  for (const [k, v] of Object.entries(DATA.theme.vars)) root.style.setProperty('--' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), v);
  if (DATA.theme.light) root.classList.add('light');
  if (RENDER) root.classList.add('render');

  const stage = document.getElementById('stage');
  add(stage, el('div', 'bg'), el('div', 'bg-glow'), el('div', 'bg-grid'));

  // Brand mark (top left) and scene counter (top right)
  const logoUrl = DATA.logo ? api('assets/' + DATA.logo) : null;
  function brandMark(cls) {
    const m = el('div', 'mark ' + (cls || ''));
    if (logoUrl) { const img = new Image(); img.src = logoUrl; m.classList.add('has-logo'); m.append(img); }
    else m.append(icon(SB.brand.icon));
    return m;
  }
  const chrome = el('div', 'chrome');
  const brand = add(el('div', 'brand'), brandMark(), add(el('div', 'brand-text'), el('div', 'brand-name', SB.brand.name), SB.brand.tagline ? el('div', 'brand-tag', SB.brand.tagline) : null));
  const counterLabel = el('div', 'counter-label');
  const counterNum = el('div', 'counter-num');
  add(chrome, SB.brand.name ? brand : null, add(el('div', 'counter'), counterLabel, counterNum));
  stage.append(chrome);

  // ---------- scenes ----------
  // Each builder registers timed animations with A(element, startSeconds, kind, duration).
  function buildScene(s, tl, index) {
    const node = el('section', `scene scene-${s.type}`);
    const anims = [];
    const ticks = []; // custom time-driven updates; each returns a signature fragment
    const A = (n, at, kind = 'up', dur = 0.6) => { anims.push({ n, at, kind, dur }); return n; };
    const at = (k) => tl.itemAt[k] ?? 1 + k * 0.5;
    const eyebrow = () => (s.eyebrow ? A(el('div', 'eyebrow', s.eyebrow), 0.1, 'up', 0.5) : null);
    const heading = (cls = '') => A(el('h1', 'heading ' + cls, s.heading), 0.22, 'up', 0.7);
    const body = (t0 = 0.5) => (s.body ? A(el('p', 'body', s.body), t0, 'up', 0.6) : null);
    const last = () => (s.items.length ? at(s.items.length - 1) + 0.6 : 1.2);
    const pills = (t0) => (s.items.length ? add(el('div', 'pills'), ...s.items.map((it, k) => A(add(el('div', 'pill'), icon(it.icon), el('span', '', it.title)), Math.max(t0, at(k)), 'pop', 0.5))) : null);

    const B = {
      title() {
        const badge = A(brandMark('badge'), 0.05, 'pop', 0.7);
        add(node, add(el('div', 'center'), badge, s.eyebrow ? A(el('div', 'eyebrow chip', s.eyebrow), 0.3, 'up', 0.5) : null, A(el('h1', 'heading hero', s.heading), 0.45, 'up', 0.8), s.body ? A(el('p', 'body', s.body), 0.8, 'up', 0.6) : null, pills(1.2)));
      },
      outro() {
        const badge = A(brandMark('badge'), 0.05, 'pop', 0.7);
        let cta = null;
        if (s.cta) {
          cta = A(add(el('div', 'cta'), s.cta.text ? el('div', 'cta-text', s.cta.text) : null, s.cta.url ? el('div', 'cta-url', s.cta.url) : null), Math.max(1.4, last()), 'pop', 0.6);
        }
        add(node, add(el('div', 'center'), badge, pills(0.9), s.eyebrow ? A(el('div', 'eyebrow', s.eyebrow), 0.3, 'up', 0.5) : null, A(el('h1', 'heading hero', s.heading), 0.4, 'up', 0.8), s.body ? A(el('p', 'body', s.body), 0.7, 'up', 0.6) : null, cta));
      },
      bullets() {
        const list = el('ul', 'bullets');
        s.items.forEach((it, k) => list.append(A(add(el('li'), icon('check', 'tick'), el('span', '', it.title)), at(k), 'left', 0.55)));
        const art = A(add(el('div', 'art'), el('div', 'art-ring'), el('div', 'art-ring r2'), icon(s.icon, 'art-icon')), 0.35, 'pop', 0.9);
        add(node, add(el('div', 'split'), add(el('div', 'col-text'), eyebrow(), heading(), body(), list, s.note ? A(el('p', 'note', s.note), last(), 'fade', 0.6) : null), add(el('div', 'col-art'), art)));
      },
      cards() {
        const grid = el('div', 'grid cols-' + (s.items.length <= 4 && s.items.length !== 3 ? 2 : 3));
        s.items.forEach((it, k) => {
          const check = A(icon('check', 'card-check'), at(k) + 0.45, 'pop', 0.4);
          grid.append(A(add(el('div', 'card'), icon(it.icon, 'card-ico'), add(el('div', 'card-text'), el('div', 'card-title', it.title), it.text ? el('div', 'card-sub', it.text) : null), check), at(k), 'up', 0.55));
        });
        const tip = s.note ? A(add(el('div', 'tip'), icon('lightbulb'), el('span', '', s.note)), last(), 'up', 0.6) : null;
        add(node, add(el('div', 'stack'), eyebrow(), heading('md'), body(), grid, tip));
      },
      steps() {
        const list = el('ol', 'steps');
        const panels = el('div', 'step-panels');
        const rows = s.items.map((it, k) => {
          const num = add(el('div', 'step-num'), el('span', '', String(k + 1)), icon('check'));
          const row = A(add(el('li'), num, el('span', 'step-title', it.title)), 0.5 + k * 0.12, 'left', 0.5);
          list.append(row);
          const panel = add(el('div', 'step-panel'), icon(it.icon, 'step-ico'), el('div', 'step-k', `Step ${k + 1} of ${s.items.length}`), el('div', 'step-h', it.title), it.text ? el('div', 'step-t', it.text) : null);
          panels.append(panel);
          return { row, panel };
        });
        ticks.push((t) => {
          let active = -1;
          for (let k = 0; k < rows.length; k++) if (t >= at(k)) active = k;
          let sig = 'st' + active;
          rows.forEach((r, k) => {
            r.row.classList.toggle('active', k === active);
            r.row.classList.toggle('done', k < active);
            // Panels cross-fade as the active step changes.
            const start = at(k);
            const end = k + 1 < rows.length ? at(k + 1) : Infinity;
            const pin = clamp((t - start) / 0.45);
            const pout = clamp((t - end) / 0.3);
            const o = easeOut(pin) * (1 - pout);
            r.panel.style.opacity = o.toFixed(3);
            r.panel.style.transform = `translateY(${((1 - easeOut(pin)) * 30).toFixed(1)}px)`;
            if (o > 0 && o < 1) sig += ':' + o.toFixed(3);
          });
          return sig;
        });
        add(node, add(el('div', 'split'), add(el('div', 'col-text narrow'), eyebrow(), heading('md'), list), add(el('div', 'col-art wide'), panels)));
      },
      stats() {
        const row = el('div', 'stats');
        s.items.forEach((it, k) => row.append(A(add(el('div', 'stat'), el('div', 'stat-value', it.value || it.title), it.value ? el('div', 'stat-label', it.title) : null, it.text ? el('div', 'stat-sub', it.text) : null), at(k), 'pop', 0.65)));
        add(node, add(el('div', 'stack'), eyebrow(), heading('md'), body(), row), s.note ? A(el('p', 'source', s.note), last(), 'fade', 0.6) : null);
      },
      statement() {
        add(node, add(el('div', 'center'), s.eyebrow ? A(el('div', 'eyebrow', s.eyebrow), 0.1, 'up', 0.5) : null, A(el('h1', 'heading statement', s.heading), 0.25, 'up', 0.9), A(el('div', 'rule'), 0.8, 'grow', 0.7), s.body ? A(el('p', 'body', s.body), 1.0, 'up', 0.6) : null));
      },
      comparison() {
        const c = s.comparison;
        const col = (cls, title, points, ico, t0, step) => {
          const ul = el('ul');
          points.forEach((p, k) => ul.append(A(add(el('li'), icon(ico), el('span', '', p)), t0 + k * step, 'up', 0.5)));
          return A(add(el('div', 'vs-col ' + cls), el('div', 'vs-title', title), ul), t0 - 0.35, 'up', 0.6);
        };
        const span = Math.max(1.2, tl.dur - 3.2);
        const n = Math.max(1, c.leftPoints.length + c.rightPoints.length);
        const step = Math.min(0.9, span / n);
        const leftT = 1.0;
        const rightT = leftT + c.leftPoints.length * step + 0.3;
        add(node, add(el('div', 'stack'), eyebrow(), heading('md'), add(el('div', 'vs'), col('before', c.leftTitle, c.leftPoints, 'x', leftT, step), A(icon('play', 'vs-arrow'), rightT - 0.5, 'pop', 0.5), col('after', c.rightTitle, c.rightPoints, 'check', rightT, step))));
      },
      mockup() {
        const m = s.mockup;
        const screen = el('div', 'screen');
        const form = el('div', 'form');
        const t0 = 1.0;
        add(form, A(brandMark('form-mark'), t0, 'pop', 0.45), m.title ? A(el('div', 'form-title', m.title), t0 + 0.1, 'up', 0.45) : null, m.subtitle ? A(el('div', 'form-sub', m.subtitle), t0 + 0.2, 'up', 0.45) : null);
        const fieldSpan = Math.max(1, tl.dur - t0 - 2.4);
        const per = m.fields.length ? Math.min(1.8, fieldSpan / m.fields.length) : 0;
        m.fields.forEach((f, k) => {
          const input = el('div', 'input');
          const typed = el('span', 'typed');
          input.append(typed, el('i', 'caret'));
          form.append(A(add(el('div', 'field'), el('label', '', f.label), input), t0 + 0.3 + k * 0.1, 'up', 0.45));
          const start = t0 + 0.9 + k * per;
          const len = Math.min(per * 0.6, 0.9);
          ticks.push((t) => {
            const count = Math.round(clamp((t - start) / len) * f.value.length);
            typed.textContent = f.value.slice(0, count);
            input.classList.toggle('focus', t >= start && t < start + per);
            return 'ty' + count + (t >= start && t < start + per ? 'f' : '');
          });
        });
        const pressAt = t0 + 0.9 + m.fields.length * per + 0.2;
        if (m.button) {
          const btn = A(el('div', 'button', m.button), t0 + 0.4 + m.fields.length * 0.1, 'up', 0.45);
          form.append(btn);
          ticks.push((t) => { const on = t >= pressAt && t < pressAt + 0.35; btn.classList.toggle('pressed', on); return on ? 'bp' : ''; });
        }
        screen.append(form);
        let device;
        if (m.device === 'phone') device = add(el('div', 'device phone'), el('div', 'notch'), screen);
        else {
          const bar = add(el('div', 'bar'), el('i'), el('i'), el('i'), add(el('div', 'url'), icon('lock'), el('span', '', m.url || '')));
          device = add(el('div', 'device ' + m.device), add(el('div', 'frame'), bar, screen), m.device === 'laptop' ? el('div', 'base') : null);
        }
        const list = s.items.length ? el('ul', 'bullets small') : null;
        s.items.forEach((it, k) => list.append(A(add(el('li'), icon('check', 'tick'), el('span', '', it.title)), at(k), 'left', 0.5)));
        add(node, add(el('div', 'split'), add(el('div', 'col-text narrow'), eyebrow(), heading('md'), body(), list), add(el('div', 'col-art wide'), A(device, 0.4, 'up', 0.8))));
      },
      image() {
        const img = new Image();
        img.src = api('assets/' + DATA.assets[s.assetId]);
        const frame = A(add(el('div', 'shot'), img, s.note ? add(el('div', 'shot-label'), el('i'), el('span', '', s.note)) : null), 0.5, 'up', 0.8);
        add(node, add(el('div', 'stack tight'), eyebrow(), heading('sm'), frame));
      },
    };
    (B[s.type] || B.bullets)();
    if (SB.brand.footer) node.append(el('div', 'footer', SB.brand.footer));
    return { node, anims, ticks, index };
  }

  const scenes = SB.scenes.map((s, i) => buildScene(s, TL.scenes[i], i));
  const sceneLayer = el('div', 'scenes');
  scenes.forEach((sc) => sceneLayer.append(sc.node));
  stage.append(sceneLayer);

  // Captions and chapter bar
  const caption = el('div', 'caption');
  const captionText = el('span');
  caption.append(captionText);
  const chapters = [];
  SB.scenes.forEach((s, i) => { if (!chapters.length || chapters[chapters.length - 1].label !== s.chapter) chapters.push({ label: s.chapter, from: i }); });
  const chapterBar = el('div', 'chapters');
  const showChapters = chapters.length >= 3 && chapters.length <= 12;
  if (showChapters) chapters.forEach((c) => { c.node = el('div', 'chapter', c.label); chapterBar.append(c.node); });
  else root.classList.add('no-chapters');
  if (DATA.captions) stage.append(caption);
  stage.append(chapterBar);

  // ---------- time ----------
  const XF = 0.45; // cross-fade between scenes, seconds
  const pad2 = (n) => String(n).padStart(2, '0');
  let shownCaption = null;
  let shownScene = -1;

  function applyAnim(a, t) {
    const p = clamp((t - a.at) / a.dur);
    const e = easeOut(p);
    const st = a.n.style;
    switch (a.kind) {
      case 'fade': st.opacity = e; break;
      case 'left': st.opacity = clamp(p * 1.8); st.transform = `translateX(${(e - 1) * 48}px)`; break;
      case 'pop': st.opacity = clamp(p * 2.2); st.transform = `scale(${0.55 + 0.45 * easeBack(p)})`; break;
      case 'grow': st.opacity = p > 0 ? 1 : 0; st.transform = `scaleX(${e})`; break;
      default: st.opacity = clamp(p * 1.8); st.transform = `translateY(${(1 - e) * 38}px)`;
    }
    return p > 0 && p < 1 ? p.toFixed(3) : '';
  }

  /** Puts the whole stage in its state at time t. Returns a signature that changes only when a pixel could. */
  function seek(t) {
    t = clamp(t, 0, TL.duration);
    let cur = 0;
    for (let i = 0; i < TL.scenes.length; i++) if (t >= TL.scenes[i].start) cur = i;
    const local = t - TL.scenes[cur].start;
    const fade = cur > 0 ? clamp(local / XF) : 1;
    let sig = cur + '|' + (fade < 1 ? fade.toFixed(3) : '');

    scenes.forEach((sc, i) => {
      const visible = i === cur || (i === cur - 1 && fade < 1);
      sc.node.style.display = visible ? '' : 'none';
      if (!visible) return;
      sc.node.style.opacity = i === cur ? easeOut(fade) : 1 - easeOut(fade);
      const lt = t - TL.scenes[i].start;
      for (const a of sc.anims) sig += applyAnim(a, lt) + ',';
      for (const tick of sc.ticks) sig += tick(lt) + ',';
    });

    if (cur !== shownScene) {
      shownScene = cur;
      counterLabel.textContent = SB.scenes[cur].chapter;
      counterNum.textContent = `${pad2(cur + 1)} / ${pad2(SB.scenes.length)}`;
      let active = 0;
      chapters.forEach((c, k) => { if (cur >= c.from) active = k; });
      if (showChapters) chapters.forEach((c, k) => { c.node.classList.toggle('active', k === active); c.node.classList.toggle('done', k < active); });
      const kind = SB.scenes[cur].type;
      chrome.classList.toggle('quiet', kind === 'title' || kind === 'outro');
    }

    const cap = TL.scenes[cur].captions.find((c) => local >= c.start - 0.05 && local < c.end + 0.25) || null;
    if (cap !== shownCaption) {
      shownCaption = cap;
      captionText.textContent = cap ? cap.text : '';
      caption.classList.toggle('on', !!cap);
    }
    return sig + '|' + (cap ? cap.start : '');
  }

  // Wait for fonts and images so the first rendered frame is complete.
  await document.fonts.load('800 40px "Plus Jakarta Sans Variable"').catch(() => {});
  await document.fonts.load('500 20px "Inter Variable"').catch(() => {});
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
  seek(0);

  if (RENDER) {
    window.__seek = seek;
    window.__ready = true;
    return;
  }

  // ---------- live preview ----------
  const fit = () => { const k = Math.min(innerWidth / 1920, (innerHeight - 44) / 1080); stage.style.transform = `scale(${k})`; stage.style.left = `${(innerWidth - 1920 * k) / 2}px`; stage.style.top = `${(innerHeight - 44 - 1080 * k) / 2}px`; };
  addEventListener('resize', fit);
  fit();

  const audio = DATA.hasAudio ? new Audio(api('narration.m4a')) : null;
  const bar = document.getElementById('controls');
  const playBtn = document.getElementById('play');
  const scrub = document.getElementById('scrub');
  const time = document.getElementById('time');
  bar.hidden = false;
  scrub.max = TL.duration;
  let playing = false;
  let t = 0;
  let lastTick = 0;
  const fmt = (s) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
  function show() { seek(t); scrub.value = t; time.textContent = `${fmt(t)} / ${fmt(TL.duration)}`; }
  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    if (audio) { if (on) { audio.currentTime = Math.min(t, audio.duration || t); audio.play().catch(() => {}); } else audio.pause(); }
    lastTick = performance.now();
    if (on) requestAnimationFrame(loop);
  }
  function loop(now) {
    if (!playing) return;
    // The audio clock is the source of truth while it runs; otherwise use wall time.
    if (audio && !audio.paused && !audio.ended) t = audio.currentTime;
    else t += (now - lastTick) / 1000;
    lastTick = now;
    if (t >= TL.duration) { t = TL.duration; show(); setPlaying(false); return; }
    show();
    requestAnimationFrame(loop);
  }
  const toggle = () => { if (!playing && t >= TL.duration) t = 0; setPlaying(!playing); };
  playBtn.addEventListener('click', toggle);
  stage.addEventListener('click', toggle);
  scrub.addEventListener('input', () => { t = parseFloat(scrub.value); if (audio) audio.currentTime = t; show(); });
  show();
})();
