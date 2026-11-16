import fs from 'node:fs/promises';
import { config, OPENAI_VOICES, voiceList } from './config.js';
import { UserError } from './extract.js';

const TONES = {
  explainer: 'Speak as a warm, clear guide explaining something important. Measured pace, friendly and confident.',
  advert: 'Speak as the voice of a polished product advert: confident, upbeat and persuasive, with natural emphasis.',
  training: 'Speak as a calm, encouraging trainer giving clear instructions. Steady pace.',
  summary: 'Speak as a composed presenter delivering an executive briefing. Crisp and assured.',
};

async function fail(provider, res) {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 401 || res.status === 403) throw new UserError(`The ${provider} API key is missing or invalid. Check the server's voice settings.`);
  if (res.status === 429) throw new UserError(`${provider} is rate-limiting or out of credit for voice generation. Please try again later.`);
  throw new Error(`${provider} text-to-speech failed (${res.status}): ${body}`);
}

async function openaiSpeech(text, voice, style) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openaiTtsModel,
      voice: OPENAI_VOICES.includes(voice) ? voice : 'coral',
      input: text,
      response_format: 'mp3',
      // "instructions" steers delivery on gpt-4o-mini-tts; the older tts-1 models do not accept it.
      ...(config.openaiTtsModel.startsWith('gpt-4o') ? { instructions: TONES[style] || TONES.explainer } : {}),
    }),
  });
  if (!res.ok) await fail('OpenAI', res);
  return Buffer.from(await res.arrayBuffer());
}

async function elevenSpeech(text, voice) {
  const voices = voiceList();
  const voiceId = voices.some((v) => v.id === voice) ? voice : voices[0]?.id;
  if (!voiceId) throw new UserError('No ElevenLabs voice is configured. Set ELEVENLABS_VOICES on the server.');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: config.elevenModel }),
  });
  if (!res.ok) await fail('ElevenLabs', res);
  return Buffer.from(await res.arrayBuffer());
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (err instanceof UserError || i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
}

/**
 * Narrates every scene. Returns an array of mp3 paths (one per scene), or null when
 * no voice provider is configured (the video is then rendered silent, with captions).
 */
export async function narrate(storyboard, { dir, voice, style, onProgress }) {
  if (config.ttsProvider === 'none') return null;
  const speak = config.ttsProvider === 'elevenlabs' ? elevenSpeech : openaiSpeech;
  const scenes = storyboard.scenes;
  const files = new Array(scenes.length).fill(null);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < scenes.length) {
      const i = next++;
      const text = scenes[i].narration.join(' ').trim();
      if (text) {
        const audio = await withRetry(() => speak(text, voice, style));
        files[i] = `${dir}/scene-${String(i).padStart(3, '0')}.mp3`;
        await fs.writeFile(files[i], audio);
      }
      onProgress?.(++done / scenes.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, scenes.length) }, worker));
  return files;
}
