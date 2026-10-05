/**
 * ATLAS PROXY — Cloudflare Worker edition (edge, HTTPS, 24/7, zero cold-start).
 *
 * This is the SAME OpenAI-compatible gateway as the local atlas-core proxy and
 * the VPS proxy, but it runs on Cloudflare's edge so EVERY platform (Perplexity,
 * NovaDevs, and every future one) reaches it over HTTPS with one proxy key.
 *
 * Free-first routing (Owner 2026-09-18):
 *   chat:  Cloudflare Workers AI (@cf/qwen/qwen3-30b-a3b-fp8, FREE) → DeepSeek
 *          V4 Pro → Alibaba Qwen → Gemini (paid only as last resort)
 *   image: Alibaba Qwen Image
 *   audio: Azure neural TTS (Ava/Athina, multi-language)
 *
 * Endpoints: /health, /v1/models, /v1/chat/completions, /v1/images/generations,
 *            /v1/audio/speech
 * Auth: Authorization: Bearer <ATLAS_PROXY_KEY>
 */
import { PROXY_PROTOCOL, PROXY_PROTOCOL_VERSION } from "./protocol.js";
import { DETERMINISTIC_TASKS, detectDeterministicTask } from "./deterministic.js";
import { fetchWithRetry, quotaFor, recordUsage, readUsage, estimateTokens } from "./scaling.js";

