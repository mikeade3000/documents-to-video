import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { ICON_NAMES } from './icons.js';
import { THEMES, THEME_IDS } from './themes.js';
import { UserError } from './extract.js';

export const SCENE_TYPES = ['title', 'bullets', 'cards', 'steps', 'stats', 'statement', 'comparison', 'mockup', 'image', 'outro'];

export const LENGTHS = {
  short: { label: 'Short (about 1 minute)', scenes: '5 to 7', words: '130 to 170' },
  standard: { label: 'Standard (about 2 minutes)', scenes: '9 to 12', words: '280 to 340' },
  detailed: { label: 'Detailed (about 4 minutes)', scenes: '14 to 20', words: '560 to 680' },
};

export const STYLES = {
  explainer: 'An explainer that walks the viewer through the material step by step, the way a patient guide would.',
  advert: 'A product advert: open on the problem the audience feels, reveal the product, show what it does, prove it, and close on a call to action.',
  training: 'A training or onboarding video: tell people exactly what to do, in order, with practical tips and the mistakes to avoid.',
  summary: 'An executive summary: the few findings and numbers that matter, and what they mean.',
};

const str = { type: 'string' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'brand', 'theme', 'scenes'],
  properties: {
    title: str,
    brand: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'tagline', 'icon', 'footer'],
      properties: { name: str, tagline: str, icon: { type: 'string', enum: ICON_NAMES }, footer: str },
    },
    theme: { type: 'string', enum: THEME_IDS },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'chapter', 'eyebrow', 'heading', 'body', 'icon', 'items', 'note', 'narration'],
        properties: {
          type: { type: 'string', enum: SCENE_TYPES },
          chapter: str,
          eyebrow: str,
          heading: str,
          body: str,
          icon: { type: 'string', enum: ICON_NAMES },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'text', 'icon', 'value', 'cue'],
              properties: { title: str, text: str, icon: { type: 'string', enum: ICON_NAMES }, value: str, cue: { type: 'integer' } },
            },
          },
          note: str,
          narration: { type: 'array', items: str },
          comparison: {
            type: 'object',
            additionalProperties: false,
            required: ['leftTitle', 'leftPoints', 'rightTitle', 'rightPoints'],
            properties: { leftTitle: str, leftPoints: { type: 'array', items: str }, rightTitle: str, rightPoints: { type: 'array', items: str } },
          },
          mockup: {
            type: 'object',
            additionalProperties: false,
            required: ['device', 'url', 'title', 'subtitle', 'fields', 'button'],
            properties: {
              device: { type: 'string', enum: ['browser', 'laptop', 'phone'] },
              url: str,
              title: str,
              subtitle: str,
              fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: str, value: str } } },
              button: str,
            },
          },
          cta: { type: 'object', additionalProperties: false, required: ['text', 'url'], properties: { text: str, url: str } },
          assetId: str,
        },
      },
    },
  },
};

