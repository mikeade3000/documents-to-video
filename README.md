# Doc-to-Video Studio

Upload a document (or describe what you want) and get back a narrated, animated
explainer video as a 1080p MP4: title scenes, checklists, step-by-step walkthroughs,
statistics, comparisons, device mock-ups, captions and a chapter bar.

## How it works

| Step | What does it | Why |
| --- | --- | --- |
| 1. Read the upload | `pdf-parse`, `mammoth`, `jszip` | PDF, Word, PowerPoint, text and images |
| 2. Storyboard + script | **Claude API** (`claude-opus-5-5`, structured JSON output) | Decides the scenes, on-screen text and narration |
| 3. Voice-over | **OpenAI text-to-speech** or **ElevenLabs** | Natural narration, one clip per scene |
| 4. Animation | Headless Chromium (Playwright) drawing HTML/CSS scenes | Crisp text and brand-exact graphics |
| 5. Encoding | ffmpeg | H.264 + AAC MP4 that plays everywhere |

These videos are motion graphics, so they are drawn and rendered rather than made with a
generative video model (Sora, Veo, Runway). Those models cannot keep text, numbers and
logos accurate, which is exactly what this kind of video depends on.

## Run it on your computer

Needs Node.js 20+, ffmpeg, and Chromium for Playwright.

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then put your API keys in .env
npm start
```

Open http://localhost:3000.

To check the renderer before adding any keys, `npm run sample` renders
`samples/sample-storyboard.json` to `sample-output.mp4` (silent, with captions).

## API keys

Set these in `.env` (or in your host's environment settings). Never put them in the code.

- `ANTHROPIC_API_KEY` (required): https://platform.claude.com
- One voice provider:
  - `OPENAI_API_KEY`: good quality at low cost; ten built-in voices.
  - `ELEVENLABS_API_KEY`: the most natural voices, plus your own custom or cloned voices.
    List the voices to offer in `ELEVENLABS_VOICES` as `Label:voiceId` pairs.

Without a voice key the site still works and produces silent videos with captions.

## Payments (Flutterwave)

With `FLW_PUBLIC_KEY` and `FLW_SECRET_KEY` set, visitors create and preview videos for
free and pay once (default NGN 1,500, `PRICE_DOWNLOAD`) to download each MP4. Before
payment only the in-page preview is available; the MP4 itself is not served.

1. In the Flutterwave dashboard, copy the keys from *Settings → API keys* into `.env`.
   Use the `TEST` keys first and pay with a Flutterwave test card.
2. Optional but recommended: under *Settings → Webhooks* set the URL to
   `https://YOUR-SITE/api/pay/webhook`, choose a secret hash, and put the same value in
   `FLW_WEBHOOK_HASH`. This unlocks the video even if the buyer closes the page after paying.

The server confirms every payment with Flutterwave (reference, amount and currency)
before unlocking a download. Orders are stored in `DATA_DIR/orders`, and paid videos are
kept for `PAID_KEEP_DAYS` (default 30), so use a persistent disk for `DATA_DIR`.
Leave the keys empty and downloads are free.

Creating a video costs you API credit even when nobody pays, so keep `JOBS_PER_HOUR`
low or set an `ACCESS_CODE`.

## Put it online

The app runs Chromium and ffmpeg and keeps a job running for a few minutes, so it needs
a host that runs a Docker container or a long-lived Node process: Render, Railway, Fly.io,
or any VPS (DigitalOcean, Hetzner, AWS Lightsail). Static hosts, shared cPanel hosting and
serverless functions (Vercel, Netlify) cannot run it.

```bash
docker build -t doc-to-video .
docker run -d -p 3000:3000 --env-file .env -v d2v-data:/data doc-to-video
```

Recommended size: 2 CPU cores and 2 GB of RAM or more. More cores render faster
(`RENDER_WORKERS` defaults to the core count minus one, up to 4).

Before you share the link publicly, set `ACCESS_CODE` so only people with the code can
spend your API credit, and keep `JOBS_PER_HOUR` low. Put the site behind HTTPS (the hosts
above do this for you; on a VPS use Caddy or nginx).

## Settings

All settings are environment variables; see `.env.example` for the full list.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACCESS_CODE` | none | Code visitors must enter before generating |
| `JOBS_PER_HOUR` | 6 | Videos one IP address may make per hour |
| `KEEP_HOURS` | 24 | How long finished videos stay downloadable |
| `CONCURRENT_JOBS` | 1 | Videos rendered at the same time |
| `MAX_FILE_MB` / `MAX_FILES` | 25 / 8 | Upload limits |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Storyboard model |

## Project layout

```
server.js            web server and API routes
src/extract.js       reads uploaded files
src/storyboard.js    Claude prompt, JSON schema, validation
src/tts.js           OpenAI / ElevenLabs narration
src/timeline.js      scene, caption and reveal timings
src/render.js        frame capture and ffmpeg encoding
src/jobs.js          job queue and pipeline
src/payments.js      Flutterwave orders, verification and webhook
src/themes.js        colour themes (add your own here)
player/              the scene renderer (HTML/CSS/JS); edit player.css to restyle scenes
public/index.html    the upload page
```

Jobs are kept in memory and on disk, which suits a single server. To run several
servers, move the queue to Redis and the files to object storage.