const FREE_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"; // Cloudflare Workers AI (free tier)
const DEEPSEEK = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
const ALIBABA_CHAT = "https://dashscope-intl.aliyuncs.com/compatible-mode";
const ALIBABA_MODEL = "qwen3.8-max";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_CONTINUATIONS = 12;
const CONTRACT_VERSION = "v1"; // frozen proxy contract (Stability Lock §4r) — bump only on explicit Owner unlock

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// Resolve the caller's identity: { key, platform } — the raw bearer token plus
// which platform (if any) it belongs to in PLATFORM_KEYS. Used by auth, quotas,
// and usage metering. Returns null when no key is present.
function resolveIdentity(req, env) {
  const h = String(req.headers.get("Authorization") || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  const got = m ? m[1].trim() : String(new URL(req.url).searchParams.get("key") || "");
  if (!got) return null;
  let platform = null;
  try {
    const pk = env.PLATFORM_KEYS;
    if (pk) {
      const map = typeof pk === "string" ? JSON.parse(pk) : pk;
      if (map && typeof map === "object") {
        for (const [name, value] of Object.entries(map)) {
          if (value && String(value) === got) { platform = name; break; }
        }
      }
    }
  } catch { /* ignore malformed PLATFORM_KEYS */ }
  return { key: got, platform };
}

function authorized(req, env) {
  // Per-platform keys (F5): single ATLAS_PROXY_KEY still works (back-compat),
  // and an optional PLATFORM_KEYS JSON map {platform: key} lets every platform
  // carry its own key so one client's rotation never affects the others.
  const keys = new Set();
  if (env.ATLAS_PROXY_KEY) keys.add(String(env.ATLAS_PROXY_KEY));
  try {
    const pk = env.PLATFORM_KEYS;
    if (pk) {
      const map = typeof pk === "string" ? JSON.parse(pk) : pk;
      if (map && typeof map === "object") for (const v of Object.values(map)) if (v) keys.add(String(v));
    }
  } catch { /* ignore malformed PLATFORM_KEYS */ }
  if (!keys.size) return false;
  const id = resolveIdentity(req, env);
  return Boolean(id?.key) && keys.has(id.key);
}

// ── Phase D: scaling — static cache + per-key rate limit (Owner 2026-10-04) ─
// Static metadata endpoints are cached at module scope (per-isolate). The rate
// limiter is a sliding 60s window per platform key; it uses KV
// (env.RATE_LIMIT_KV) when bound — otherwise per-isolate memory (honest: that
// resets on deploy/cold start, so bind RATE_LIMIT_KV for real cross-colos).

const STATIC_CACHE = new Map();
const STATIC_TTL = 60_000;
function cachedJson(key, make) {
  const hit = STATIC_CACHE.get(key);
  if (hit && Date.now() - hit.at < STATIC_TTL) return hit.body;
  const body = make();
  STATIC_CACHE.set(key, { at: Date.now(), body });
  return body;
}

const RL_WINDOW_MS = 60_000;
const RL_DEFAULT_PER_MIN = 120;   // per platform key
const RL_GLOBAL_PER_MIN = 1000;   // all keys combined (KV-backed only)
const _rl = new Map();            // key -> number[] (in-memory fallback)

// Returns true when the request must be rejected (over the limit).
// Phase E: per-tenant quotas — a platform's own KEY_QUOTAS budget wins over
// the global default, so one noisy client never starves the others.
async function rateLimited(req, env) {
  const id = resolveIdentity(req, env);
  const key = id?.key || "anon";
  const limit = quotaFor(env, key, id?.platform);
  const now = Date.now();
  const bucket = Math.floor(now / RL_WINDOW_MS);

  if (env.RATE_LIMIT_KV) {
    try {
      const k = `rl:${key}:${bucket}`;
      const gk = `rl:global:${bucket}`;
      const [n, gn] = await Promise.all([
        env.RATE_LIMIT_KV.get(k).then((v) => (v ? Number(v) : 0)),
        env.RATE_LIMIT_KV.get(gk).then((v) => (v ? Number(v) : 0)),
      ]);
      await Promise.all([
        env.RATE_LIMIT_KV.put(k, String(n + 1), { expirationTtl: 120 }),
        env.RATE_LIMIT_KV.put(gk, String(gn + 1), { expirationTtl: 120 }),
      ]);
      return n >= limit || gn >= RL_GLOBAL_PER_MIN;
    } catch { /* KV unavailable — fall through to memory */ }
  }

  const arr = (_rl.get(key) || []).filter((ts) => now - ts < RL_WINDOW_MS);
  arr.push(now);
  _rl.set(key, arr);
  return arr.length > limit;
}

// ── User-Understanding Intelligence (inlined from empathy.js — zero deps) ──
// localization-skip:begin — multilingual language/emotion detection keyword
// lists (Greek "μαλακία", "θυμωμένος", …) are RUNTIME dictionaries, not
// product copy. The UI-Localization bot must not flag these.
function detectLanguage(text) {
  const s = String(text || "");
  if (!s.trim()) return "en";
  const ranges = [
    ["el", /[\u0370-\u03FF\u1F00-\u1FFF]/g], ["ru", /[\u0400-\u04FF]/g],
    ["ar", /[\u0600-\u06FF]/g], ["he", /[\u0590-\u05FF]/g],
    ["zh", /[\u4E00-\u9FFF]/g], ["ja", /[\u3040-\u30FF]/g],
    ["ko", /[\uAC00-\uD7AF\u1100-\u11FF]/g], ["hi", /[\u0900-\u097F]/g],
    ["th", /[\u0E00-\u0E7F]/g],
  ];
  let best = null, bestCount = 0;
  for (const [code, re] of ranges) {
    const m = s.match(re);
    if (m && m.length > bestCount) { best = code; bestCount = m.length; }
  }
  if (best) return best;
  const low = " " + s.toLowerCase() + " ";
  const fp = (words) => words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
  const scores = [
    ["el", fp([" και ", " είναι ", " που ", " να ", " δεν ", " για ", " το ", " την ", " ένα ", " μου "])],
    ["en", fp([" the ", " and ", " is ", " you ", " what ", " how ", " can ", " to ", " of ", " i ", " a "])],
    ["de", fp([" und ", " der ", " die ", " das ", " ich ", " nicht ", " ist ", " wie ", " ein ", " zu "])],
    ["fr", fp([" le ", " la ", " les ", " et ", " est ", " je ", " vous ", " que ", " merci ", " pas "])],
    ["es", fp([" el ", " la ", " los ", " las ", " y ", " es ", " cómo ", " no ", " para ", " ahora "])],
    ["it", fp([" il ", " lo ", " la ", " che ", " è ", " non ", " come ", " per "])],
    ["pt", fp([" o ", " a ", " os ", " e ", " é ", " não ", " como ", " você ", " para "])],
    ["nl", fp([" de ", " het ", " een ", " en ", " is ", " niet ", " ik ", " wat "])],
    ["pl", fp([" i ", " jest ", " nie ", " jak ", " co ", " się ", " to "])],
    ["tr", fp([" ve ", " bir ", " bu ", " için ", " nasıl ", " ne ", " ben "])],
    ["sv", fp([" och ", " är ", " inte ", " jag ", " vad ", " hur ", " det "])],
  ];
  let bestLang = "en", bestScore = 0;
  for (const [code, sc] of scores) if (sc > bestScore) { bestScore = sc; bestLang = code; }
  return bestScore > 0 ? bestLang : "en";
}

function detectEmotion(text) {
  const s = String(text || "");
  const t = s.trim();
  if (!t) return "neutral";
  const low = t.toLowerCase();
  const hasLatin = (re) => re.test(t);
  const hasAny = (list) => list.some((w) => low.includes(w));
  const profanityLatin = /\b(fuck|fucking|shit|bitch|asshole|damn|hell|crap|stupid|idiot|moron|dumb|useless|garbage|trash|broken|crashed|terrible|awful|worst|ridiculous|waste of time)\b/i;
  const profanityAny = ["malakia", "μαλακία", "μαλακίες", "σκατά", "ηλίθιο", "χάλια", "απαράδεκτο", "βλακεία", "βλακείες", "merde", "putain", "scheiße", "verdammt", "mierda", "coño", "joder", "cazzo", "kurwa", "blyat", "гавно", "дурак"];
  if (profanityLatin.test(t) || hasAny(profanityAny)) return "anger";
  const letters = (t.match(/[A-Za-zΑ-Ωα-ω]/g) || []).length;
  const caps = (t.match(/[A-ZΑ-Ω]/g) || []).length;
  if (letters > 8 && caps / letters > 0.6) return "anger";
  if (/[!]{2,}/.test(t)) return "frustration";
  if (/[?]{3,}/.test(t)) return "frustration";
  if (hasLatin(/\b(angry|pissed|mad|furious|hate|fed up|sick of|tired of|annoyed|outraged)\b/i)) return "anger";
  if (hasAny(["θυμωμένος", "νευριασμένος", "οργισμένος", "νεύρα", "μισώ", "βαρέθηκα", "αηδία"])) return "anger";
  if (hasLatin(/\b(not working|doesn't work|won't work|doesnt work|still not|again|tried|failed|keeps|broken|error|bug|stuck|can't|cant|unable|why won't)\b/i)) return "frustration";
  if (hasAny(["δεν δουλεύει", "δεν λειτουργεί", "ξανά", "προσπάθησα", "κόλλησε", "σφάλμα", "δεν μπορώ", "γιατί δεν", "πάλι", "κολλάει"])) return "frustration";
  if (hasLatin(/\b(confused|don't understand|dont understand|what do you mean|how do i|how does|explain|unclear|not sure|help me understand)\b/i)) return "confusion";
  if (hasAny(["δεν καταλαβαίνω", "τι εννοείς", "εξήγησε", "μπερδεμένος", "τι σημαίνει", "βοήθησέ με", "verstehe nicht", "no entiendo", "ne comprends pas"])) return "confusion";
  if (hasLatin(/\b(urgent|asap|immediately|right now|emergency|hurry|quick|fast|today|deadline)\b/i)) return "urgency";
  if (hasAny(["επείγον", "αμέσως", "τώρα", "γρήγορα", "άμεσα", "βιάζομαι", "σήμερα", "προθεσμία", "ahora mismo", "sofort", "maintenant"])) return "urgency";
  if (hasLatin(/\b(complaint|unacceptable|disappointed|disappointing|poor service|bad service|refund|chargeback|done with)\b/i)) return "complaint";
  if (hasAny(["παράπονο", "απογοητευμένος", "απογοήτευση", "κακή εξυπηρέτηση", "επιστροφή χρημάτων"])) return "complaint";
  if (hasLatin(/\b(thanks|thank you|great|awesome|perfect|excellent|amazing|love it|nice|good job|well done|works|finally|merci|gracias|danke)\b/i)) return "positive";
  if (hasAny(["ευχαριστώ", "τέλεια", "υπέροχα", "άριστα", "καταπληκτικό", "μπράβο", "επιτέλους", "δουλεύει"])) return "positive";
  return "neutral";
}

function detectLoop(historyTexts) {
  const arr = Array.isArray(historyTexts) ? historyTexts : [];
  const userMsgs = arr.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean);
  if (userMsgs.length < 2) return false;
  const last = userMsgs[userMsgs.length - 1];
  if (last.length < 4) return false;
  let same = 0;
  for (let i = userMsgs.length - 1; i >= 0 && same < 3; i--) {
    if (userMsgs[i] === last || (userMsgs[i].length > 4 && last.includes(userMsgs[i].slice(0, Math.min(20, userMsgs[i].length))))) same++;
    else break;
  }
  return same >= 2;
}

function emotionDirective(text, language, historyTexts) {
  const state = detectEmotion(text);
  const lang = language || detectLanguage(text);
  const langLine = lang && lang !== "en"
    ? `The user is writing in language code "${lang}". Answer in that same language.`
    : `Answer in the user's language.`;
  const base = `USER STATE GUIDANCE (apply tone only — never change facts, never lie):
${langLine}
Stay respectful and calm at all times. If the user is impolite, do not mirror it — stay warm, professional, and solution-focused. Never use mock/demo/placeholder data; give real, verifiable answers.`;
  switch (state) {
    case "anger": return `${base}\nThe user is angry or using harsh language. DO NOT over-apologize or say "I understand your frustration" (that sounds fake). Instead: (1) acknowledge the specific problem in ONE short sentence, (2) immediately take a concrete action or give the exact next step, (3) keep it short and calm. De-escalate by solving, not by emotional filler. Never mirror the anger.`;
    case "frustration": return `${base}\nThe user is frustrated (something did not work). Skip small talk. Acknowledge briefly, then move straight to problem-solving: give the concrete fix or the exact next step now. If you cannot resolve it, say what they should do next clearly. No "sorry to hear that" filler.`;
    case "confusion": return `${base}\nThe user is confused. Simplify. Break the answer into short, clear steps. Ask ONE focused clarifying question only if genuinely needed to proceed. Avoid jargon; define any technical term you must use.`;
    case "urgency": return `${base}\nThe user needs this fast. Match their pace: lead with the most important answer first, skip pleasantries, keep it tight. Give the key info immediately, then details only if needed.`;
    case "complaint": return `${base}\nThe user is complaining and wants to be heard. Acknowledge plainly without performing ("That should not have happened."), then state exactly what you can do about it and the next step. Do not be defensive.`;
    case "positive": return `${base}\nThe user is pleased. Be warm and brief. Thank them once, confirm the outcome, and offer the natural next step without overdoing it.`;
    default: return `${base}\nMatch the user's tone and pace. Be direct, clear, and genuinely helpful. If anything is ambiguous, ask one short clarifying question rather than guessing.`;
  }
}

function applyEmpathy(messages) {
  const userTexts = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).filter(Boolean);
  if (!userTexts.length) return messages;
  const lastUser = userTexts[userTexts.length - 1];
  const history = userTexts.slice(0, -1);
  const language = detectLanguage(lastUser);
  const state = detectEmotion(lastUser);
  const loop = detectLoop(history);
  if (state === "neutral" && language === "en" && !loop) return messages;
  return [{ role: "system", content: emotionDirective(lastUser, language, history) }, ...messages];
}
// localization-skip:end

// ── AI routes (free-first) ────────────────────────────────────────────────
async function workersAiChat(env, messages) {
  if (!env.AI) return null;
  try {
    const inputs = {
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
        content: typeof m.content === "string" ? m.content.slice(0, 8000) : String(m.content || "").slice(0, 8000),
      })),
    };
    const out = await env.AI.run(FREE_MODEL, inputs);
    const content = typeof out === "string" ? out : out?.response;
    return content ? { content: String(content).trim(), engine: "workers-ai", model: FREE_MODEL, finishReason: "stop" } : null;
  } catch {
    return null;
  }
}