const SYSTEM = `You write storyboards for narrated motion-graphics videos: the kind of polished explainer or product advert an organisation publishes for candidates, customers or staff. Your storyboard is rendered automatically, so the viewer sees exactly the on-screen text you write and hears exactly the narration you write, read aloud by a text-to-speech voice.

What makes these videos good
- The narration carries the story and the screen supports it. On-screen text is short: a heading a viewer can read at a glance, and items of a few words each. Full sentences belong in the narration.
- Each scene makes one point. The video has an arc: an opening that tells the viewer why this matters to them, a middle that delivers the substance in a logical order, and a close that says what to do next.
- Everything stated comes from the source material or the user's description. Never invent facts, figures, names, dates, prices, URLs or contact details. If the material gives no number, do not use a stats scene; if it gives no web address, leave url fields empty.
- Narration is written for the ear: plain words, short sentences, spoken numbers and symbols written the way they should be said. Address the viewer directly. Do not describe the visuals ("on screen you can see") and do not use stage directions.
- Write in the language of the source material unless the user asks for another.

Scene types and the fields each one uses (leave unused string fields as "" and unused arrays empty)
- title: the opening. eyebrow (small label), heading, body (one subtitle line), items (0 to 4 short pills, title only), icon.
- bullets: heading plus 2 to 5 items (title only, a few words each) beside a large icon. Optional body line above the items, optional note below.
- cards: a checklist or feature grid. 3 to 6 items, each with icon, title (2 to 4 words) and text (one short line). Optional note shown as a highlighted tip.
- steps: a numbered process. 3 to 5 items, each with title (the step name), text (one sentence shown while that step is active) and icon.
- stats: 1 to 3 items, each with value (the figure, such as "9 in 10" or "50%") and title (what it measures). note carries the source of the figures.
- statement: one bold line in the centre of the screen, for a turning point or a promise. heading, optional body.
- comparison: two columns contrasting before and after, or without and with. Fill the comparison object; 2 to 4 points per side.
- mockup: a stylised device showing a simple screen, for "open this page" or "sign in here" moments. Fill the mockup object (device, url, title, subtitle, up to 3 fields with a label and example value, button label). heading and body sit beside the device.
- image: shows one of the user's uploaded images in a frame. Set assetId to the image's id. heading, optional note as a short caption label. Use only when images were uploaded and one genuinely illustrates the point.
- outro: the close. heading (usually the product or organisation name), body, items (0 to 4 pills), and cta with a text and url when the material provides one.

Field rules
- Wrap the one or two words to emphasise in a heading with asterisks, like "A promise to *every student*". Asterisks work in heading, body and item titles; use them sparingly.
- chapter: a label of one to three words for the progress bar. Consecutive scenes on the same topic share the same chapter label. Aim for 5 to 10 distinct chapters.
- narration: an array of sentences, in order. Each sentence becomes one caption line, so keep each under 160 characters.
- items[].cue: the zero-based index of the narration sentence during which that item should appear, so items arrive as the voice mentions them. Use -1 to let the renderer space them evenly.
- items[].value is only for stats scenes. Always give every item an icon that fits its meaning.
- brand: name is the product or organisation shown in the corner of every scene, tagline a few words under it, icon a fitting mark, footer an optional small credit or copyright line (empty unless the material supplies one).
- theme: choose the palette that suits the brand and subject unless the user specified one.

Vary the scene types so the video does not feel like a slide deck, and start with a title scene and end with an outro scene.`;

function buildUserContent({ documents, pdfs, images, prompt, options }) {
  const content = [];
  for (const p of pdfs) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.base64 }, title: p.name });
  }
  for (const img of images) {
    if (!img.base64) continue;
    content.push({ type: 'text', text: `Uploaded image id "${img.id}" (${img.name}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  const parts = [];
  for (const d of documents) parts.push(`<document name="${d.name.replace(/"/g, "'")}">\n${d.text}\n</document>`);
  const len = LENGTHS[options.length] || LENGTHS.standard;
  const brief = [
    `Video style: ${STYLES[options.style] || STYLES.explainer}`,
    `Target length: ${len.scenes} scenes and ${len.words} words of narration in total.`,
    options.theme && options.theme !== 'auto' ? `Theme: use "${options.theme}".` : 'Theme: choose the best fit.',
    options.brand ? `Brand name to show: ${options.brand}` : '',
    images.length
      ? `Uploaded images available for image scenes: ${images.map((i) => `${i.id} (${i.name})`).join(', ')}.`
      : 'No images were uploaded, so do not use image scenes.',
  ].filter(Boolean).join('\n');
  parts.push(`<brief>\n${brief}\n</brief>`);
  if (prompt) parts.push(`<user_request>\n${prompt}\n</user_request>`);
  const hasSource = documents.length || pdfs.length;
  parts.push(hasSource
    ? 'Write the storyboard for a video based on the documents above, following the brief and the user request.'
    : 'No document was uploaded. Write the storyboard for the video the user describes in the request, following the brief. Stay with what the user told you and with safely general statements; do not make up specific facts about their product or organisation.');
  content.push({ type: 'text', text: parts.join('\n\n') });
  return content;
}

