/**
 * ATLAS PROXY — DETERMINISTIC-FIRST ROUTER (Phase A, Law 248)
 * ------------------------------------------------------------
 * Owner Χάρης (2026-10-04): "πολλές πλατφόρμες μπορεί να μην χρειάζονται ΚΑΝ AI".
 *
 * Before any request reaches the AI ladder (DeepSeek → Qwen → Gemini — never Workers AI),
 * we check: can a bot / tool / deterministic endpoint do this job with ZERO tokens?
 * If yes → route deterministically. The LLM is the LAST resort, never the first.
 *
 * This is the proxy-side registry of "what runs without AI" — the same idea as
 * Self-Healing Router (arxiv 2603.01548) and Compiled AI (arxiv 2604.05150):
 * routine control-flow is ROUTING, not REASONING.
 */

// The deterministic task registry. Each entry answers: "if a platform asks X,
// which bot/tool/endpoint does it WITHOUT burning a model?" tokens = 0 always.
export const DETERMINISTIC_TASKS = {
  web_search: {
    via: "edge",
    endpoint: "/v1/search",
    tokens: 0,
    el: "αναζήτηση web (νέα, τιμές, leads)",
    note: "Bing + DDG + Mojeek + Qwant + SearXNG rotation — no AI",
  },
  seo_check: {
    via: "bot",
    bot: "seo-surface",
    tokens: 0,
    el: "robots.txt + sitemap(s) + IndexNow έλεγχος",
    note: "bot: seo-surface (local fleet) — invisible sitemap = invisible platform",
  },
  page_health: {
    via: "bot",
    bot: "face-routes / triad-health",
    tokens: 0,
    el: "είναι οι σελίδες πάνω; (HTTP probe)",
    note: "bot: face-routes probes 43 routes · triad-health probes 3 services",
  },
  secret_scan: {
    via: "bot",
    bot: "secret-scan",
    tokens: 0,
    el: "σάρωση για διαρροή secrets",
    note: "bot: secret-scan (hardcoded secret scan, placeholder vs real-key)",
  },
  git_status: {
    via: "bot",
    bot: "git-dirty",
    tokens: 0,
    el: "uncommitted / unpushed αλλαγές",
    note: "bot: git-dirty (git status --porcelain + ref drift)",
  },
  crawl_page: {
    via: "tool",
    tool: "crawl4ai / arsenal",
    tokens: 0,
    el: "crawl σελίδας → Markdown",
    note: "tool: crawl4ai (VPS-1) ή /v1/arsenal (VPS-2) — no AI",
  },
  media_process: {
    via: "vps",
    endpoint: "/v1/media/*",
    tokens: 0,
    el: "FFmpeg / OCR / QR / face-blur / color-isolate",
    note: "VPS-1 :8790 — FFmpeg 6.1 + Tesseract + pyzbar + OpenCV",
  },
  tts: {
    via: "edge+vps",
    endpoint: "/v1/audio/speech",
    tokens: 0,
    el: "σύνθεση φωνής (Azure → Edge TTS free)",
    note: "Azure neural Ava/Athina → Edge TTS (VPS) — no LLM",
  },
  automation: {
    via: "tools",
    endpoint: "/v1/automations",
    tokens: 0,
    el: "24/7 Automation Engine (N8n-style)",
    note: "VPS-2 :8792 — free Ollama qwen3/gemma3 + 75 tools",
  },
  arsenal_tool: {
    via: "tools",
    endpoint: "/v1/arsenal/run",
    tokens: 0,
    el: "75 εργαλεία (crawl/QA/security/SEO/OSINT/media/code/Web3)",
    note: "atlas-tools-runner (VPS-2 :8791)",
  },
};

// Rule-based classifier (0 tokens, regex/keywords only). Conservative: only
// clear deterministic intents match. Everything else falls through to the AI
// ladder. Returns { task, endpoint, via } or null.
export function detectDeterministicTask(text) {
  const t = String(text || "").toLowerCase();

  // web search — explicit search intent (but NOT "search my code")
  if (
    /^(search\s+(for|the\s+web|online)|ψάξε|ψάξτε|αναζήτησ|αναζήτηση|βρες|βρείτε|google)\b/i.test(t.trim()) ||
    /(τι νέα|τελευταία νέα|τιμές για|τιμή του|current price|latest news|news about|price of)/i.test(t)
  ) {
    return { task: "web_search", endpoint: "/v1/search", via: "edge" };
  }

  // SEO
  if (/(seo|sitemap|robots\.txt|indexnow|visibility)/i.test(t)) {
    return { task: "seo_check", bot: "seo-surface", via: "bot" };
  }

  // page health / down check
  if (/(is my site down|site down|σελίδες πάνω|οι σελίδες είναι πάνω|health check|uptime|είναι πάνω η)/i.test(t)) {
    return { task: "page_health", bot: "face-routes / triad-health", via: "bot" };
  }

  // secret scan
  if (/(secret scan|scan for secrets|scan secrets|διαρροή secret|hardcoded key|leaked key)/i.test(t)) {
    return { task: "secret_scan", bot: "secret-scan", via: "bot" };
  }

  // crawl / scrape a page
  if (/(crawl|scrape|extract)\s+(the\s+)?(page|site|url|https?:\/\/)/i.test(t) || /κατέβασε τη σελίδα/i.test(t)) {
    return { task: "crawl_page", tool: "crawl4ai / arsenal", via: "tool" };
  }

  // media processing
  if (/(transcribe|ocr|face.?blur|remove background|extract qr|convert video|ffmpeg)/i.test(t)) {
    return { task: "media_process", endpoint: "/v1/media/*", via: "vps" };
  }

  return null;
}