// Normalize caller model aliases to real DeepSeek ids. Perplexity/NovaDevs send
// "standard" (or omit it); the DeepSeek API only accepts deepseek-v4-pro /
// deepseek-flash. Without this, an alias like "standard" is rejected and the
// route silently falls to a model that truncates code (Owner 2026-09-18).
function normalizeDeepseekModel(m) {
  const id = String(m || "");
  if (id === "deepseek-flash" || id === "deepseek-v4-flash" || id === "deepseek-chat" || id === "deepseek-v3.2") return "deepseek-flash";
  return DEEPSEEK_MODEL; // "standard", "deepseek-v4-pro", "deepseek-reasoner", anything else
}

async function deepseekChat(env, messages, opts = {}) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const body = { model: normalizeDeepseekModel(opts.model), messages, temperature: opts.temperature ?? 0.6, max_tokens: opts.maxTokens || 8192 };
    if (opts.jsonMode) body.response_format = { type: "json_object" };
    body.thinking = { type: opts.thinking ? "enabled" : "disabled" };
    const res = await fetch(`${DEEPSEEK}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    return content ? { content: String(content).trim(), engine: "deepseek", model: body.model, finishReason: choice?.finish_reason === "length" ? "length" : "stop" } : null;
  } catch { return null; }
}

async function alibabaChat(env, messages) {
  const key = env.ALIBABA_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${ALIBABA_CHAT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: ALIBABA_MODEL, messages, temperature: 0.6, max_tokens: 8192 }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    return content ? { content: String(content).trim(), engine: "alibaba", model: ALIBABA_MODEL, finishReason: choice?.finish_reason === "length" ? "length" : "stop" } : null;
  } catch { return null; }
}

async function geminiChat(env, messages) {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;
  const parts = messages.filter((m) => m.role === "user" || m.role === "system" || m.role === "assistant")
    .map((m) => ({ text: typeof m.content === "string" ? m.content : "" })).filter((p) => p.text);
  if (!parts.length) return null;
  try {
    const res = await fetch(`${GEMINI}/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: parts.map((p) => ({ role: "user", parts: [p] })) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    return text ? { content: text, engine: "gemini", model: GEMINI_MODEL, finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop" } : null;
  } catch { return null; }
}

