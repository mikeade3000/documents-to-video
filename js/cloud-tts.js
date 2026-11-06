// Cloud voices: Google Cloud Text-to-Speech and Microsoft Azure Speech.
// The text is sent to the provider, which returns finished audio in about a second per sentence.
// Several sentences are requested at the same time, so a long document is recorded in under a minute.

export const CLOUD_VOICES = {
  google: {
    female: [
      { id: 'en-US-Neural2-F', label: 'Neural2 F — American' },
      { id: 'en-US-Neural2-H', label: 'Neural2 H — American' },
      { id: 'en-US-Studio-O', label: 'Studio O — American (premium)' },
      { id: 'en-GB-Neural2-A', label: 'Neural2 A — British' },
      { id: 'en-AU-Neural2-C', label: 'Neural2 C — Australian' },
      { id: 'en-IN-Neural2-A', label: 'Neural2 A — Indian' },
    ],
    male: [
      { id: 'en-US-Neural2-D', label: 'Neural2 D — American' },
      { id: 'en-US-Neural2-J', label: 'Neural2 J — American' },
      { id: 'en-US-Studio-Q', label: 'Studio Q — American (premium)' },
      { id: 'en-GB-Neural2-B', label: 'Neural2 B — British' },
      { id: 'en-AU-Neural2-B', label: 'Neural2 B — Australian' },
      { id: 'en-IN-Neural2-B', label: 'Neural2 B — Indian' },
    ],
  },
  azure: {
    female: [
      { id: 'en-NG-EzinneNeural', label: 'Ezinne — Nigerian' },
      { id: 'en-US-AvaMultilingualNeural', label: 'Ava — American' },
      { id: 'en-US-JennyNeural', label: 'Jenny — American' },
      { id: 'en-GB-SoniaNeural', label: 'Sonia — British' },
      { id: 'en-KE-AsiliaNeural', label: 'Asilia — Kenyan' },
      { id: 'en-ZA-LeahNeural', label: 'Leah — South African' },
    ],
    male: [
      { id: 'en-NG-AbeoNeural', label: 'Abeo — Nigerian' },
      { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew — American' },
      { id: 'en-US-GuyNeural', label: 'Guy — American' },
      { id: 'en-GB-RyanNeural', label: 'Ryan — British' },
      { id: 'en-KE-ChilembaNeural', label: 'Chilemba — Kenyan' },
      { id: 'en-ZA-LukeNeural', label: 'Luke — South African' },
    ],
  },
};

const SAMPLE_RATE = 24000;
const CONCURRENCY = { google: 8, azure: 4 };
const cache = new Map();

const langOf = (voiceId) => voiceId.split('-').slice(0, 2).join('-');
const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

class CloudError extends Error {
  constructor(message, { retryAfter = 0, fatal = false } = {}) {
    super(message);
    this.retryAfter = retryAfter;
    this.fatal = fatal;
  }
}

async function decodeWav(arrayBuffer) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
  const audio = await ctx.decodeAudioData(arrayBuffer);
  return { samples: audio.getChannelData(0), sampleRate: audio.sampleRate };
}

async function googleSpeak(creds, text, voice, speed) {
  if (!creds.googleKey) throw new CloudError('Enter your Google Cloud API key.', { fatal: true });
  let res;
  try {
    res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(creds.googleKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: langOf(voice), name: voice },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE, speakingRate: speed },
      }),
    });
  } catch {
    throw new CloudError('Could not reach Google Cloud. Check your internet connection.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* not JSON */ }
    if (res.status === 429 || res.status >= 500) {
      throw new CloudError(`Google Cloud is busy (${res.status}).`, { retryAfter: Number(res.headers.get('retry-after')) || 2 });
    }
    if (res.status === 400 && /API key not valid/i.test(detail)) throw new CloudError('The Google Cloud API key is not valid.', { fatal: true });
    if (res.status === 403) {
      throw new CloudError(`Google Cloud refused the request: ${detail || 'permission denied'}. Make sure the "Cloud Text-to-Speech API" is enabled for this key's project, billing is set up, and the key's website restrictions allow this site.`, { fatal: true });
    }
    throw new CloudError(`Google Cloud error ${res.status}: ${detail}`, { fatal: true });
  }
  const { audioContent } = await res.json();
  const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
  return decodeWav(bytes.buffer);
}

async function azureSpeak(creds, text, voice, speed) {
  if (!creds.azureKey || !creds.azureRegion) throw new CloudError('Enter your Azure Speech key and region.', { fatal: true });
  const region = creds.azureRegion.trim().toLowerCase().replace(/\s+/g, '');
  const rate = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
  const ssml = `<speak version="1.0" xml:lang="${langOf(voice)}"><voice name="${voice}"><prosody rate="${rate}">${xmlEscape(text)}</prosody></voice></speak>`;
  let res;
  try {
    res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': creds.azureKey.trim(),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      },
      body: ssml,
    });
  } catch {
    throw new CloudError(`Could not reach Azure Speech in region "${region}". Check the region name (for example "eastus" or "westeurope") and your internet connection.`, { fatal: true });
  }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new CloudError(`Azure Speech is busy (${res.status}).`, { retryAfter: Number(res.headers.get('retry-after')) || 3 });
    }
    if (res.status === 401) throw new CloudError('Azure rejected the key. Check that the key and region belong to the same Speech resource.', { fatal: true });
    if (res.status === 400) throw new CloudError(`Azure could not use the voice "${voice}" (it may not be available in region "${region}").`, { fatal: true });
    throw new CloudError(`Azure Speech error ${res.status}.`, { fatal: true });
  }
  return decodeWav(await res.arrayBuffer());
}

export async function cloudSpeak(provider, creds, text, voice, speed = 1) {
  const key = `${provider}|${voice}|${speed}|${text}`;
  if (cache.has(key)) return cache.get(key);
  const fn = provider === 'google' ? googleSpeak : azureSpeak;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const out = await fn(creds, text, voice, speed);
      cache.set(key, out);
      return out;
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err;
      // busy / rate limited: wait and retry (free tiers allow only a few requests per minute)
      const wait = Math.min(30, Math.max(err.retryAfter || 2, 2 ** attempt)) * 1000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Record many sentences at once; results keep the input order.
export async function cloudSpeakAll(provider, creds, texts, voice, speed, onEach, shouldStop) {
  const results = new Array(texts.length);
  let next = 0;
  let done = 0;
  let failed = null;
  const runner = async () => {
    while (next < texts.length && !failed) {
      if (shouldStop?.()) throw new Error('Cancelled.');
      const i = next++;
      try {
        results[i] = await cloudSpeak(provider, creds, texts[i], voice, speed);
      } catch (err) {
        failed = err;
        throw err;
      }
      onEach?.(++done);
    }
  };
  const runners = Array.from({ length: Math.min(CONCURRENCY[provider], texts.length) }, runner);
  runners.forEach((r) => r.catch(() => {}));
  await Promise.all(runners);
  if (shouldStop?.()) throw new Error('Cancelled.');
  return results;
}
