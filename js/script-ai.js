// Optional: use Claude to turn the extracted document content + the user's instructions
// into a polished narration script. The API key stays in the browser and is sent only to Anthropic.

import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm';

const SCHEMA = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          narration: { type: 'string' },
        },
        required: ['index', 'title', 'bullets', 'narration'],
        additionalProperties: false,
      },
    },
  },
  required: ['slides'],
  additionalProperties: false,
};

const SYSTEM = `You write voice-over scripts for narrated slide videos made from documents.
You receive the slides of one document (extracted text, and speaker notes where they exist) plus the user's instructions.
For every slide return:
- title: a short slide heading (keep the original unless the instructions say otherwise),
- bullets: 2 to 6 short on-screen points (under 12 words each) taken from the slide,
- narration: what the narrator says while the slide is on screen.
Narration rules: write it to be spoken aloud — natural, clear sentences, no markdown, no bullet symbols, no URLs read out character by character, numbers written the way they are said when that helps. Do not say "this slide" or "next slide" repeatedly. Stay faithful to the document's facts.
Return exactly one entry per input slide, with the same index values, in the same order. Follow the user's instructions about tone, audience, level of detail, language and length.`;

export async function writeScriptWithClaude({ apiKey, doc, instructions, wordsPerMinute, maxPartSeconds }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const slides = doc.slides.map((s, index) => ({
    index,
    title: s.title,
    text: s.text.slice(0, 6000),
    speaker_notes: s.notes || undefined,
  }));
  const user = [
    `Document: ${doc.title} (${doc.kind.toUpperCase()}, ${slides.length} slides)`,
    `Narration pace is about ${wordsPerMinute} words per minute. The video is cut into parts of at most ${Math.round(maxPartSeconds / 60 * 10) / 10} minutes each, so long documents simply produce more parts.`,
    `User instructions:\n${instructions.trim() || '(none — narrate the content clearly and faithfully)'}`,
    `Slides (JSON):\n${JSON.stringify(slides)}`,
  ].join('\n\n');

  const stream = client.beta.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined to write this script${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : '.'}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new Error('The document is too long for one script request. Try splitting the file.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  const byIndex = new Map(data.slides.map((s) => [s.index, s]));
  return doc.slides.map((s, i) => {
    const r = byIndex.get(i);
    return r ? { title: r.title || s.title, bullets: r.bullets?.length ? r.bullets : s.bullets, narration: r.narration } : null;
  });
}

export function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check the key and try again.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use the model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limit reached on the Anthropic API. Wait a minute and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? 'unknown'}): ${err.message}`;
  return String(err?.message || err);
}
