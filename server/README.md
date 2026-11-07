# Payment and AI server (Cloudflare Worker)

This small server keeps your secret keys safe and handles everything that costs money:

- **Flutterwave**: creates each order and checks with Flutterwave that it was really paid before unlocking anything.
- **AI narration (OpenRouter)**: writes the script with *your* OpenRouter key. Visitors never see the key, and the server only runs the AI for documents that have been paid for.

The website stays on GitHub Pages. Only this server runs on Cloudflare, which is free for this amount of traffic (100,000 requests a day).

## What visitors pay for

| Feature | Default price | What they get |
|---|---|---|
| AI narration | ₦1,000 per document | AI writes the narration from their instructions, with 3 rewrites of that document |
| Download | ₦1,500 per document | Clean MP4s without the watermark: every part, and any re-render of the same file |

Everything else is free: reading the file, editing the script, the voices and watermarked previews. Prices are set in `wrangler.toml`.

A "document" is identified by its file contents. Uploading the exact same file again keeps the purchase; a changed file counts as a new document. Purchases are remembered in the visitor's browser.

## One-time setup (about 15 minutes)

You need: a Cloudflare account (free), a Flutterwave account, an OpenRouter account with some credit, and Node.js installed on your computer.

### 1. Get your keys

- **Flutterwave**: Dashboard → **Settings → API Keys**. Copy the **Public key** (`FLWPUBK-…`) and the **Secret key** (`FLWSECK-…`). Start with the **test** keys (`FLWPUBK_TEST-…` / `FLWSECK_TEST-…`) to try it without real money.
- **OpenRouter**: openrouter.ai → **Keys → Create key**. Add credit under **Credits**. A typical document costs about $0.02–0.15 of AI time with the default model.

### 2. Create the server

In a terminal, inside this `server` folder:

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create ORDERS
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. In the same file, set `FLW_PUBLIC_KEY` to your Flutterwave public key and adjust the prices if you want.

Then store the secrets. Each command asks you to paste the value:

```bash
npx wrangler secret put FLW_SECRET_KEY
```

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

It prints your server address, for example `https://doc-to-video-api.yourname.workers.dev`.

### 3. Connect the website

Open `js/config.js` in the website and set:

```js
apiBase: 'https://doc-to-video-api.yourname.workers.dev',
```

Commit and push. The AI option, with its price, appears on the site, and videos become watermarked previews until the download is paid for.

### 4. Webhook (recommended)

This makes sure a payment is recorded even if the customer closes the page before the confirmation finishes, for example with bank transfers.

1. In Flutterwave: **Settings → Webhooks**. Set the URL to `https://doc-to-video-api.yourname.workers.dev/api/pay/webhook`, type a long random **Secret hash**, and tick the charge-completed event.
2. Store the same hash on the server:

```bash
npx wrangler secret put FLW_WEBHOOK_HASH
```

### 5. Go live

Test the whole flow with Flutterwave **test** keys and a test card from Flutterwave's documentation. When it works, replace both Flutterwave keys with your **live** keys: `FLW_PUBLIC_KEY` in `wrangler.toml`, then run `wrangler secret put FLW_SECRET_KEY` again. Then run `npx wrangler deploy`.

## Settings (`wrangler.toml`)

| Setting | Meaning |
|---|---|
| `ALLOWED_ORIGINS` | Your website address(es), comma-separated, e.g. `https://mikeade3000.github.io` (add your own domain if you get one) |
| `CURRENCY` | `NGN`, `USD`, `GHS`, `KES` … any currency your Flutterwave account accepts |
| `PRICE_AI`, `PRICE_DOWNLOAD` | Prices in whole units of the currency |
| `AI_USES_PER_PAYMENT` | How many AI rewrites one AI payment includes |
| `OPENROUTER_MODEL` | Any model from openrouter.ai/models that supports structured outputs. Cheaper options: `anthropic/claude-haiku-5.5`, `google/gemini-3.8-flash`, `deepseek/deepseek-v4.1-flash` |

After changing settings, run `npx wrangler deploy` again.

## Seeing your sales

Every payment appears in your **Flutterwave dashboard → Transactions**. References start with `d2v-ai-` or `d2v-download-`. OpenRouter usage is under **Activity** on openrouter.ai.

## Good to know

- **AI narration is fully protected.** The AI only runs on the server, after the server has confirmed the payment with Flutterwave.
- **The download watermark is a deterrent, not a lock.** Videos are made inside the visitor's browser, so someone with programming skills could edit the page code to remove the watermark. Ordinary users can't. Fully locking downloads would mean making the videos on a paid server instead of in the browser.
- **AI credits are only used when a script is actually returned.** If the AI service fails, the credit is kept.
