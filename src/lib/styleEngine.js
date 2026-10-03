/**
 * Style engine.
 *
 * Turn N uploaded reference images into a reusable "Style DNA" descriptor, then
 * splice that descriptor into every bulk prompt so 200 images come out looking
 * like they belong to the same body of work.
 *
 * Two layers of style transfer:
 *   1. TEXT  — a vision model describes the art direction, which we append to
 *              each prompt. Cheap, works for every model, scales to 200 images.
 *   2. IMAGE — the reference images themselves are passed as `input_images`
 *              so the model can literally see the look it must match.
 */

import { chat } from './puterClient.js';
import { STYLE_STRENGTH_TEXT } from './constants.js';

const ANALYSE_INSTRUCTION = `You are a senior art director writing a locked-in "house style" brief so another image-generation model can reproduce this exact look for a brand-new set of pictures.

Study every reference image. Find what they share and describe it precisely and visually.

Reply with ONLY a single minified JSON object, no markdown, no commentary:
{"summary":"one vivid sentence describing the look","medium":"e.g. digital painting / studio photograph / 3D render / risograph print","palette":["#rrggbb"],"lighting":"how light behaves","texture":"surface + grain + finish","linework":"edges and line quality, or 'none' for photography","composition":"framing, angle and negative-space habits","cameraOrRender":"lens, depth of field, engine or rendering style","mood":["word","word"],"keywords":["12 to 16 punchy style keywords, most specific first"],"mustAvoid":["4 to 6 things that would break this style"]}

Rules:
- palette: 4 to 6 dominant colours as hex.
- keywords: describe STYLE only (technique, medium, colour, light, finish) — never the subjects in the references.
- If the references are visually inconsistent, describe the dominant direction.

Reference file names: __NAMES__`;

const ENHANCE_INSTRUCTION = `You rewrite short image prompts into rich, concrete, visually specific prompts.

Rules:
- NEVER change the subject, action, count or setting the user asked for. Only add craft.
- Add: framing/shot type, lighting, lens or render detail, materials, colour behaviour, atmosphere, finish.
- Bake in the house style below so it reads as one deliberate art direction.
- 60-110 words. One paragraph. No preamble, no quotes, no markdown.
- Output the prompt text only.`;

/** Vision-capable models to fall back through for the text/vision steps. */
const VISION_MODELS = [undefined, 'gemini-2.5-flash', 'gpt-4o-mini', 'claude-sonnet-4-5'];

/* ------------------------------------------------------------------ */

export const EMPTY_STYLE = {
  summary: '',
  medium: '',
  palette: [],
  lighting: '',
  texture: '',
  linework: '',
  composition: '',
  cameraOrRender: '',
  mood: [],
  keywords: [],
  mustAvoid: [],
  refCount: 0,
  analysed: false,
};

/** Best-effort JSON extraction from a model reply. */
export function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  // strip ```json fences
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // find the first {...} block
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = s.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    /* try to repair trailing commas / smart quotes */
    try {
      return JSON.parse(
        candidate
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/[\u201c\u201d]/g, '"')
          .replace(/[\u2018\u2019]/g, "'"),
      );
    } catch {
      return null;
    }
  }
}

function asArray(v, max = 24) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;\n]/);
  return arr
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, max);
}

function asText(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(', ');
  return String(v).trim();
}

export function normaliseStyle(raw, refCount = 0) {
  if (!raw) return { ...EMPTY_STYLE, refCount };
  return {
    summary: asText(raw.summary || raw.description || raw.look),
    medium: asText(raw.medium || raw.style || raw.technique),
    palette: asArray(raw.palette || raw.colors || raw.colours, 6),
    lighting: asText(raw.lighting || raw.light),
    texture: asText(raw.texture || raw.surface),
    linework: asText(raw.linework || raw.lines),
    composition: asText(raw.composition || raw.framing),
    cameraOrRender: asText(raw.cameraOrRender || raw.camera || raw.render),
    mood: asArray(raw.mood, 6),
    keywords: asArray(raw.keywords || raw.tags, 20),
    mustAvoid: asArray(raw.mustAvoid || raw.avoid || raw.negatives, 8),
    refCount,
    analysed: true,
  };
}

/** Merge several chunk analyses into one profile. */
function mergeStyles(parts, refCount) {
  const combined = {
    summary: parts.map((p) => p.summary).filter(Boolean).slice(0, 2).join(' '),
    medium: mostCommon(parts.map((p) => p.medium)),
    palette: unique(parts.flatMap((p) => p.palette)).slice(0, 6),
    lighting: mostCommon(parts.map((p) => p.lighting)),
    texture: mostCommon(parts.map((p) => p.texture)),
    linework: mostCommon(parts.map((p) => p.linework)),
    composition: mostCommon(parts.map((p) => p.composition)),
    cameraOrRender: mostCommon(parts.map((p) => p.cameraOrRender)),
    mood: unique(parts.flatMap((p) => p.mood)).slice(0, 6),
    keywords: unique(parts.flatMap((p) => p.keywords)).slice(0, 18),
    mustAvoid: unique(parts.flatMap((p) => p.mustAvoid)).slice(0, 8),
    refCount,
    analysed: true,
  };
  return combined;
}

const mostCommon = (arr) => arr.filter(Boolean)[0] || '';
const unique = (arr) => [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];

/**
 * Analyse reference images into a Style DNA profile.
 * Chunks large reference sets so the request payload stays sane.
 *
 * @param {Array<{name:string, apiDataUrl:string}>} refs
 * @param {{chunkSize?:number, onProgress?:(done:number,total:number)=>void}} opts
 */
