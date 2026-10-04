/**
 * ATLAS PROXY — Phase E: scale hardening (Owner 2026-10-05).
 * ----------------------------------------------------------
 * Owner: "αν μπουν χιλιάδες χρήστες … πρέπει ο proxy να μην πέσει".
 *
 * Three concerns, all deterministic + zero AI tokens:
 *   1. Per-tenant quotas   — each platform key can have its own per-minute
 *      budget (KEY_QUOTAS), so one noisy client never starves the others.
 *   2. Retry + backoff     — VPS relays retry on TRANSIENT network faults
 *      (ECONNRESET / timeout / cold start) instead of returning HTTP 000.
 *      A down VPS still returns a clean, structured 503 (never a hang).
 *   3. Usage metering      — per-key request + token counters, persisted to
 *      KV when bound (else per-isolate memory), exposed at /v1/usage.
 */

const DAY = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// ── 1. Retry + exponential backoff for VPS relays ──────────────────────────
// Cloudflare outbound fetch to a VPS can transiently fail (reset, DNS, cold
// start). Retrying a couple of times with backoff turns most of those into a
// clean success. Genuine HTTP statuses (4xx/5xx) are NOT retried — only
// transport errors throw, so this only masks transient network faults.
export async function fetchWithRetry(url, init = {}, { retries = 2, backoffMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

// ── 2. Per-tenant quotas ───────────────────────────────────────────────────
// KEY_QUOTAS is a JSON map of `{ "<key>"|"<platform>": perMinLimit }`. Resolve
// a request's budget by exact key first, then by its platform name, else the
// global RATE_LIMIT_PER_MIN default. Numeric, deterministic, no secrets logged.
export function quotaFor(env, key, platform) {
  const def = Number(env.RATE_LIMIT_PER_MIN || 120);
  let map = null;
  try {
    const q = env.KEY_QUOTAS;
    if (q) map = typeof q === "string" ? JSON.parse(q) : q;
  } catch { /* malformed KEY_QUOTAS — fall back to default */ }
  if (map && typeof map === "object") {
    if (key && typeof map[key] === "number") return map[key];
    if (platform && typeof map[platform] === "number") return map[platform];
  }
  return def;
}

// ── 3. Usage metering ──────────────────────────────────────────────────────
// Per-key, per-day counters: { requests, tokens }. KV-backed when
// env.USAGE_KV is bound (durable, cross-colo); otherwise a bounded in-memory
// map (honest: resets on deploy/cold start). Never logs key values.
const _mem = new Map(); // `${key}::${day}` -> { requests, tokens }

function usageKey(id) {
  // Hash the key so the KV key never stores the raw bearer token.
  // FNV-1a (fast, non-cryptographic — enough for a counter bucket id).
  let x = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    x ^= id.charCodeAt(i);
    x = Math.imul(x, 0x01000193);
  }
  return `u:${(x >>> 0).toString(36)}:${DAY()}`;
}

export async function recordUsage(env, key, tokens = 0) {
  const k = usageKey(key);
  if (env.USAGE_KV) {
    try {
      const raw = await env.USAGE_KV.get(k);
      const cur = raw ? JSON.parse(raw) : { requests: 0, tokens: 0 };
      cur.requests += 1;
      cur.tokens += tokens;
      await env.USAGE_KV.put(k, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 31 });
      return;
    } catch { /* KV unavailable — fall through to memory */ }
  }
  const cur = _mem.get(k) || { requests: 0, tokens: 0 };
  cur.requests += 1;
  cur.tokens += tokens;
  _mem.set(k, cur);
  // Bound the in-memory map (drop the oldest beyond 10k entries).
  if (_mem.size > 10000) {
    const oldest = _mem.keys().next().value;
    if (oldest) _mem.delete(oldest);
  }
}

export async function readUsage(env, key) {
  const k = usageKey(key);
  const out = { day: DAY(), requests: 0, tokens: 0, backend: "memory" };
  if (env.USAGE_KV) {
    try {
      const raw = await env.USAGE_KV.get(k);
      if (raw) {
        const cur = JSON.parse(raw);
        out.requests = cur.requests || 0;
        out.tokens = cur.tokens || 0;
        out.backend = "kv";
      }
      return out;
    } catch { /* KV unavailable — fall through to memory */ }
  }
  const cur = _mem.get(k);
  if (cur) { out.requests = cur.requests; out.tokens = cur.tokens; }
  return out;
}

// Deterministic token estimate for a chat body (cheap, no LLM). Used to fill
// the metering counters without needing the upstream provider to report usage.
export function estimateTokens(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let chars = 0;
  for (const m of msgs) {
    const c = typeof m.content === "string" ? m.content : String(m?.content || "");
    chars += c.length;
  }
  // ~4 chars/token heuristic (English); conservative for multilingual.
  return Math.max(1, Math.round(chars / 4));
}
