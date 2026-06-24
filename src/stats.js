import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * Lightweight usage stats persisted to a small JSON file.
 *
 * Shape:
 * {
 *   lifetime: { requests, youtube, audio, tiktok, slideshow, errors },
 *   users: { "<id>": { first, last, count } }
 * }
 *
 * Lifetime counters only ever grow by integers (a few bytes). The users map
 * grows with UNIQUE users, not requests, and is pruned of long-inactive
 * entries on load — so the file stays tiny.
 */

const emptyState = () => ({
  lifetime: { requests: 0, youtube: 0, audio: 0, tiktok: 0, slideshow: 0, errors: 0 },
  users: {},
});

let state = emptyState();
let loaded = false;
let saveTimer = null;

/** Load stats from disk once at startup. Missing/broken file → fresh state. */
export async function initStats() {
  try {
    const raw = await readFile(config.statsFile, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      lifetime: { ...emptyState().lifetime, ...(parsed.lifetime || {}) },
      users: parsed.users || {},
    };
    pruneInactive();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[stats] could not read stats file, starting fresh:', err.message);
    }
    state = emptyState();
  }
  loaded = true;
}

/** Remove users not seen within the TTL window (aggregate counters stay). */
function pruneInactive() {
  const cutoff = Date.now() - config.statsUserTtlMs;
  for (const [id, u] of Object.entries(state.users)) {
    if ((u.last ?? 0) < cutoff) delete state.users[id];
  }
}

/** Debounced atomic write: temp file + rename, at most once every few seconds. */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(path.dirname(config.statsFile), { recursive: true });
      const tmp = `${config.statsFile}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, config.statsFile);
    } catch (err) {
      console.error('[stats] failed to save:', err.message);
    }
  }, 3000);
  saveTimer.unref?.();
}

/** Record that a user interacted with the bot. */
export function recordUser(userId) {
  if (!loaded || userId == null) return;
  const key = String(userId);
  const now = Date.now();
  const u = state.users[key];
  if (u) {
    u.last = now;
    u.count += 1;
  } else {
    state.users[key] = { first: now, last: now, count: 1 };
  }
  state.lifetime.requests += 1;
  scheduleSave();
}

/**
 * Record a successful download by type.
 * @param {'youtube'|'audio'|'tiktok'|'slideshow'} type
 */
export function recordDownload(type) {
  if (!loaded) return;
  if (type in state.lifetime) state.lifetime[type] += 1;
  scheduleSave();
}

/** Record a failed download (for context in /stats). */
export function recordError() {
  if (!loaded) return;
  state.lifetime.errors += 1;
  scheduleSave();
}

/** Build a human-readable summary for the /stats command. */
export function getSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayCutoff = startOfDay.getTime();
  const weekCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let activeToday = 0;
  let activeWeek = 0;
  for (const u of Object.values(state.users)) {
    if (u.last >= dayCutoff) activeToday += 1;
    if (u.last >= weekCutoff) activeWeek += 1;
  }

  const l = state.lifetime;
  return {
    uniqueUsers: Object.keys(state.users).length,
    activeToday,
    activeWeek,
    totalRequests: l.requests,
    youtube: l.youtube,
    audio: l.audio,
    tiktok: l.tiktok,
    slideshow: l.slideshow,
    errors: l.errors,
  };
}

/** Flush to disk immediately (call on shutdown). */
export async function flushStats() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await mkdir(path.dirname(config.statsFile), { recursive: true });
    const tmp = `${config.statsFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, config.statsFile);
  } catch (err) {
    console.error('[stats] flush failed:', err.message);
  }
}