export async function analyzeStyle(refs, { chunkSize = 6, onProgress } = {}) {
  const usable = refs.filter((r) => r?.apiDataUrl).slice(0, 18);
  if (!usable.length) {
    throw new Error('Add at least one reference image before analysing the style.');
  }

  const chunks = [];
  for (let i = 0; i < usable.length; i += chunkSize) chunks.push(usable.slice(i, i + chunkSize));

  const parts = [];
  const problems = [];

  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c];
    const names = chunk.map((r) => r.name || 'reference').join(', ');
    const media = chunk.map((r) => r.apiDataUrl);

    let text = '';
    let lastErr = null;
    for (const model of VISION_MODELS) {
      try {
        text = await chat({
          system: ANALYSE_INSTRUCTION.replace('__NAMES__', names),
          prompt: `These are ${chunk.length} reference image(s) of the same desired style. Describe the shared visual DNA.`,
          media,
          model,
        });
        if (text) break;
      } catch (err) {
        lastErr = err;
      }
    }

    const parsed = parseJsonLoose(text);
    if (parsed) {
      parts.push(normaliseStyle(parsed, chunk.length));
    } else if (lastErr) {
      problems.push(String(lastErr.message || lastErr));
    } else {
      problems.push('The style model returned text we could not parse.');
    }
    onProgress?.(c + 1, chunks.length);
  }

  if (!parts.length) {
    throw new Error(
      problems[0] ||
        'Style analysis failed. You can still generate — just add style keywords by hand.',
    );
  }

  return { profile: mergeStyles(parts, usable.length), problems };
}

/* ------------------------------------------------------------------ *
 * Prompt composition
 * ------------------------------------------------------------------ */

/** Render the Style DNA as a compact, model-friendly paragraph. */
export function styleToText(style) {
  if (!style) return '';
  const bits = [];
  if (style.summary) bits.push(style.summary);
  if (style.medium) bits.push(`Medium: ${style.medium}`);
  if (style.palette?.length) bits.push(`Palette: ${style.palette.join(', ')}`);
  if (style.lighting) bits.push(`Lighting: ${style.lighting}`);
  if (style.texture) bits.push(`Texture & finish: ${style.texture}`);
  if (style.linework) bits.push(`Linework: ${style.linework}`);
  if (style.composition) bits.push(`Composition: ${style.composition}`);
  if (style.cameraOrRender) bits.push(`Camera / render: ${style.cameraOrRender}`);
  if (style.mood?.length) bits.push(`Mood: ${style.mood.join(', ')}`);
  if (style.keywords?.length) bits.push(`Signature keywords: ${style.keywords.join(', ')}`);
  return bits.join('\n');
}

/**
 * Build the final generation prompt.
 *
 * @param {string} basePrompt    the user's numbered prompt
 * @param {object} opts
 */
export function buildPrompt(
  basePrompt,
  { style, strength = 'balanced', aspectId, tier, useStyleDna = true, extraStyleText = '', negative = '' } = {},
) {
  const body = String(basePrompt || '').trim();
  if (!useStyleDna || !style) {
    return [body, extraStyleText, negative ? `Avoid: ${negative}` : ''].filter(Boolean).join('\n\n');
  }

  const styleBlock = styleToText(style);
  const lines = [
    body,
    '',
    '— VISUAL STYLE (locked house style, reproduce it exactly) —',
    styleBlock,
    STYLE_STRENGTH_TEXT[strength] || STYLE_STRENGTH_TEXT.balanced,
    'Borrow only the style from the references — never copy their specific subjects, characters, logos or layout.',
  ];
  if (extraStyleText) lines.push(`Extra art direction: ${extraStyleText}`);
  if (negative || style.mustAvoid?.length) {
    const avoid = [...(style.mustAvoid || []), negative].filter(Boolean).join('; ');
    lines.push(`Avoid: ${avoid}.`);
  }
  if (aspectId) lines.push(`Composition must work as a ${aspectId} frame.`);
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Rewrite a short prompt into a fuller one, in the house style. */
export async function enhancePrompt(basePrompt, { style, aspectId } = {}) {
  const styleBlock = style ? styleToText(style) : '(no reference style supplied)';
  let lastErr = null;
  for (const model of VISION_MODELS) {
    try {
      const text = await chat({
        system: ENHANCE_INSTRUCTION,
        prompt: `HOUSE STYLE:\n${styleBlock}\n\nASPECT RATIO: ${aspectId || 'free'}\n\nPROMPT TO REWRITE:\n${basePrompt}\n\nOutput the rewritten prompt only.`,
        model,
      });
      if (text) return text.trim().replace(/^["'`]|["'`]$/g, '');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Prompt enhancement failed.');
}

/** Brainstorm extra prompt lines from a theme, keeping the house style. */
export async function suggestPrompts({ theme, count = 10, style, aspectId }) {
  const styleBlock = style ? styleToText(style) : '(no reference style supplied)';
  const system = `You write batches of image-generation prompts for a single styled series.

Rules:
- One prompt per line. No numbering, no bullets, no blank lines, no commentary.
- Each prompt is 12-30 words, concrete and visual, describing a distinct scene or subject.
- Every prompt must sit inside the same house style, but vary subject, framing and moment.
- Do not repeat the same subject twice.`;

  let lastErr = null;
  for (const model of VISION_MODELS) {
    try {
      const text = await chat({
        system,
        prompt: `HOUSE STYLE:\n${styleBlock}\n\nASPECT RATIO: ${aspectId || 'free'}\n\nTHEME: ${theme}\n\nWrite exactly ${count} prompts.`,
        model,
      });
      if (text) {
        return text
          .split('\n')
          .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
          .filter(Boolean)
          .slice(0, count);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Prompt brainstorming failed.');
}
