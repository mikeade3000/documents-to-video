# Adelani Doc-to-Video

Turns **PowerPoint (.pptx)**, **Word (.docx)** and **PDF** files into narrated **MP4** videos.

1. **Upload** a file. Slides, headings/sections or pages are read in the browser; the file is never uploaded.
2. **Choose the voice and settings**: female or male narrator (5 voices each, American or British), speaking speed, maximum video length (3, 3½ or 4 minutes), slide style, colour theme, 720p or 1080p, and subtitles.
3. **Instructions**: describe the tone, audience and level of detail you want. If you tick *Let AI write the narration* and paste an Anthropic API key, Claude rewrites the narration and on-screen points to follow your instructions. Without a key, the narration comes from the speaker notes, or from the slide/page text, plus an optional opening and closing line.
4. **Review the script**: every slide's title, on-screen points and narration can be edited before rendering.
5. **Generate**: the narration is recorded with the voice model, then the videos are built. When the narration is longer than the limit, it is split into *Part 1 of N*, *Part 2 of N* and so on. Each part starts with a title card and stays under the limit. If a single slide's narration is longer than the limit, that slide is continued in the next part.

### Voice services

Choose the voice service in step 2:

| Service | Speed | Cost | Setup |
|---|---|---|---|
| **Free in-browser voice** (default) | Depends on the computer: roughly 1–3 s per sentence on CPU | Free | None |
| **Google Cloud Text-to-Speech** | About 30–60 s for a long document | Free allowance each month (1 million characters for Neural2 voices), then pay per character | Create a project at console.cloud.google.com, enable **Cloud Text-to-Speech API**, set up billing, then create an API key under *APIs & Services → Credentials* |
| **Microsoft Azure Speech** (includes Nigerian, Kenyan and South African English voices) | About 30–60 s for a long document | Free tier (F0): 0.5 million characters/month but only 20 requests per minute, so use the Standard (S0) tier for speed | Create a **Speech service** resource in portal.azure.com, then copy *Key 1* and the *Region* from *Keys and Endpoint* |

Keys are typed into the page and sent only from the visitor's browser to Google or Microsoft. Tick *Remember the key* to keep them on that computer.

**Let visitors use your Google key:** put it in `js/config.js` (`googleApiKey`). The key is visible in the page source, so in Google Cloud Console restrict it to your website (*Application restrictions → Websites*, e.g. `https://mikeade3000.github.io/*`) and to the *Cloud Text-to-Speech API* only, and set a budget alert. Never put an Azure key in `config.js`: Azure keys can't be restricted to a website.

### How it works

Everything runs client-side, so the site can be hosted on GitHub Pages or any static host:

| Step | Library |
|---|---|
| PPTX / DOCX reading | [JSZip](https://stuk.github.io/jszip/) + the browser's XML parser |
| PDF reading and page rendering | [PDF.js](https://mozilla.github.io/pdf.js/) |
| Cloud voices (optional) | Google Cloud Text-to-Speech REST API, Azure Speech REST API |
| Voice (text-to-speech) | [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) via `kokoro-js`. Uses WebGPU when available, otherwise several CPU workers. The ~90 MB model downloads once and is then cached. |
| AI script writing (optional) | Claude via the Anthropic JavaScript SDK, called from the browser with the user's own key |
| MP4 encoding | WebCodecs (H.264 + AAC) and `mp4-muxer` |

### Browser support

Use **desktop Chrome or Edge**. On Windows and macOS the audio is AAC. On Linux, Chrome has no AAC encoder, so the MP4 uses Opus audio, which plays in Chrome, Firefox and VLC.

### Host it

It is a static site: upload `index.html`, the `js/` folder and `.nojekyll` to any web host that serves HTTPS (cPanel, Netlify, Vercel, Cloudflare Pages).

**GitHub Pages:** in this repo go to *Settings → Pages*, set *Source* to *Deploy from a branch*, pick `main` and `/ (root)`, and save. After a minute the site is live at `https://mikeade3000.github.io/documents-to-video/`.

### Run locally

From the repository folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/. Pages must be served over http(s), not opened as `file://`, because they use JavaScript modules and workers.

### Limitations

- PowerPoint slides are **redrawn** in a clean template (title, bullet points, the main picture). They are not pixel-perfect copies of the original design. For exact visuals, export the deck to PDF and use **Original pages** style.
- Old `.ppt` / `.doc` files must be re-saved as `.pptx` / `.docx`.
- Scanned PDFs (images without text) have no text to read. Type the narration in the script step, or use AI mode.
- Voice generation speed depends on the computer. The **Voice engine** setting chooses how it runs:
  - **Auto** (default): tests the graphics card first, and uses the CPU if the card fails, is slow, or stops responding mid-job.
  - **CPU:** works everywhere and uses several cores in parallel.
  - **GPU:** fastest on good graphics cards, but needs a one-time 326 MB model download (the CPU model is 92 MB).
- Long documents take a while: roughly 1–3 seconds per sentence on CPU. The status line shows a live clock and a time-left estimate. **Cancel** stops immediately, and sentences already recorded are reused when you press Generate again.