async function chatCompletion(env, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return { status: 400, body: { error: { message: "messages required" } } };
  const baseMessages = applyEmpathy(messages);

  // DeepSeek-compatible flags (NovaDevs builder sends these). JSON mode and
  // thinking skip the free Workers-AI tier (it has no json/thinking support)
  // and go straight to DeepSeek V4 Pro — same contract as api.deepseek.com.
  const jsonMode = body?.response_format?.type === "json_object";
  const thinking = body?.thinking?.type === "enabled";
  const opts = { jsonMode, thinking, maxTokens: body?.max_tokens, temperature: body?.temperature, model: body?.model };

  // Build/long-form detection (Owner 2026-09-18): the free Workers AI model
  // truncates long code and reports finish_reason "stop" (so the continuation
  // loop never fires and the user gets a HALF app). For build/code/app/game
  // requests we skip the free tier and go straight to DeepSeek V4 Pro, which
  // reports finish_reason="length" correctly and lets the loop keep writing
  // until the artifact is complete.
  const lastUser = [...baseMessages].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
  // NOTE: JavaScript \b is ASCII-only, so Greek build words must be matched as
  // plain substrings (no \b). English words keep \b. A build/code/game request
  // in ANY language must skip the free truncating model and go to DeepSeek.
  const wantsBuild =
    /\b(build|create|make|write|generate|code|app|game|website|dashboard|landing|html|site|write me|build me|make me)\b/i.test(lastText) ||
    /(φτιάξε|κατασκεύασε|δημιούργησε|γράψε|κάνε|χτίσε|παιχνίδι|εφαρμογή|ιστοσελίδα|ιστοσελίδας|Tetris|calculator|todo|snake|pong)/i.test(lastText);

  // Deterministic-first (Phase A, Law 248): if this is a bot/tool/edge job,
  // route it WITHOUT the AI ladder. 0 tokens. The LLM is the LAST resort.
  // Build requests and json/thinking always skip this and go to DeepSeek.
  const det = detectDeterministicTask(lastText);
  if (det && !jsonMode && !thinking && !wantsBuild) {
    return {
      status: 200,
      body: {
        id: `atlas_${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "atlas-proxy/deterministic",
        choices: [{ index: 0, message: { role: "assistant", content: `[deterministic] ${det.el} — route: ${det.endpoint || det.bot || det.tool} (0 tokens, no AI).` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        atlas_engine: "deterministic",
        deterministic_route: det,
      },
    };
  }

  // JSON mode = single structured shot (no continuation), like the local proxy.
  if (jsonMode) {
    const route = await deepseekChat(env, baseMessages, opts);
    if (!route) return { status: 502, body: { error: { message: "all_ai_routes_failed" } } };
    return {
      status: 200,
      body: {
        id: `atlas_${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: `atlas-proxy/${route.engine}`,
        choices: [{ index: 0, message: { role: "assistant", content: route.content }, finish_reason: route.finishReason }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        atlas_engine: route.engine,
      },
    };
  }

  let full = "", engine = null, model = null, finishReason = "stop";
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const batch = i === 0 ? baseMessages : [...baseMessages, { role: "assistant", content: full }, { role: "user", content: "Continue exactly where you left off. Do not repeat anything already written." }];
    const route = thinking
      ? await deepseekChat(env, batch, opts)
      : (wantsBuild ? null : await workersAiChat(env, batch))
        ?? await deepseekChat(env, batch, opts)
        ?? await alibabaChat(env, batch)
        ?? await geminiChat(env, batch);
    if (!route) break;
    engine = route.engine;
    model = route.model;
    full += route.content;
    finishReason = route.finishReason === "length" ? "length" : "stop";
    if (finishReason !== "length") break;
  }
  if (!full) return { status: 502, body: { error: { message: "all_ai_routes_failed" } } };
  return {
    status: 200,
    body: {
      id: `atlas_${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: `atlas-proxy/${engine}`,
      choices: [{ index: 0, message: { role: "assistant", content: full }, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      atlas_engine: engine,
    },
  };
}

async function imageGeneration(env, body) {
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return { status: 400, body: { error: { message: "prompt required" } } };
  // Qwen image generation takes 30-90s — longer than a Cloudflare Worker can
  // hold a single dashscope subrequest (it hit the wall-clock cap and the
  // "thumbnail" QA test kept aborting with a timeout). The Atlas VPS has no
  // such cap and already exposes /v1/images/generations, so forward there —
  // same key, same contract as mediaForward.
  const raw = String(env.VPS_MEDIA_URL || env.VPS_TTS_URL || "http://204.168.146.194:8790").replace(/\/+$/, "");
  const vpsBase = raw.replace(/\/v1\/audio\/speech$/, "");
  try {
    const res = await fetch(`${vpsBase}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (e) {
    console.error(`[gateway] image gen VPS failed: ${e?.name || "error"} ${e?.message || e}`);
    return { status: 502, body: { error: { message: "image_vps_unavailable" } } };
  }
}

const AZURE_VOICE_BY_LANG = {
  "en-US": "en-US-AvaNeural", "el-GR": "el-GR-AthinaNeural", "zh-CN": "zh-CN-XiaoxiaoNeural",
  "es-ES": "es-ES-ElviraNeural", "fr-FR": "fr-FR-DeniseNeural", "de-DE": "de-DE-KatjaNeural",
  "it-IT": "it-IT-ElsaNeural", "pt-BR": "pt-BR-FranciscaNeural", "ru-RU": "ru-RU-SvetlanaNeural",
  "ja-JP": "ja-JP-NanamiNeural", "ko-KR": "ko-KR-SunHiNeural", "ar-SA": "ar-SA-ZariyahNeural",
  "he-IL": "he-IL-HilaNeural", "hi-IN": "hi-IN-SwaraNeural", "th-TH": "th-TH-PremwadeeNeural",
  "tr-TR": "tr-TR-EmelNeural", "nl-NL": "nl-NL-ColetteNeural", "pl-PL": "pl-PL-ZofiaNeural",
  "sv-SE": "sv-SE-SofieNeural",
};
function azureVoice(lang) {
  const l = String(lang || "en-US");
  if (AZURE_VOICE_BY_LANG[l]) return AZURE_VOICE_BY_LANG[l];
  return "en-US-AvaNeural";
}
function escXml(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
async function speech(env, body) {
  const text = String(body?.input ?? body?.text ?? "").trim();
  if (!text) return { status: 400, body: { error: { message: "input required" } } };
  const lang = String(body?.lang || "en-US");
  const voice = body?.voice ? String(body.voice) : azureVoice(lang);

  // 1) Azure neural TTS (house voice Ava) — only if a valid key is present.
  const key = env.AZURE_SPEECH_KEY;
  if (key) {
    const region = String(env.AZURE_SPEECH_REGION || "northeurope");
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escXml(lang)}"><voice name="${escXml(voice)}">${escXml(text)}</voice></speak>`;
    try {
      const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "AtlasProxy" },
        body: ssml,
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length >= 200) return { status: 200, engine: "azure", voice, raw: buf, mime: "audio/mpeg" };
      }
    } catch { /* fall through to free Edge TTS */ }
  }

  // 2) FREE Edge neural TTS via the Atlas VPS (same Ava/Athina voices, zero cost,
  //    no Azure key). The VPS runs edge-tts 7.2.8 and serves /v1/audio/speech.
  try {
    const vpsUrl = String(env.VPS_TTS_URL || "http://204.168.146.194:8790/v1/audio/speech");
    const res = await fetch(vpsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: JSON.stringify({ text: text.slice(0, 5000), voice, lang }),
      signal: AbortSignal.timeout(60000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.audio) {
        const buf = Uint8Array.from(atob(data.audio.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
        if (buf.length >= 200) return { status: 200, engine: "edge", voice: data.voice || voice, raw: buf, mime: data.format === "mp3" ? "audio/mpeg" : "audio/wav" };
      }
      console.error(`[gateway] edge-tts VPS no audio: ${JSON.stringify(data).slice(0, 200)}`);
    } else {
      console.error(`[gateway] edge-tts VPS HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`[gateway] edge-tts VPS fetch failed: ${e?.name || "error"} ${e?.message || e}`);
  }

  return { status: 502, body: { error: { message: "tts_backend_unavailable" } } };
}

// ── Deterministic media pipeline (forward to Atlas VPS, where FFmpeg lives) ──
// Cloudflare Workers cannot run FFmpeg, so image/video/audio editing is served
// by the Atlas VPS proxy (Node + FFmpeg 6.1 + libass). Same key, same contract.
async function mediaForward(env, path, body) {
  // VPS_MEDIA_URL is the clean base (http://host:8790). If only VPS_TTS_URL is
  // set (ends with /v1/audio/speech), derive the base by stripping that suffix.
  const raw = String(env.VPS_MEDIA_URL || env.VPS_TTS_URL || "http://204.168.146.194:8790").replace(/\/+$/, "");
  const vpsBase = raw.replace(/\/v1\/audio\/speech$/, "");
  const vpsPath = path.replace(/^\/v2\//, "/v1/"); // /v2 aliases forward to the VPS /v1 contract
  try {
    const res = await fetchWithRetry(`${vpsBase}${vpsPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (e) {
    console.error(`[gateway] media VPS failed: ${e?.name || "error"} ${e?.message || e}`);
    return { status: 503, body: { error: { message: "vps_media_unavailable", retryable: true } } };
  }
}

// Automation engine relay → VPS-2 atlas-automations (:8792) — N8n-style 24/7
// workflow engine (free Ollama + 75 tools). Same shared key. Uses an sslip.io
// hostname (not a raw IP) because Cloudflare's outbound fetch blocks raw-IP
// fetches to non-standard ports (403); the DNS-resolved name works.
async function automationsForward(env, path, method, body) {
  const base = String(env.VPS_AUTOMATIONS_URL || "http://2.28.137.247.sslip.io:8792").replace(/\/+$/, "");
  try {
    const res = await fetchWithRetry(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (e) {
    console.error(`[gateway] automations VPS failed: ${e?.name || "error"} ${e?.message || e}`);
    return { status: 503, body: { error: { message: "vps_automations_unavailable", retryable: true } } };
  }
}

// Arsenal tools relay → Atlas VPS → atlas-tools runner (75 local tools, 24/7).
async function arsenalForward(env, path, method, body) {
  const raw = String(env.VPS_MEDIA_URL || env.VPS_TTS_URL || "http://204.168.146.194:8790").replace(/\/+$/, "");
  const vpsBase = raw.replace(/\/v1\/audio\/speech$/, "");
  try {
    const res = await fetchWithRetry(`${vpsBase}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (e) {
    console.error(`[gateway] arsenal VPS failed: ${e?.name || "error"} ${e?.message || e}`);
    return { status: 503, body: { error: { message: "vps_arsenal_unavailable", retryable: true } } };
  }
}

// Bot + agent bridge relay → VPS-1 atlas-bot-bridge (:8793) — the "second
// Atlas" half (43 bots + 20 agents, 24/7). sslip.io hostname because Cloudflare
// outbound fetch blocks raw-IP fetches to non-standard ports.
async function botBridgeForward(env, path, method, body) {
  const base = String(env.VPS_BOT_BRIDGE_URL || "http://204.168.146.194.sslip.io:8793").replace(/\/+$/, "");
  try {
    const res = await fetchWithRetry(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ATLAS_PROXY_KEY || ""}` },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  } catch (e) {
    console.error(`[gateway] bot-bridge VPS failed: ${e?.name || "error"} ${e?.message || e}`);
    return { status: 503, body: { error: { message: "vps_bot_bridge_unavailable", retryable: true } } };
  }
}

const MODELS = {
  object: "list",
  data: [
    { id: "atlas-proxy/free", object: "model", owned_by: "gateway", created: 0 },
    { id: "atlas-proxy/standard", object: "model", owned_by: "gateway", created: 0 },
    { id: "atlas-proxy/genius", object: "model", owned_by: "gateway", created: 0 },
  ],
};

// ── Capability registry (Owner 2026-09-28) ────────────────────────────────
// Single source of truth for "what can the Atlas system do, and WHERE does it
// run". Every platform asks the proxy this (unauthenticated, metadata only —
// no secrets, no keys) so it knows exactly which abilities are available 24/7
// (edge/vps) vs. which need the Owner's PC on (local builder). This is how
// "one unified system" is described to the platforms it serves.
const CAPABILITIES = {
  contract_version: CONTRACT_VERSION,
  tiers: {
    edge: { name: "Cloudflare Edge", availability: "24/7", note: "light AI chat (free-first) + TTS + routing/auth — no filesystem/Docker/FFmpeg" },
    vps: { name: "Atlas VPS (Hetzner)", availability: "24/7", note: "heavy compute: FFmpeg media + Python intelligence + sandbox + keyless search + free Ollama" },
    tools: { name: "Atlas Tools (atlas-tools cx33)", availability: "24/7", note: "75 arsenal tools (crawl/QA/security/SEO/OSINT/media/code/Web3) — deterministic, zero tokens" },
    local: { name: "Owner PC (builder)", availability: "only while the PC is on", note: "primary cockpit/builder — agents+bots run 24/7 on VPS (bot-bridge :8793)" },
  },
  abilities: {
    chat: { tier: ["edge", "vps"], freeFirst: true, route: "Workers AI (free) → DeepSeek V4 Pro → Qwen → Gemini", endpoint: "/v1/chat/completions" },
    tts: { tier: ["edge", "vps"], freeFirst: true, route: "Azure Ava/Athina → Edge TTS (free)", endpoint: "/v1/audio/speech" },
    image: { tier: ["vps"], route: "Qwen Image", endpoint: "/v1/images/generations" },
    media: { tier: ["vps"], route: "FFmpeg edit/video/audio", endpoint: "/v1/images/edits · /v1/video/process · /v1/audio/process" },
    transcribe: { tier: ["vps"], route: "Whisper (faster-whisper)", endpoint: "/v1/media/transcribe" },
    ocr: { tier: ["vps"], route: "Tesseract", endpoint: "/v1/media/ocr" },
    qr: { tier: ["vps"], route: "pyzbar", endpoint: "/v1/media/qr" },
    palette: { tier: ["vps"], route: "Pillow", endpoint: "/v1/media/palette" },
    faceBlur: { tier: ["vps"], route: "OpenCV", endpoint: "/v1/media/face-blur" },
    colorIsolate: { tier: ["vps"], route: "OpenCV", endpoint: "/v1/media/color-isolate" },
    removeBg: { tier: ["vps"], route: "rembg", endpoint: "/v1/media/remove-background" },
    vision: { tier: ["vps"], route: "Gemini vision", endpoint: "/v1/media/vision" },
    generativeEdit: { tier: ["vps"], route: "Gemini image edit", endpoint: "/v1/media/generative-edit" },
    python: { tier: ["vps"], route: "sandbox (stdlib)", endpoint: "/v1/python/run" },
    search: { tier: ["edge", "vps"], route: "edge Bing+DDG scrape (edge) / Wikipedia + DDG (vps)", endpoint: "/v1/search" },
    automations: { tier: ["tools"], freeFirst: true, route: "N8n-style Automation Engine (VPS-2 :8792) — free Ollama qwen3/gemma3 + 75 tools", endpoint: "/v1/automations · /v1/automations/status" },
    harvest: { tier: ["vps"], freeFirst: true, route: "Global lead harvest rotator (VPS-1) — 40 countries × 40 categories, Crawl4AI+SearXNG, 24/7", endpoint: "relay /api/atlas/* (VPS-1 :4381)" },
    agents: { tier: ["vps"], route: "20-agent roster + execution (bot-bridge :8793 · DeepSeek via remote-runner :8789)", endpoint: "/v1/agents" },
    bots: { tier: ["vps"], route: "43-bot squadron deterministic sweep/run (bot-bridge :8793, 24/7)", endpoint: "/v1/bots · /v1/bots/sweep · /v1/bots/run · /v1/bots/audit" },
    tools: { tier: ["tools"], route: "75 arsenal tools via atlas-tools-runner", endpoint: "/v1/arsenal · /v1/arsenal/run" },
  },
};

// ── Edge web search (Bing + DDG scrape) ───────────────────────────────────
// Runs on Cloudflare's edge (residential-grade egress that search engines do
// NOT block, unlike the VPS's Hetzner datacenter IP). Returns real destination
// URLs for the Nova Outreach global lead harvester. No key required.
const SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&lt;/g, "<").replace(/&#60;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#62;/g, ">").replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}
function cleanUrl(u) {
  try {
    const x = new URL(u);
    return (x.protocol === "http:" || x.protocol === "https:") ? x.toString() : "";
  } catch { return ""; }
}
function resolveDdg(u) {
  const m = String(u || "").match(/[?&]uddg=([^&]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return u; } }
  return u.startsWith("//") ? "https:" + u : u;
}
function decodeBing(u) {
  const m = String(u || "").match(/[?&]u=([^&]+)/i);
  if (!m) return "";
  try {
    let b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return cleanUrl(Buffer.from(b, "base64").toString("utf8"));
  } catch { return ""; }
}

function parseAnchorHrefs(html, re, mapper, limit) {
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = mapper(m[1]);
    const title = stripTags(decodeEntities(m[2]));
    if (url && title) out.push({ title, url });
  }
  return out.slice(0, limit);
}

async function bingResults(query, limit) {
  const html = await (await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(10, limit)}&setlang=en&mkt=en-US`, {
    headers: { "User-Agent": SEARCH_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(15000),
  })).text();
  let out = parseAnchorHrefs(html, /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (raw) => {
    const r = decodeEntities(raw);
    return /bing\.com\/ck\/a/i.test(r) ? decodeBing(r) : cleanUrl(r);
  }, limit);
  if (!out.length) {
    // Bing changed class name — generic <h2><a> result pattern.
    out = parseAnchorHrefs(html, /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (raw) => {
      const r = decodeEntities(raw);
      return /bing\.com\/ck\/a/i.test(r) ? decodeBing(r) : cleanUrl(r);
    }, limit).filter((x) => !/bing\.com|microsoft|msn\.com|go\.microsoft/i.test(x.url));
  }
  return out;
}

async function ddgResults(query, limit) {
  // DDG Lite is a minimal HTML endpoint that is far less likely to be blocked.
  const html = await (await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": SEARCH_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(15000),
  })).text();
  let out = parseAnchorHrefs(html, /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (raw) => cleanUrl(resolveDdg(decodeEntities(raw))), limit);
  if (!out.length) {
    // html.duckduckgo.com fallback (result__a).
    const html2 = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": SEARCH_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow", signal: AbortSignal.timeout(15000),
    })).text();
    out = parseAnchorHrefs(html2, /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (raw) => cleanUrl(resolveDdg(decodeEntities(raw))), limit);
  }
  return out;
}

async function mojeekResults(query, limit) {
  const html = await (await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": SEARCH_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(15000),
  })).text();
  return parseAnchorHrefs(html, /<a[^>]+class="[^"]*ob[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (raw) => cleanUrl(decodeEntities(raw)), limit);
}

async function qwantResults(query, limit) {
  const html = await (await fetch(`https://www.qwant.com/?q=${encodeURIComponent(query)}&t=web&count=${limit}`, {
    headers: { "User-Agent": SEARCH_UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(15000),
  })).text();
  // Qwant result links carry data-url attributes with the real destination.
  const out = [];
  const re = /<a[^>]+data-url="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = cleanUrl(decodeEntities(m[1]));
    const title = stripTags(decodeEntities(m[2]));
    if (url && title && out.length < limit) out.push({ title, url });
  }
  return out;
}

async function edgeWebSearch(env, query, limit) {
  // Try each engine until one returns results (Cloudflare egress is shared, so
  // any single engine can rate-limit — rotate across independent indexes).
  const attempts = [
    () => bingResults(query, limit),
    () => ddgResults(query, limit),
    () => mojeekResults(query, limit),
    () => qwantResults(query, limit),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await attempts[i]();
      if (r && r.length) return r;
    } catch { /* next engine */ }
  }
  // Optional SearXNG backend if configured (aggregates many engines, keyless).
  if (env.SEARXNG_URL) {
    try {
      const r = await (await fetch(`${env.SEARXNG_URL}?q=${encodeURIComponent(query)}&format=json`, {
        headers: { "User-Agent": SEARCH_UA }, signal: AbortSignal.timeout(15000),
      })).json();
      const results = (r?.results || []).filter((x) => x?.url).map((x) => ({ title: x.title || x.url, url: x.url })).slice(0, limit);
      if (results.length) return results;
    } catch { /* empty */ }
  }
  return [];
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const started = Date.now();
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/health") return json({ ok: true, service: "gateway", contract_version: CONTRACT_VERSION, time: new Date().toISOString() });
    // Static metadata (Phase D cache — 60s module-scope, no recompute).
    if (path === "/v1/models" || path === "/v2/models") return json(cachedJson("models", () => ({ ...MODELS, contract_version: CONTRACT_VERSION, api_version: path.split("/")[1] })));
    if (path === "/v1/capabilities" || path === "/v2/capabilities" || path === "/capabilities") return json(cachedJson("capabilities", () => ({ ok: true, service: "gateway", ...CAPABILITIES })));
    if (path === "/v1/protocol" || path === "/v2/protocol" || path === "/protocol") return json(cachedJson("protocol", () => ({ ok: true, service: "gateway", protocol: PROXY_PROTOCOL, protocol_version: PROXY_PROTOCOL_VERSION, contract_version: CONTRACT_VERSION })));
    if (path === "/v1/tasks" || path === "/v2/tasks" || path === "/tasks") return json(cachedJson("tasks", () => ({ ok: true, service: "gateway", tasks: DETERMINISTIC_TASKS, contract_version: CONTRACT_VERSION })));
    if (!authorized(req, env)) { console.log(`[gateway] ${path} 401`); return json({ error: { message: "unauthorized" } }, 401); }

    // Phase E: per-key usage metering — report today's counters for THIS key
    // (no cross-tenant visibility, values hashed, key never logged).
    if (path === "/v1/usage" && req.method === "GET") {
      const id = resolveIdentity(req, env);
      const usage = await readUsage(env, id?.key || "anon");
      const limit = quotaFor(env, id?.key, id?.platform);
      return json({ ok: true, service: "gateway", platform: id?.platform || null, usage, rate_limit_per_min: limit });
    }

    // Phase D rate limit (per-key sliding window). 429 with Retry-After.
    if (await rateLimited(req, env)) {
      console.log(`[gateway] ${path} 429 rate-limited`);
      return new Response(JSON.stringify({ error: { message: "rate_limited", type: "insufficient_quota", retry_after_ms: RL_WINDOW_MS } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(RL_WINDOW_MS / 1000)), ...CORS },
      });
    }

    // Edge web search (Bing + DDG scrape) — GET /v1/search?q=...&limit=10
    if ((path === "/v1/search" || path === "/v2/search") && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const q = String(url.searchParams.get("q") || body?.q || body?.query || "").trim();
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || body?.limit || 10)));
      if (!q) return json({ error: { message: "q required" } }, 400);
      const results = await edgeWebSearch(env, q, limit);
      console.log(`[gateway] ${req.method} /v1/search n=${results.length} ${Date.now() - started}ms`);
      return json({ ok: true, query: q, results, engine: "edge-bing+ddg" });
    }

    if ((path === "/v1/chat/completions" || path === "/v2/chat/completions" || path === "/chat/completions" || path === "/v1/free/chat/completions") && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await chatCompletion(env, body);
      console.log(`[gateway] POST ${path} ${out.status} engine=${out.body?.atlas_engine || "n/a"} ${Date.now() - started}ms`);
      // Phase E: meter this request (fire-and-forget — never block the response).
      const id = resolveIdentity(req, env);
      if (id?.key && out.status < 500) recordUsage(env, id.key, estimateTokens(body)).catch(() => {});
      return json(out.body, out.status);
    }
    if ((path === "/v1/images/generations" || path === "/v2/images/generations") && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await imageGeneration(env, body);
      console.log(`[gateway] POST /v1/images/generations ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if ((path === "/v1/audio/speech" || path === "/v2/audio/speech") && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await speech(env, body);
      if (out.raw) {
        return new Response(out.raw, { status: 200, headers: { "Content-Type": out.mime || "audio/mpeg", ...CORS } });
      }
      return json(out.body, out.status);
    }
    if (["/v1/media/inspect", "/v2/media/inspect", "/v1/images/edits", "/v2/images/edits", "/v1/video/process", "/v2/video/process", "/v1/audio/process", "/v2/audio/process", "/v1/media/transcribe", "/v2/media/transcribe", "/v1/media/remove-background", "/v2/media/remove-background", "/v1/media/ocr", "/v2/media/ocr", "/v1/media/qr", "/v2/media/qr", "/v1/media/palette", "/v2/media/palette", "/v1/media/face-blur", "/v2/media/face-blur", "/v1/media/color-isolate", "/v2/media/color-isolate", "/v1/media/vision", "/v2/media/vision", "/v1/media/generative-edit", "/v2/media/generative-edit"].includes(path) && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await mediaForward(env, path, body);
      console.log(`[gateway] POST ${path} ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    // Arsenal tools relay → Atlas VPS → atlas-tools (75 local tools, 24/7).
    if (path === "/v1/arsenal" && req.method === "GET") {
      const out = await arsenalForward(env, path, "GET");
      console.log(`[gateway] GET /v1/arsenal ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if (path === "/v1/arsenal/run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await arsenalForward(env, path, "POST", body);
      console.log(`[gateway] POST /v1/arsenal/run ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if (/^\/v1\/arsenal\/[^/]+$/.test(path) && req.method === "GET") {
      const out = await arsenalForward(env, path, "GET");
      return json(out.body, out.status);
    }
    // Automation engine relay → VPS-2 :8792. Full CRUD + run + scheduler, so the
    // Atlas "Automations" UI can drive the 24/7 VPS engine (not just the local
    // Command Center). Auth passed through (worker injects ATLAS_PROXY_KEY).
    if (path === "/v1/automations/status" && req.method === "GET") {
      const out = await automationsForward(env, "/health", "GET");
      console.log(`[gateway] GET /v1/automations/status ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if (path.startsWith("/v1/automations")) {
      const vpsPath = "/api/automations" + path.slice("/v1/automations".length);
      const body = (req.method === "POST" || req.method === "PUT") ? await req.json().catch(() => ({})) : undefined;
      const out = await automationsForward(env, vpsPath, req.method, body);
      console.log(`[gateway] ${req.method} ${path} -> ${vpsPath} ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    // Bot + agent bridge relay → VPS-1 :8793 (43 bots + 20 agents, 24/7).
    // Auth injected by the worker (ATLAS_PROXY_KEY), same contract as arsenal.
    if (path === "/v1/bots" && req.method === "GET") {
      const out = await botBridgeForward(env, path, "GET");
      console.log(`[gateway] GET /v1/bots ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if (path === "/v1/agents" && req.method === "GET") {
      const out = await botBridgeForward(env, path, "GET");
      console.log(`[gateway] GET /v1/agents ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    if (path.startsWith("/v1/bots")) {
      const body = (req.method === "POST") ? await req.json().catch(() => ({})) : undefined;
      const out = await botBridgeForward(env, path, req.method, body);
      console.log(`[gateway] ${req.method} ${path} ${out.status} ${Date.now() - started}ms`);
      return json(out.body, out.status);
    }
    console.log(`[gateway] ${req.method} ${path} 404`);
    return json({ error: { message: "not_found" } }, 404);
  },
};
