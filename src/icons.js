import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON_DIR = path.join(here, '..', 'node_modules', 'lucide-static', 'icons');

// Curated subset of Lucide icons the storyboard writer may choose from.
export const ICON_NAMES = `check shield-check shield clock timer calendar file-text files folder clipboard-check list-checks
lock key-round fingerprint id-card qr-code scan-line eye search
chart-column chart-pie trending-up gauge percent calculator scale
wifi wifi-off globe cloud database server network cpu bot brain code layers puzzle
laptop monitor smartphone tablet printer camera video mic battery-charging
user users handshake building-2 landmark school graduation-cap book-open briefcase presentation
pen-line pencil mail phone message-circle megaphone bell newspaper link
banknote credit-card wallet hand-coins shopping-cart tag ticket gift truck
star award medal trophy target rocket zap sparkles lightbulb thumbs-up heart smile sun leaf flag
map map-pin route house stethoscope wrench settings refresh-cw upload download image play
triangle-alert info circle-help circle-check x`.split(/\s+/).filter(Boolean);

const cache = new Map();

/** Returns the inline <svg> markup for an icon (or the fallback when unknown). */
export function iconSvg(name) {
  const key = ICON_NAMES.includes(name) ? name : 'sparkles';
  if (!cache.has(key)) {
    const raw = fs.readFileSync(path.join(ICON_DIR, `${key}.svg`), 'utf8');
    cache.set(key, raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim());
  }
  return cache.get(key);
}

/** Collects every icon a storyboard uses, plus the ones the player chrome always needs. */
export function iconsFor(storyboard) {
  const names = new Set(['check', 'x', 'sparkles', 'play', 'circle-check', 'lightbulb']);
  for (const s of storyboard.scenes) {
    if (s.icon) names.add(s.icon);
    for (const it of s.items || []) if (it.icon) names.add(it.icon);
  }
  if (storyboard.brand?.icon) names.add(storyboard.brand.icon);
  return Object.fromEntries([...names].map((n) => [n, iconSvg(n)]));
}
