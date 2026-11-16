// Flutterwave payments: visitors create and preview videos for free and pay to download the MP4.
// Payments are on when FLW_PUBLIC_KEY and FLW_SECRET_KEY are both set; otherwise downloads are free.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getJob, markPaid } from './jobs.js';

const FLW_API = 'https://api.flutterwave.com/v3';
const ordersDir = () => path.join(config.dataDir, 'orders');
const orderFile = (txRef) => path.join(ordersDir(), `${txRef}.json`);
const validRef = (s) => typeof s === 'string' && /^d2v-[a-f0-9]{32}$/.test(s);
const validEmail = (s) => typeof s === 'string' && s.length < 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export const paymentsEnabled = () => !!(config.flwPublicKey && config.flwSecretKey);

export function paymentInfo() {
  return paymentsEnabled() ? { enabled: true, price: config.priceDownload, currency: config.currency } : { enabled: false };
}

/** An error with an HTTP status whose message is shown to the visitor. */
export class PayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readOrder(txRef) {
  try { return JSON.parse(await fs.readFile(orderFile(txRef), 'utf8')); } catch { return null; }
}
async function writeOrder(txRef, order) {
  await fs.mkdir(ordersDir(), { recursive: true });
  await fs.writeFile(orderFile(txRef), JSON.stringify(order));
}

/** Creates an order for one finished video and returns what the Flutterwave checkout needs. */
export async function startPayment({ jobId, email, name }) {
  if (!paymentsEnabled()) throw new PayError(400, 'Payments are not switched on.');
  const job = await getJob(String(jobId || ''));
  if (!job) throw new PayError(404, 'That video was not found.');
  if (job.status !== 'done') throw new PayError(409, 'The video is not finished yet.');
  if (job.paid) return { alreadyPaid: true };
  if (!validEmail(email)) throw new PayError(400, 'Enter a valid email address for your receipt.');
  const txRef = `d2v-${crypto.randomUUID().replace(/-/g, '')}`;
  const order = { jobId: job.id, amount: config.priceDownload, currency: config.currency, email, name: String(name || '').slice(0, 100), status: 'pending', createdAt: Date.now() };
  await writeOrder(txRef, order);
  return {
    tx_ref: txRef,
    amount: order.amount,
    currency: order.currency,
    public_key: config.flwPublicKey,
    customer: { email, name: order.name },
    title: config.siteName,
    description: `Download: ${job.title || 'your video'}`.slice(0, 100),
  };
}

/** Asks Flutterwave whether an order was paid and unlocks the video if so. Safe to call repeatedly. */
export async function verifyPayment(txRef) {
  if (!validRef(txRef)) throw new PayError(400, 'Invalid payment reference.');
  const order = await readOrder(txRef);
  if (!order) throw new PayError(404, 'Payment reference not found.');
  if (order.status !== 'paid') {
    let data = {};
    try {
      const res = await fetch(`${FLW_API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, { headers: { Authorization: `Bearer ${config.flwSecretKey}` } });
      data = await res.json().catch(() => ({}));
    } catch {
      throw new PayError(502, 'Could not reach Flutterwave to confirm the payment. Please press "I have paid" again in a moment.');
    }
    const t = data?.data;
    if (data.status !== 'success' || !t) throw new PayError(402, 'Payment not found yet. If you were charged, wait a minute and press "I have paid".');
    if (t.status !== 'successful') throw new PayError(402, `Payment ${t.status || 'not completed'}.`);
    // Never trust the browser: the reference, currency and amount must match the order we created.
    if (t.tx_ref !== txRef || t.currency !== order.currency || Number(t.amount) < order.amount) {
      throw new PayError(402, 'Payment details do not match this order. Please contact support.');
    }
    Object.assign(order, { status: 'paid', paidAt: Date.now(), flwId: t.id });
    await writeOrder(txRef, order);
  }
  await markPaid(order.jobId, txRef);
  return { paid: true, jobId: order.jobId };
}

/** Flutterwave webhook: unlocks the video even if the visitor closed the page after paying. */
export async function handleWebhook(hash, payload) {
  const expected = Buffer.from(config.flwWebhookHash || '');
  const given = Buffer.from(String(hash || ''));
  if (!expected.length || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 401;
  const txRef = payload?.data?.tx_ref || payload?.txRef;
  if (payload?.event === 'charge.completed' && payload?.data?.status === 'successful' && validRef(txRef)) {
    try { await verifyPayment(txRef); } catch (err) { console.log('webhook verify failed', txRef, err.message); }
  }
  return 200;
}
