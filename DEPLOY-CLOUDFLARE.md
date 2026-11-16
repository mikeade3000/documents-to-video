# Deploying to Cloudflare

Everything runs on Cloudflare, at `https://ma-doc-to-vid.portals.com.ng`:

| Piece | Cloudflare product | What it does |
| --- | --- | --- |
| Front door | Worker (`cloudflare/worker.js`) | Receives every visit on your domain |
| The app | Container (`Dockerfile`) | Writes, narrates and renders the videos |
| Storage | R2 bucket `doc-to-video` | Keeps finished videos and paid orders |

GitHub builds and deploys it for you (`.github/workflows/deploy-cloudflare.yml`), so
nothing needs installing on your computer. Requirements: the Workers Paid plan, and the
domain `portals.com.ng` on the same Cloudflare account (it already uses Cloudflare DNS).

## 1. Turn on R2 and create its keys

1. Cloudflare dashboard → **R2 Object Storage**. If asked, enable R2.
2. **Manage R2 API Tokens** → **Create API token**.
   Permission: **Object Read & Write**. Scope: all buckets (or the `doc-to-video` bucket
   once it exists). Create it.
3. Copy the **Access Key ID** and **Secret Access Key**. They are shown once.

## 2. Create a deploy token for GitHub

1. Dashboard → profile icon → **My Profile** → **API Tokens** → **Create Token**.
2. Start from the **Edit Cloudflare Workers** template.
3. Add these permissions to it:
   - Account → **Containers** → Edit
   - Account → **Workers R2 Storage** → Edit (usually already in the template)
4. Account Resources: your account. Zone Resources: `portals.com.ng`.
5. Create the token and copy it.
6. Copy your **Account ID** as well (dashboard → Workers & Pages → right-hand side).

## 3. Give GitHub the two values

In the GitHub repository → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**, add:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID |

## 4. Deploy

GitHub → **Actions** → **Deploy to Cloudflare** → **Run workflow**. The first run takes
about 10 minutes (it builds and uploads the container image). It also creates the R2
bucket and attaches `ma-doc-to-vid.portals.com.ng` to the Worker. Later pushes to `main`
deploy automatically.

## 5. Add your keys

Dashboard → **Workers & Pages** → **doc-to-video** → **Settings** → **Variables and
Secrets** → **Add**. Choose type **Secret** for each:

| Name | Value | Needed |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude API key | Yes |
| `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` | voice-over key | For narration (silent with captions otherwise) |
| `R2_ACCOUNT_ID` | your Account ID | Yes |
| `R2_ACCESS_KEY_ID` | from step 1 | Yes |
| `R2_SECRET_ACCESS_KEY` | from step 1 | Yes |
| `FLW_PUBLIC_KEY` | Flutterwave public key | For payments |
| `FLW_SECRET_KEY` | Flutterwave secret key | For payments |
| `FLW_WEBHOOK_HASH` | your Flutterwave webhook secret hash | Recommended with payments |
| `ACCESS_CODE` | a code visitors must enter | Optional |

Press **Deploy** to save. Then run the GitHub workflow once more (step 4) so the running
container restarts with the new keys.

Prices and limits (`PRICE_DOWNLOAD`, `CURRENCY`, `JOBS_PER_HOUR`, `SITE_NAME`) are in
`wrangler.jsonc`; edit them there and push.

## 6. Flutterwave webhook

Flutterwave dashboard → **Settings** → **Webhooks**: URL
`https://ma-doc-to-vid.portals.com.ng/api/pay/webhook`, and a secret hash equal to
`FLW_WEBHOOK_HASH`. Start with your TEST keys and a test card, then switch to LIVE keys.

## 7. Check it

1. Open `https://ma-doc-to-vid.portals.com.ng`. The first visit after a quiet period
   takes a little longer while the container starts.
2. Create a short video from a description. Confirm the narration plays in the preview.
3. With payments on, pay with a test card and download the MP4.
4. In R2 → `doc-to-video`, confirm a `jobs/` folder appeared (and `orders/` after a payment).

## Good to know

- The container sleeps after 15 minutes without visitors and you are not charged for
  container time while it sleeps. Finished videos are restored from R2 when needed.
- A video that is still being made when a new version is deployed is lost; ask the
  visitor to start it again.
- To delete old videos automatically: R2 → `doc-to-video` → **Settings** → **Object
  lifecycle rules** → delete objects under `jobs/` after, say, 60 days. Do not add a rule
  for `orders/`.
- Faster rendering: change `instance_type` in `wrangler.jsonc` to `standard-4` and set
  `RENDER_WORKERS` to `3`.
- Logs: dashboard → Workers & Pages → doc-to-video → **Logs**, and the **Containers** tab.
