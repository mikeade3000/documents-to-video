// Payments (Flutterwave) and paid features, talking to the backend in server/worker.js.
// If CONFIG.apiBase is empty, payments are switched off: downloads are free and AI narration is hidden.

import { CONFIG } from './config.js';

const API = (CONFIG.apiBase || '').replace(/\/+$/, '');
export const paymentsEnabled = () => !!API;

let serverConfig = null;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
};

async function api(path, body) {
  let res;
  try {
    res = await fetch(`${API}${path}`, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the payment server. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Server error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getServerConfig() {
  if (!serverConfig) serverConfig = await api('/api/config');
  return serverConfig;
}

export function formatPrice(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

// ---------- receipts (proof of payment, kept in this browser) ----------

const receiptKey = (item, jobId) => `d2v-receipt:${item}:${jobId}`;
export const getReceipt = (item, jobId) => store.get(receiptKey(item, jobId));
const pendingKey = (item, jobId) => `d2v-pending:${item}:${jobId}`;

// Ask the server whether this browser's receipt is still valid (e.g. AI credits left).
export async function checkReceipt(item, jobId) {
  const receipt = getReceipt(item, jobId);
  if (!receipt) return null;
  try {
    return await api('/api/receipt', { receipt, jobId, item });
  } catch (err) {
    if (err.status === 402) store.set(receiptKey(item, jobId), null);
    return null;
  }
}

// ---------- Flutterwave checkout ----------

let flwScript = null;
function loadFlutterwave() {
  if (window.FlutterwaveCheckout) return Promise.resolve();
  if (!flwScript) {
    flwScript = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.flutterwave.com/v3.js';
      s.onload = resolve;
      s.onerror = () => { flwScript = null; reject(new Error('Could not load Flutterwave checkout. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }
  return flwScript;
}

async function verify(item, jobId, tx_ref) {
  const out = await api('/api/pay/verify', { tx_ref });
  store.set(receiptKey(item, jobId), out.receipt);
  store.set(pendingKey(item, jobId), null);
  return out.receipt;
}

// Shows the payment dialog. Resolves with a receipt, or null if the user closes it.
export function purchase(item, jobId, { title, description }) {
  return new Promise(async (resolve) => {
    const dlg = document.getElementById('pay-dialog');
    const $ = (sel) => dlg.querySelector(sel);
    const cfg = await getServerConfig().catch((e) => ({ error: e.message }));
    const msg = (text, isErr = false) => { $('.pay-msg').textContent = text; $('.pay-msg').classList.toggle('err', isErr); };
    let finished = false;
    const finish = (receipt) => {
      if (finished) return;
      finished = true;
      dlg.close();
      resolve(receipt);
    };

    $('.pay-title').textContent = title;
    $('.pay-desc').textContent = description;
    $('.pay-price').textContent = cfg.error ? '' : formatPrice(cfg.prices[item], cfg.currency);
    $('#pay-email').value = store.get('d2v-email') || '';
    $('#pay-name').value = store.get('d2v-name') || '';
    msg(cfg.error || '', !!cfg.error);
    $('.pay-go').disabled = !!cfg.error;
    const pending = store.get(pendingKey(item, jobId));
    $('.pay-check').classList.toggle('hidden', !pending);

    $('.pay-cancel').onclick = () => finish(null);
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };

    $('.pay-check').onclick = async () => {
      msg('Checking your payment…');
      try {
        finish(await verify(item, jobId, store.get(pendingKey(item, jobId))));
      } catch (err) {
        msg(err.message, true);
      }
    };

    $('.pay-go').onclick = async () => {
      const email = $('#pay-email').value.trim();
      const name = $('#pay-name').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg('Enter a valid email address for your receipt.', true); return; }
      store.set('d2v-email', email);
      store.set('d2v-name', name || null);
      $('.pay-go').disabled = true;
      msg('Opening secure checkout…');
      try {
        await loadFlutterwave();
        const order = await api('/api/pay/start', { item, jobId, email, name });
        store.set(pendingKey(item, jobId), order.tx_ref);
        $('.pay-check').classList.remove('hidden');
        dlg.close(); // Flutterwave shows its own window
        let paidInModal = false;
        const modal = window.FlutterwaveCheckout({
          public_key: order.public_key,
          tx_ref: order.tx_ref,
          amount: order.amount,
          currency: order.currency,
          payment_options: 'card, banktransfer, ussd, account',
          customer: order.customer,
          customizations: { title: order.title, description: order.description },
          callback: async (payment) => {
            paidInModal = true;
            modal?.close?.();
            dlg.showModal();
            msg('Confirming your payment…');
            try {
              finish(await verify(item, jobId, payment.tx_ref || order.tx_ref));
            } catch (err) {
              msg(`${err.message}`, true);
              $('.pay-go').disabled = false;
            }
          },
          onclose: (incomplete) => {
            if (paidInModal || finished) return;
            dlg.showModal();
            $('.pay-go').disabled = false;
            msg(incomplete === false ? 'Checking your payment…' : 'Payment window closed. If you completed a bank transfer or USSD payment, press “I have paid”.');
          },
        });
      } catch (err) {
        if (!dlg.open) dlg.showModal();
        msg(err.message, true);
        $('.pay-go').disabled = false;
      }
    };

    dlg.showModal();
  });
}

// ---------- AI narration ----------

export async function aiScript(jobId, payload) {
  const receipt = getReceipt('ai', jobId);
  try {
    return await api('/api/ai/script', { receipt, jobId, ...payload });
  } catch (err) {
    if (err.status === 402) store.set(receiptKey('ai', jobId), null);
    throw err;
  }
}
