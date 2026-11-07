// Adelani Doc-to-Video — payment and AI backend (Cloudflare Worker).
//
// Keeps the secret keys off the public website:
//   - FLW_SECRET_KEY      Flutterwave secret key (verifies payments)
//   - OPENROUTER_API_KEY  OpenRouter key (writes AI narration)
//   - FLW_WEBHOOK_HASH    (optional) the "secret hash" set in Flutterwave → Settings → Webhooks
//
// Endpoints (all JSON):
//   GET  /api/config              prices, currency and Flutterwave public key for the website
//   POST /api/pay/start           { item: 'ai'|'download', jobId, email, name? } → creates an order (tx_ref)
//   POST /api/pay/verify          { tx_ref } → checks the payment with Flutterwave, returns a receipt
//   POST /api/receipt             { receipt, jobId, item } → is this receipt valid for this document?
//   POST /api/ai/script           { receipt, jobId, doc, instructions, ... } → AI narration (uses 1 credit)
//   POST /api/pay/webhook         Flutterwave webhook (optional, marks orders paid even if the browser closed)
//
// Storage: one KV namespace bound as ORDERS.
//   order:<tx_ref>  → { item, jobId, amount, currency, email, status, receipt?, createdAt }
//   receipt:<id>    → { item, jobId, tx_ref, aiUsesLeft?, paidAt }

const FLW_API = 'https://api.flutterwave.com/v3';
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const ITEMS = ['ai', 'download'];
const MAX_BODY = 600_000; // bytes; a 200-slide document is well under this

// ---------- helpers ----------

function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Document too large for AI narration. Split it into smaller files.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function prices(env) {
  return {
    ai: Number(env.PRICE_AI || 1000),
    download: Number(env.PRICE_DOWNLOAD || 1500),
  };
}

const randomId = (prefix) => `${prefix}-${crypto.randomUUID().replace(/-/g, '')}`;
const validJobId = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const validEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 200;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- payments ----------

async function startPayment(env, body) {
  const { item, jobId, email, name } = body;
  if (!ITEMS.includes(item)) throw new HttpError(400, 'Unknown item.');
  if (!validJobId(jobId)) throw new HttpError(400, 'Invalid document id.');
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const amount = prices(env)[item];
  const currency = env.CURRENCY || 'NGN';
  const tx_ref = randomId(`d2v-${item}`);
  const order = { item, jobId, amount, currency, email, name: String(name || '').slice(0, 100), status: 'pending', createdAt: Date.now() };
  await env.ORDERS.put(`order:${tx_ref}`, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 7 });
  return {
    tx_ref,
    amount,
    currency,
    public_key: env.FLW_PUBLIC_KEY,
    customer: { email, name: order.name },
    title: env.SITE_NAME || 'Adelani Doc-to-Video',
    description: item === 'ai' ? 'AI narration for one document (3 rewrites)' : 'Download the MP4 videos for one document',
  };
}

// Ask Flutterwave whether the order was paid, and issue a receipt if so. Safe to call repeatedly.
async function fulfilOrder(env, tx_ref) {
  if (typeof tx_ref !== 'string' || !/^d2v-(ai|download)-[a-f0-9]{32}$/.test(tx_ref)) throw new HttpError(400, 'Invalid payment reference.');
  const raw = await env.ORDERS.get(`order:${tx_ref}`);
  if (!raw) throw new HttpError(404, 'Payment reference not found.');
  const order = JSON.parse(raw);
  if (order.status === 'paid' && order.receipt) return { receipt: order.receipt, item: order.item, jobId: order.jobId };

  const res = await fetch(`${FLW_API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`, {
    headers: { Authorization: `Bearer ${env.FLW_SECRET_KEY}` },
  });
  const data = await res.json().catch(() => ({}));
  const t = data?.data;
  if (data.status !== 'success' || !t) throw new HttpError(402, 'Payment not found yet. If you were charged, wait a minute and press "I have paid".');
  if (t.status !== 'successful') throw new HttpError(402, `Payment ${t.status || 'not completed'}.`);
  if (t.tx_ref !== tx_ref || t.currency !== order.currency || Number(t.amount) < order.amount) {
    throw new HttpError(402, 'Payment details do not match this order. Please contact support.');
  }

  const receipt = randomId('rcpt');
  const record = { item: order.item, jobId: order.jobId, tx_ref, paidAt: Date.now(), flwId: t.id };
  if (order.item === 'ai') record.aiUsesLeft = Number(env.AI_USES_PER_PAYMENT || 3);
  await env.ORDERS.put(`receipt:${receipt}`, JSON.stringify(record));
  // Keep the paid order (no expiry) so it is never fulfilled twice.
  await env.ORDERS.put(`order:${tx_ref}`, JSON.stringify({ ...order, status: 'paid', receipt, flwId: t.id }));
  return { receipt, item: order.item, jobId: order.jobId };
}

async function getReceipt(env, receipt, jobId, item) {
  if (typeof receipt !== 'string' || !/^rcpt-[a-f0-9]{32}$/.test(receipt)) throw new HttpError(402, 'Payment required.');
  const raw = await env.ORDERS.get(`receipt:${receipt}`);
  if (!raw) throw new HttpError(402, 'Payment required.');
  const rec = JSON.parse(raw);
  if (rec.item !== item || rec.jobId !== jobId) throw new HttpError(402, 'This payment was for a different document.');
  return rec;
}

