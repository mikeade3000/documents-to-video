// Cloudflare entry point. A Worker receives every request for the site and hands it to one
// Cloudflare Container that runs the app (Dockerfile in the repository root).
import { Container, getContainer } from '@cloudflare/containers';

// Required by @cloudflare/containers: the container will not start without this export.
export { ContainerProxy } from '@cloudflare/containers';

// Settings and secrets copied from the Worker (dashboard: Settings > Variables and Secrets)
// into the container's environment. Anything not set is simply left out.
const PASS_THROUGH = [
  'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'CLAUDE_EFFORT', 'CLAUDE_FALLBACKS',
  'OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICES', 'ELEVENLABS_MODEL', 'TTS_PROVIDER',
  'FLW_PUBLIC_KEY', 'FLW_SECRET_KEY', 'FLW_WEBHOOK_HASH', 'PRICE_DOWNLOAD', 'CURRENCY', 'SITE_NAME',
  // R2 keeps finished videos and paid orders, because a container's own disk is wiped when it sleeps.
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'S3_ENDPOINT',
  'ACCESS_CODE', 'JOBS_PER_HOUR', 'MAX_FILE_MB', 'MAX_FILES', 'RENDER_WORKERS',
];

export class VideoStudio extends Container {
  defaultPort = 3000;
  // Stop the container after this long with no visitors. It starts again on the next visit.
  sleepAfter = '15m';

  constructor(ctx, env) {
    super(ctx, env);
    const vars = { PORT: '3000', DATA_DIR: '/data', RENDER_WORKERS: '2' };
    for (const name of PASS_THROUGH) if (env[name] != null && env[name] !== '') vars[name] = String(env[name]);
    this.envVars = vars;
  }
}

export default {
  async fetch(request, env) {
    // The app limits how many videos one visitor can make per hour, so tell it who is asking.
    const forwarded = new Request(request);
    forwarded.headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
    // One fixed container, so every visitor sees the same queue and the same finished videos.
    return getContainer(env.STUDIO, 'main').fetch(forwarded);
  },
};
