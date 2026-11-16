// Visual themes. Each resolves to CSS custom properties consumed by player/player.css.

export const THEMES = {
  'navy-gold': {
    label: 'Navy & Gold',
    vars: { bg1: '#0d2a66', bg2: '#06122e', glow: '#1d4fb8', text: '#ffffff', muted: '#c5d2ee', accent: '#f0bd2c', accentInk: '#0a1836', accent2: '#7fb2ff' },
  },
  'emerald-gold': {
    label: 'Emerald & Gold',
    vars: { bg1: '#0c6a35', bg2: '#04351b', glow: '#3aa35a', text: '#ffffff', muted: '#cfe8d6', accent: '#f4c532', accentInk: '#06301a', accent2: '#9be7b0' },
  },
  'royal-blue': {
    label: 'Royal Blue',
    vars: { bg1: '#11308f', bg2: '#050b24', glow: '#2f6bff', text: '#ffffff', muted: '#c3cdf0', accent: '#fbd23c', accentInk: '#071033', accent2: '#4ade80' },
  },
  'midnight-violet': {
    label: 'Midnight Violet',
    vars: { bg1: '#3a1c7a', bg2: '#0d0624', glow: '#7c4dff', text: '#ffffff', muted: '#d5c9f2', accent: '#ff9f43', accentInk: '#1a0b3a', accent2: '#5eead4' },
  },
  'crimson': {
    label: 'Crimson',
    vars: { bg1: '#8a1228', bg2: '#2a050d', glow: '#d43a55', text: '#ffffff', muted: '#f3cdd4', accent: '#ffd166', accentInk: '#3a0811', accent2: '#ffffff' },
  },
  'graphite-teal': {
    label: 'Graphite & Teal',
    vars: { bg1: '#1f2b3a', bg2: '#0b1016', glow: '#2a6f7a', text: '#ffffff', muted: '#c4d0dc', accent: '#2dd4bf', accentInk: '#06201d', accent2: '#fbbf24' },
  },
  'clean-light': {
    label: 'Clean Light',
    light: true,
    vars: { bg1: '#ffffff', bg2: '#e9eef8', glow: '#c9d8ff', text: '#0f1b3d', muted: '#4b587a', accent: '#1d4ed8', accentInk: '#ffffff', accent2: '#0e9f6e' },
  },
};

export const THEME_IDS = Object.keys(THEMES);

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Resolve a theme id (plus optional custom brand colours) into player CSS variables. */
export function resolveTheme(id, custom = {}) {
  const base = THEMES[id] || THEMES['navy-gold'];
  const vars = { ...base.vars };
  let light = !!base.light;
  const primary = parseHex(custom.primaryColor);
  const accent = parseHex(custom.accentColor);
  if (primary) {
    // Build a dark, saturated backdrop from the brand colour.
    light = false;
    vars.bg1 = toHex(mix(primary, [0, 0, 0], 0.35));
    vars.bg2 = toHex(mix(primary, [0, 0, 0], 0.82));
    vars.glow = toHex(mix(primary, [255, 255, 255], 0.18));
    vars.text = '#ffffff';
    vars.muted = toHex(mix(primary, [255, 255, 255], 0.8));
  }
  if (accent) {
    vars.accent = toHex(accent);
    vars.accentInk = luminance(accent) > 0.55 ? '#0b1020' : '#ffffff';
  }
  return { id, light, vars };
}
