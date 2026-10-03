/**
 * Bulk-run plumbing: plan building, a worker pool with pause/abort, and a
 * shared rate governor so one 429 slows the whole batch instead of hammering
 * the API 200 times in a row.
 */

import { sleep } from './imageUtils.js';

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

/**
 * Turn the prompt list into a flat, numbered shot list.
 *
 * Numbering is global and sequential (001, 002, 003 …) so the exported ZIP
 * sorts exactly in the order the images were requested.
 */
export function buildPlan({ prompts, variations = 1, targetCount = 0, indexStart = 1 }) {
  const lines = (prompts || [])
    .map((p) => String(p).trim())
    .filter((p) => p && !p.startsWith('#'));

  if (!lines.length) return [];

  const perPrompt = Math.max(1, Number(variations) || 1);
  const wanted = Number(targetCount) > 0 ? Math.min(Number(targetCount), 2000) : lines.length * perPrompt;

  const items = [];
  for (let i = 0; i < wanted; i += 1) {
    const promptIndex = (i % lines.length) + 1;
    const variation = Math.floor(i / lines.length) + 1;
    const index = (Number(indexStart) || 1) + i;
    items.push({
      id: `img-${index}-${promptIndex}-${variation}`,
      index,
      promptIndex,
      variation,
      prompt: lines[promptIndex - 1],
      status: 'queued',
      attempts: 0,
      error: null,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * Pause gate
 * ------------------------------------------------------------------ */

export class PauseGate {
  constructor() {
    this.paused = false;
    this.waiters = [];
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    waiters.forEach((w) => w());
  }

  async wait() {
    if (!this.paused) return;
    await new Promise((resolve) => this.waiters.push(resolve));
  }
}

/* ------------------------------------------------------------------ *
 * Rate governor
 * ------------------------------------------------------------------ */

/**
 * Adaptive throttle.
 *
 * Puter's free tier allows 3 concurrent AI requests and 30 requests per 10s.
 * When any worker is throttled we push a shared "do not start anything until
 * T" marker so the whole pool backs off together — far more effective than
 * each worker retrying independently.
 */
export class RateGovernor {
  constructor() {
    this.penaltyUntil = 0;
    this.consecutivePenalties = 0;
    this.maxPenaltyMs = 60000;
  }

  penalize(baseMs = 5000) {
    this.consecutivePenalties += 1;
    const backoff = Math.min(
      this.maxPenaltyMs,
      baseMs * 2 ** Math.min(this.consecutivePenalties - 1, 4),
    );
    this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + backoff + Math.random() * 800);
    return backoff;
  }

  reward() {
    if (this.consecutivePenalties > 0) this.consecutivePenalties -= 1;
  }

  remaining() {
    return Math.max(0, this.penaltyUntil - Date.now());
  }

  async waitTurn(isAborted) {
    const left = this.remaining();
    if (left <= 0) return;
    // Sleep in slices so an abort is felt quickly.
    const end = Date.now() + left;
    while (Date.now() < end) {
      if (isAborted?.()) throw new DOMException('Aborted', 'AbortError');
      await sleep(Math.min(400, end - Date.now()));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Worker pool
 * ------------------------------------------------------------------ */

/**
 * Run `runOne(item, slot)` over the queue with a fixed number of workers.
 *
 * @param {object} opts
 * @param {Array}  opts.items
 * @param {number} opts.concurrency
 * @param {(item:object, slot:number)=>Promise<void>} opts.runOne
 * @param {()=>boolean} [opts.isAborted]
 * @param {PauseGate} [opts.gate]
 */
export async function runPool({ items, concurrency, runOne, isAborted, gate }) {
  const size = Math.max(1, Math.min(Number(concurrency) || 3, 24));
  let cursor = 0;
  const stats = { attempted: 0, done: 0, failed: 0, cancelled: 0 };

  const take = () => {
    if (cursor >= items.length) return -1;
    const i = cursor;
    cursor += 1;
    return i;
  };

  const worker = async (slot) => {
    for (;;) {
      if (isAborted?.()) return;
      if (gate) await gate.wait();
      if (isAborted?.()) return;

      const i = take();
      if (i < 0) return;

      const item = items[i];
      if (item.status === 'done') continue;

      stats.attempted += 1;
      try {
        await runOne(item, slot);
        stats.done += 1;
      } catch (err) {
        if (err?.name === 'AbortError') {
          stats.cancelled += 1;
          return;
        }
        stats.failed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: size }, (_, i) => worker(i)));
  return stats;
}

