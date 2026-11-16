// Optional durable storage. The server's own disk is enough on a normal host, but on
// platforms where the disk is wiped when the app sleeps (Cloudflare Containers) finished
// videos and paid orders are also copied to an S3-compatible bucket and restored on demand.
//
// Cloudflare R2: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (bucket: R2_BUCKET).
// Another S3-compatible store: also set S3_ENDPOINT to its address.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { config } from './config.js';

export const storeEnabled = () => !!(config.r2AccessKeyId && config.r2SecretAccessKey && (config.r2AccountId || config.s3Endpoint));

let client = null;
function s3() {
  if (!client) client = new AwsClient({ accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey, service: 's3', region: 'auto' });
  return client;
}
function url(key) {
  const endpoint = (config.s3Endpoint || `https://${config.r2AccountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return `${endpoint}/${config.r2Bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function putBuffer(key, body, type = 'application/octet-stream') {
  const res = await s3().fetch(url(key), { method: 'PUT', body, headers: { 'Content-Type': type } });
  if (!res.ok) throw new Error(`storage PUT ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}
export const putJson = (key, value) => putBuffer(key, JSON.stringify(value), 'application/json');
export const putFile = async (key, file) => putBuffer(key, await fs.readFile(file));

/** Returns the object's bytes, or null when it does not exist. */
export async function getBuffer(key) {
  const res = await s3().fetch(url(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage GET ${key} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}
export async function getJson(key) {
  const buf = await getBuffer(key);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}
/** Downloads an object to a local file. Returns false when it does not exist. */
export async function getFile(key, file) {
  const buf = await getBuffer(key);
  if (!buf) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  return true;
}