/** Asks Claude to turn the source material into a storyboard, then validates and tidies it. */
export async function writeStoryboard(input) {
  const client = new Anthropic();
  const request = {
    model: config.claudeModel,
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { effort: config.claudeEffort, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: buildUserContent(input) }],
  };
  let message;
  try {
    // Server-side fallback lets another Claude model answer if a safety classifier declines the request.
    message = config.claudeFallbacks
      ? await client.beta.messages.stream({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
      : await client.messages.stream(request).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new UserError('The Claude API key is missing or invalid. Set ANTHROPIC_API_KEY on the server.');
    if (err instanceof Anthropic.RateLimitError) throw new UserError('The Claude API is rate-limiting this server right now. Please try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new Error(`Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
  if (message.stop_reason === 'refusal') throw new UserError('The request was declined by the AI safety filters. Please adjust the document or description and try again.');
  if (message.stop_reason === 'max_tokens') throw new Error('The storyboard was cut off before it finished. Try the shorter length setting.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('The storyboard writer returned malformed JSON.'); }
  return normalizeStoryboard(raw, input);
}

const clean = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanIcon = (v, d = 'sparkles') => (ICON_NAMES.includes(v) ? v : d);
const ITEM_LIMITS = { title: 4, bullets: 5, cards: 6, steps: 5, stats: 3, statement: 0, comparison: 0, mockup: 3, image: 0, outro: 4 };

/** Makes any storyboard (from Claude or hand-written JSON) safe for the renderer. */
export function normalizeStoryboard(raw, { images = [], options = {} } = {}) {
  const imageIds = new Set(images.map((i) => i.id));
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : []).map((s) => {
    let type = SCENE_TYPES.includes(s.type) ? s.type : 'bullets';
    if (type === 'image' && !imageIds.has(s.assetId)) type = 'statement';
    if (type === 'comparison' && !s.comparison) type = 'bullets';
    if (type === 'mockup' && !s.mockup) type = 'bullets';
    const narration = (Array.isArray(s.narration) ? s.narration : [s.narration]).map((n) => clean(n, 600).replace(/\*/g, '')).filter(Boolean);
    const scene = {
      type,
      chapter: clean(s.chapter, 28),
      eyebrow: clean(s.eyebrow, 60),
      heading: clean(s.heading, 140),
      body: clean(s.body, 220),
      icon: cleanIcon(s.icon),
      note: clean(s.note, 200),
      narration,
      items: (Array.isArray(s.items) ? s.items : []).slice(0, ITEM_LIMITS[type]).map((it) => ({
        title: clean(it.title, 90),
        text: clean(it.text, 160),
        icon: cleanIcon(it.icon, 'check'),
        value: clean(it.value, 16),
        cue: Number.isInteger(it.cue) && it.cue >= 0 && it.cue < narration.length ? it.cue : -1,
      })).filter((it) => it.title || it.value),
    };
    if (type === 'comparison') {
      scene.comparison = {
        leftTitle: clean(s.comparison.leftTitle, 40),
        rightTitle: clean(s.comparison.rightTitle, 40),
        leftPoints: (s.comparison.leftPoints || []).slice(0, 4).map((p) => clean(p, 90)).filter(Boolean),
        rightPoints: (s.comparison.rightPoints || []).slice(0, 4).map((p) => clean(p, 90)).filter(Boolean),
      };
    }
    if (type === 'mockup') {
      scene.mockup = {
        device: ['browser', 'laptop', 'phone'].includes(s.mockup.device) ? s.mockup.device : 'browser',
        url: clean(s.mockup.url, 60),
        title: clean(s.mockup.title, 50),
        subtitle: clean(s.mockup.subtitle, 80),
        fields: (s.mockup.fields || []).slice(0, 3).map((f) => ({ label: clean(f.label, 30), value: clean(f.value, 36) })),
        button: clean(s.mockup.button, 28),
      };
    }
    if (type === 'image') scene.assetId = s.assetId;
    if (s.cta && (s.cta.text || s.cta.url)) scene.cta = { text: clean(s.cta.text, 60), url: clean(s.cta.url, 80) };
    return scene;
  }).filter((s) => s.heading || s.narration.length);

  if (!scenes.length) throw new Error('The storyboard came back empty.');
  let lastChapter = 'Intro';
  for (const s of scenes) { if (!s.chapter) s.chapter = lastChapter; lastChapter = s.chapter; }

  const theme = options.theme && options.theme !== 'auto' && THEMES[options.theme] ? options.theme : (THEMES[raw.theme] ? raw.theme : 'navy-gold');
  return {
    title: clean(raw.title, 120) || scenes[0].heading.replace(/\*/g, ''),
    brand: {
      name: clean(options.brand || raw.brand?.name, 48),
      tagline: clean(raw.brand?.tagline, 48),
      icon: cleanIcon(raw.brand?.icon, 'sparkles'),
      footer: clean(raw.brand?.footer, 160),
    },
    theme,
    scenes,
  };
}
