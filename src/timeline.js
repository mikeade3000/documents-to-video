// Turns a storyboard plus measured narration lengths into exact scene, caption and reveal timings.

const LEAD = 0.55;   // seconds of visuals before the voice starts in each scene
const TAIL = 0.75;   // breathing room after the voice ends
const MIN_SCENE = 4; // never flash a scene for less than this
const CAPTION_MAX = 105;

const round = (n) => Math.round(n * 1000) / 1000;

/** Rough speaking time, used when no voice provider is configured. */
export const estimateSpeech = (text) => Math.max(1.2, text.split(/\s+/).filter(Boolean).length / 2.55 + (text.match(/[.!?]/g) || []).length * 0.25);

/** Splits a long sentence into caption-sized chunks at natural pauses. */
function captionChunks(sentence) {
  if (sentence.length <= CAPTION_MAX) return [sentence];
  const words = sentence.split(' ');
  const parts = Math.ceil(sentence.length / CAPTION_MAX);
  const target = sentence.length / parts;
  const chunks = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    const atPause = /[,;:—-]$/.test(cur);
    if (cur && chunks.length < parts - 1 && (next.length > target + 14 || (atPause && cur.length > target - 22))) {
      chunks.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** @param speechDurations seconds of audio per scene (null entries are estimated) */
export function buildTimeline(storyboard, speechDurations, fps = 30) {
  let t = 0;
  const scenes = storyboard.scenes.map((s, i) => {
    const text = s.narration.join(' ');
    const speech = text ? (speechDurations?.[i] ?? estimateSpeech(text)) : 0;
    const itemCount = s.type === 'comparison' ? Math.max(s.comparison.leftPoints.length, s.comparison.rightPoints.length) * 2 : s.items.length;
    const dur = Math.max(MIN_SCENE, LEAD + speech + TAIL, 1.6 + itemCount * 0.5);

    // Sentence timings, proportional to length (a small constant models the pause between sentences).
    const weights = s.narration.map((n) => n.length + 14);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = LEAD;
    const sentences = [];
    const captions = [];
    s.narration.forEach((n, k) => {
      const d = (speech * weights[k]) / total;
      sentences.push({ start: round(acc), end: round(acc + d) });
      const chunks = captionChunks(n);
      const chars = chunks.reduce((a, c) => a + c.length, 0) || 1;
      let cAcc = acc;
      for (const c of chunks) {
        const cd = (d * c.length) / chars;
        captions.push({ text: c, start: round(cAcc), end: round(cAcc + cd) });
        cAcc += cd;
      }
      acc += d;
    });

    // When each item appears: at its narration cue, otherwise spread across the scene.
    const n = s.items.length;
    const spread = n ? Math.min(1.5, Math.max(0.35, (speech * 0.72) / n)) : 0;
    let prev = 0.75;
    const itemAt = s.items.map((it, k) => {
      let at = it.cue >= 0 && sentences[it.cue] ? sentences[it.cue].start + 0.12 : 1.0 + k * spread;
      at = Math.min(Math.max(at, prev + 0.28), Math.max(1.0, dur - 1.1));
      prev = at;
      return round(at);
    });

    const scene = { start: round(t), dur: round(dur), audioAt: round(t + LEAD), captions, itemAt };
    t += dur;
    return scene;
  });
  const frames = Math.ceil(t * fps);
  return { fps, duration: round(frames / fps), frames, scenes };
}