async function handleWebhook(env, request) {
  const hash = request.headers.get('verif-hash');
  if (!env.FLW_WEBHOOK_HASH || !timingSafeEqual(hash || '', env.FLW_WEBHOOK_HASH)) return new Response('ignored', { status: 401 });
  const payload = await request.json().catch(() => null);
  const tx_ref = payload?.data?.tx_ref || payload?.txRef;
  if (payload?.event === 'charge.completed' && payload?.data?.status === 'successful' && tx_ref) {
    try { await fulfilOrder(env, tx_ref); } catch (e) { console.log('webhook fulfil failed', tx_ref, e.message); }
  }
  return new Response('ok', { status: 200 });
}

// ---------- AI narration (OpenRouter) ----------

const SCRIPT_SCHEMA = {
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

const SYSTEM_PROMPT = `You write voice-over scripts for narrated slide videos made from documents.
You receive the slides of one document (extracted text, and speaker notes where they exist) plus the user's instructions.
For every slide return:
- title: a short slide heading (keep the original unless the instructions say otherwise),
- bullets: 2 to 6 short on-screen points (under 12 words each) taken from the slide,
- narration: what the narrator says while the slide is on screen.
Narration rules: write it to be spoken aloud — natural, clear sentences, no markdown, no bullet symbols, no URLs read out character by character. Do not say "this slide" or "next slide" repeatedly. Stay faithful to the document's facts.
Return exactly one entry per input slide, with the same index values, in the same order, as JSON matching the schema. Follow the user's instructions about tone, audience, level of detail, language and length.`;

function extractJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('no JSON');
}

async function writeScript(env, body) {
  const { receipt, jobId, doc, instructions, wordsPerMinute, maxPartSeconds } = body;
  if (!validJobId(jobId)) throw new HttpError(400, 'Invalid document id.');
  const rec = await getReceipt(env, receipt, jobId, 'ai');
  if (!(rec.aiUsesLeft > 0)) throw new HttpError(402, 'All AI rewrites for this payment have been used. Pay again for more.');
  if (!doc || !Array.isArray(doc.slides) || !doc.slides.length || doc.slides.length > 300) throw new HttpError(400, 'Invalid document.');

  const slides = doc.slides.map((s, index) => ({
    index,
    title: String(s.title || '').slice(0, 300),
    text: String(s.text || '').slice(0, 6000),
    ...(s.notes ? { speaker_notes: String(s.notes).slice(0, 6000) } : {}),
  }));
  const user = [
    `Document: ${String(doc.title || '').slice(0, 300)} (${String(doc.kind || '').toUpperCase()}, ${slides.length} slides)`,
    `Narration pace is about ${Number(wordsPerMinute) || 140} words per minute. The video is cut into parts of at most ${Math.round((Number(maxPartSeconds) || 240) / 6) / 10} minutes each, so long documents simply produce more parts.`,
    `User instructions:\n${String(instructions || '').slice(0, 4000).trim() || '(none — narrate the content clearly and faithfully)'}`,
    `Slides (JSON):\n${JSON.stringify(slides)}`,
  ].join('\n\n');

  const res = await fetch(OPENROUTER_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': (env.ALLOWED_ORIGINS || '').split(',')[0] || 'https://mikeade3000.github.io',
      'X-Title': env.SITE_NAME || 'Adelani Doc-to-Video',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-5.5',
      max_tokens: 32000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'narration_script', strict: true, schema: SCRIPT_SCHEMA } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log('openrouter error', res.status, JSON.stringify(data).slice(0, 500));
    throw new HttpError(502, 'The AI service is unavailable right now. Your credit was not used — please try again shortly.');
  }
  const content = data?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = extractJson(typeof content === 'string' ? content : JSON.stringify(content));
  } catch {
    throw new HttpError(502, 'The AI returned an unreadable script. Your credit was not used — please try again.');
  }
  if (!Array.isArray(parsed?.slides)) throw new HttpError(502, 'The AI returned an incomplete script. Your credit was not used — please try again.');

  // Only charge a credit once the script was produced.
  rec.aiUsesLeft -= 1;
  await env.ORDERS.put(`receipt:${receipt}`, JSON.stringify(rec));
  return { slides: parsed.slides, aiUsesLeft: rec.aiUsesLeft };
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'GET' && pathname === '/api/config') {
        return json({
          currency: env.CURRENCY || 'NGN',
          prices: prices(env),
          aiUsesPerPayment: Number(env.AI_USES_PER_PAYMENT || 3),
          public_key: env.FLW_PUBLIC_KEY,
          siteName: env.SITE_NAME || 'Adelani Doc-to-Video',
        }, 200, headers);
      }
      if (request.method === 'POST' && pathname === '/api/pay/webhook') return handleWebhook(env, request);
      if (request.method !== 'POST') throw new HttpError(404, 'Not found.');
      const body = await readJson(request);
      switch (pathname) {
        case '/api/pay/start':
          return json(await startPayment(env, body), 200, headers);
        case '/api/pay/verify':
          return json(await fulfilOrder(env, body.tx_ref), 200, headers);
        case '/api/receipt': {
          const rec = await getReceipt(env, body.receipt, body.jobId, body.item);
          return json({ ok: true, item: rec.item, aiUsesLeft: rec.aiUsesLeft }, 200, headers);
        }
        case '/api/ai/script':
          return json(await writeScript(env, body), 200, headers);
        default:
          throw new HttpError(404, 'Not found.');
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.log('server error', err?.stack || err);
      return json({ error: status === 500 ? 'Server error. Please try again.' : err.message }, status, headers);
    }
  },
};
