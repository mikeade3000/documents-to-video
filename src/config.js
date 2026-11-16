import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

const env = process.env;
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

function ttsProvider() {
  const p = (env.TTS_PROVIDER || '').toLowerCase();
  if (p) return p; // openai | elevenlabs | none
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return 'none';
}

export const config = {
  port: int(env.PORT, 3000),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  accessCode: env.ACCESS_CODE || '',

  // Storyboard + script writer
  claudeModel: env.CLAUDE_MODEL || 'claude-opus-5-5',
  claudeEffort: env.CLAUDE_EFFORT || 'high',
  claudeFallbacks: (env.CLAUDE_FALLBACKS || 'on').toLowerCase() !== 'off',

  // Voice-over
  ttsProvider: ttsProvider(),
  openaiTtsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  elevenModel: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
  // "Label:voiceId,Label:voiceId" - voices from your ElevenLabs voice library
  elevenVoices: env.ELEVENLABS_VOICES || 'Rachel:21m00Tcm4TlvDq8ikWAM,Adam:pNInz6obpgDQGcFmaJgB',

  // Rendering
  fps: int(env.FPS, 30),
  renderWorkers: Math.max(1, int(env.RENDER_WORKERS, Math.min(4, Math.max(1, os.cpus().length - 1)))),
  chromiumPath: env.CHROMIUM_PATH || undefined,
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',

  // Limits
  maxFileMb: int(env.MAX_FILE_MB, 25),
  maxFiles: int(env.MAX_FILES, 8),
  maxDocChars: int(env.MAX_DOC_CHARS, 400_000),
  jobsPerHour: int(env.JOBS_PER_HOUR, 6),
  concurrentJobs: Math.max(1, int(env.CONCURRENT_JOBS, 1)),
  keepHours: int(env.KEEP_HOURS, 24),
};

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

export function voiceList() {
  if (config.ttsProvider === 'openai') return OPENAI_VOICES.map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) }));
  if (config.ttsProvider === 'elevenlabs') {
    return config.elevenVoices.split(',').map((pair) => {
      const [label, id] = pair.split(':').map((s) => s.trim());
      return { id: id || label, label };
    }).filter((v) => v.id);
  }
  return [];
}
