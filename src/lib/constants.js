/**
 * StyleForge Bulk — shared constants.
 *
 * Everything here is client-side configuration for Puter.js (`puter.ai.*`),
 * which needs no API key: each signed-in user's own Puter account covers usage.
 */

/* ------------------------------------------------------------------ *
 * Models
 *
 * `id` is what we send to puter.ai.txt2img(). Puter accepts both bare
 * Gemini ids ("gemini-3-pro-image") and provider-prefixed ones
 * ("google/gemini-3-pro-image"); we pin the provider-prefixed form so the
 * request can never be silently routed to a different vendor.
 * ------------------------------------------------------------------ */
export const MODELS = [
  {
    id: 'google/gemini-3-pro-image',
    short: 'Nano Banana Pro',
    full: 'Gemini 3 Pro Image',
    blurb: 'Highest fidelity. Best text rendering, best reference-image fidelity.',
    tiers: ['1K', '2K', '4K'],
    defaultTier: '2K',
    maxRefs: 14,
    // Published Gemini API list prices, USD per image (used only for the
    // pre-flight estimate — Puter bills the user's own account at real cost).
    price: { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
    badge: 'Best quality',
    refs: 'excellent',
  },
  {
    id: 'google/gemini-3.1-flash-image',
    short: 'Nano Banana 2',
    full: 'Gemini 3.1 Flash Image',
    blurb: 'Pro-level look at roughly half the cost and ~2x the speed.',
    tiers: ['512', '1K', '2K', '4K'],
    defaultTier: '2K',
    maxRefs: 14,
    price: { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    badge: 'Balanced',
    refs: 'very good',
  },
  {
    id: 'google/gemini-3.1-flash-lite-image',
    short: 'Nano Banana 2 Lite',
    full: 'Gemini 3.1 Flash Lite Image',
    blurb: 'Cheapest Nano Banana tier — built for very high volume runs.',
    tiers: ['1K'],
    defaultTier: '1K',
    maxRefs: 14,
    price: { '1K': 0.03 },
    badge: 'Cheapest',
    refs: 'good',
  },
  {
    id: 'black-forest-labs/flux-schnell',
    short: 'FLUX.1 Schnell',
    full: 'FLUX.1 Schnell',
    blurb:
      'Ultra-cheap fallback. Fixed 1024×1024 and it cannot read reference images, so style matching comes from the text descriptor only.',
    tiers: ['1K'],
    defaultTier: '1K',
    maxRefs: 0,
    price: { '1K': 0.003 },
    badge: 'Emergency',
    refs: 'none',
  },
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

export const DEFAULT_MODEL_ID = 'google/gemini-3-pro-image';

/** Ordered cheapest-last list used by the auto-downgrade ladder. */
export const DOWNGRADE_LADDER = [
  'google/gemini-3-pro-image',
  'google/gemini-3.1-flash-image',
  'google/gemini-3.1-flash-lite-image',
  'black-forest-labs/flux-schnell',
];

/* ------------------------------------------------------------------ *
 * Aspect ratios
 *
 * These are the ten shapes Gemini's image models accept natively; Puter
 * passes `ratio: { w, h }` straight through.
 * ------------------------------------------------------------------ */
export const ASPECT_RATIOS = [
  { id: '1:1', w: 1, h: 1, label: '1:1', note: 'Square', use: 'Feeds, avatars, products' },
  { id: '4:5', w: 4, h: 5, label: '4:5', note: 'Portrait', use: 'Instagram portrait' },
  { id: '3:4', w: 3, h: 4, label: '3:4', note: 'Portrait', use: 'Prints, posters' },
  { id: '2:3', w: 2, h: 3, label: '2:3', note: 'Tall portrait', use: 'Book covers' },
  { id: '9:16', w: 9, h: 16, label: '9:16', note: 'Vertical', use: 'Reels, Shorts, Stories' },
  { id: '3:2', w: 3, h: 2, label: '3:2', note: 'Photo', use: 'DSLR crop, thumbnails' },
  { id: '4:3', w: 4, h: 3, label: '4:3', note: 'Classic', use: 'Slides, screens' },
  { id: '5:4', w: 5, h: 4, label: '5:4', note: 'Wide classic', use: 'Frames, prints' },
  { id: '16:9', w: 16, h: 9, label: '16:9', note: 'Widescreen', use: 'YouTube, banners' },
  { id: '21:9', w: 21, h: 9, label: '21:9', note: 'Cinematic', use: 'Cinema, hero art' },
];

export const DEFAULT_ASPECT = '1:1';

export const TIER_PIXELS = { '512': 512, '1K': 1024, '2K': 2048, '4K': 4096 };

/* ------------------------------------------------------------------ *
 * Generation defaults
 * ------------------------------------------------------------------ */
export const DEFAULT_SETTINGS = {
  modelId: DEFAULT_MODEL_ID,
  tier: '2K',
  aspect: DEFAULT_ASPECT,
  customW: 16,
  customH: 9,
  variations: 1,
  targetCount: 0, // 0 = lines × variations
  concurrency: 3,
  maxAttempts: 3,
  useStyleDna: true,
  styleStrength: 'balanced', // light | balanced | strict
  enhancePrompts: false,
  sendReferences: true,
  maxRefsPerCall: 6,
  outputFormat: 'png', // png | jpg | webp
  filenamePattern: '{index}',
  indexStart: 1,
  includeManifest: true,
  autoDowngrade: true,
  zipSplit: 0, // 0 = single zip, otherwise images per part
};

/**
 * Puter's documented rate limits for AI calls.
 * Free account: 30 requests / 10s and 3 concurrent — so 3 is the safe default.
 */
export const CONCURRENCY_PRESETS = [
  { value: 1, label: '1 — slowest, safest' },
  { value: 2, label: '2' },
  { value: 3, label: '3 — free-plan max' },
  { value: 4, label: '4 — needs paid Puter plan' },
  { value: 6, label: '6 — paid plan' },
  { value: 8, label: '8 — paid plan' },
];

export const STYLE_STRENGTH_TEXT = {
  light:
    'Apply the reference art direction loosely — keep the prompt as the dominant signal.',
  balanced:
    'Apply the reference art direction faithfully while keeping every subject and action from the prompt intact.',
  strict:
    'Match the reference art direction as closely as a human art director would — treat it as the locked house style.',
};
