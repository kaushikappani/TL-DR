// ai.js
// Provider-agnostic AI layer. Supports Google Gemini and Groq.
// The background worker calls summarizePage() / answerQuestion(); this module
// builds a provider-neutral message list and dispatches to the right backend.

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-flash-latest",
    keysUrl: "https://aistudio.google.com/app/apikey",
  },
  groq: {
    label: "Groq",
    defaultModel: "openai/gpt-oss-120b",
    keysUrl: "https://console.groq.com/keys",
  },
};

// Models we used to offer that have since been retired; map them onto a current
// one so saved settings keep working instead of 404-ing at request time.
const RETIRED = {
  groq: {
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "llama-3.1-8b-instant": "openai/gpt-oss-20b",
    "llama3-70b-8192": "openai/gpt-oss-120b",
    "llama3-8b-8192": "openai/gpt-oss-20b",
    "mixtral-8x7b-32768": "openai/gpt-oss-20b",
    "gemma2-9b-it": "openai/gpt-oss-20b",
  },
  gemini: {
    "gemini-1.5-flash": "gemini-flash-latest",
    "gemini-1.5-flash-8b": "gemini-flash-lite-latest",
    "gemini-1.5-pro": "gemini-pro-latest",
    "gemini-1.0-pro": "gemini-flash-latest",
    "gemini-pro": "gemini-flash-latest",
  },
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ---- settings ----------------------------------------------------------

// Defaults for the personalization preferences.
export const PREF_DEFAULTS = {
  prefLength: "standard",   // brief | standard | detailed
  prefFormat: "bullets",    // bullets | paragraph | eli5
  prefLevel: "general",     // beginner | general | expert
  prefLanguage: "Auto",     // "Auto" = match the page, else a language name
  prefTone: "",             // free-text persona/tone, e.g. "explain like a developer"
};

/** Resolve a saved model id: fall back to the default, then retire-map it. */
function live(provider, saved) {
  const model = saved || PROVIDERS[provider].defaultModel;
  return RETIRED[provider][model] || model;
}

/** Extra model ids the user typed in on the options page. */
function normalizeCustom(raw) {
  const pick = (v) => (Array.isArray(v) ? v.filter((m) => typeof m === "string" && m.trim()) : []);
  return { gemini: pick(raw?.gemini), groq: pick(raw?.groq) };
}

export async function getSettings() {
  const s = await chrome.storage.sync.get([
    "provider",
    "geminiKey",
    "geminiModel",
    "groqKey",
    "groqModel",
    // model ids the user added by hand
    "customModels",
    // legacy keys from the Gemini-only version
    "apiKey",
    "model",
    // personalization preferences
    ...Object.keys(PREF_DEFAULTS),
  ]);

  const provider = s.provider || "gemini";

  // Migrate legacy single-key settings into the Gemini slot.
  const geminiKey = s.geminiKey || s.apiKey || "";
  const geminiModel = live("gemini", s.geminiModel || s.model);
  const groqKey = s.groqKey || "";
  const groqModel = live("groq", s.groqModel);

  const prefs = {
    prefLength: s.prefLength || PREF_DEFAULTS.prefLength,
    prefFormat: s.prefFormat || PREF_DEFAULTS.prefFormat,
    prefLevel: s.prefLevel || PREF_DEFAULTS.prefLevel,
    prefLanguage: s.prefLanguage || PREF_DEFAULTS.prefLanguage,
    prefTone: typeof s.prefTone === "string" ? s.prefTone : PREF_DEFAULTS.prefTone,
  };

  const customModels = normalizeCustom(s.customModels);

  return { provider, geminiKey, geminiModel, groqKey, groqModel, customModels, ...prefs };
}

/** The active provider's key + model. */
export async function getActive() {
  const s = await getSettings();
  if (s.provider === "groq") {
    return { provider: "groq", apiKey: s.groqKey, model: s.groqModel };
  }
  return { provider: "gemini", apiKey: s.geminiKey, model: s.geminiModel };
}

// ---- prompt building (provider-neutral) --------------------------------

const SUMMARY_SYSTEM =
  "You are a concise reading assistant. Summarize documents clearly for a busy reader. " +
  "Use plain language. Do not invent facts that are not in the content.";

const QA_SYSTEM =
  "You help the user understand a web page they are reading. " +
  "Prefer the provided document content as your primary source and cite specifics from it when relevant. " +
  "If the answer is not in the document, you may draw on your own general knowledge to give a helpful, related answer — " +
  "but make the distinction clear (e.g. 'The page doesn't cover this, but generally…'). " +
  "Do not present outside knowledge as if it came from the document, and don't fabricate specifics. " +
  "If you are unsure or the topic is beyond your knowledge, say so plainly. Be concise.";

// ---- personalization ---------------------------------------------------

// Per-length tuning for the summary format + token budget.
const LENGTH_SPEC = {
  brief:    { bullets: "2 to 3", tldr: "one sentence",        maxTokens: 400 },
  standard: { bullets: "3 to 6", tldr: "one or two sentences", maxTokens: 800 },
  detailed: { bullets: "6 to 10", tldr: "two or three sentences", maxTokens: 1400 },
};

function summaryInstructions(prefs) {
  const len = LENGTH_SPEC[prefs.prefLength] || LENGTH_SPEC.standard;

  if (prefs.prefFormat === "paragraph") {
    return (
      "\n\n---\nWrite a summary of the document above as flowing prose:\n\n" +
      `**TL;DR:** ${len.tldr} capturing the core point.\n\n` +
      "**Summary:** a short, well-structured paragraph (no bullet list) covering the most " +
      "important points.\n\nNo preamble, just the summary."
    );
  }
  if (prefs.prefFormat === "eli5") {
    return (
      "\n\n---\nExplain the document above like I'm five — very simple words, friendly tone:\n\n" +
      `**In short:** ${len.tldr}, in the simplest possible terms.\n\n` +
      `**The main ideas:**\n- ${len.bullets} super-simple bullet points.\n\n` +
      "Avoid jargon entirely. No preamble."
    );
  }
  // default: bullets
  return (
    "\n\n---\nWrite a summary of the document above in this exact format:\n\n" +
    `**TL;DR:** ${len.tldr} capturing the core point.\n\n` +
    `**Key points:**\n- ${len.bullets} short bullet points of the most important takeaways.\n\n` +
    "Keep it tight. No preamble, just the summary."
  );
}

// A system-prompt fragment expressing the user's persona/level/language prefs.
// Returned empty when nothing meaningful is set.
function prefsDirective(prefs) {
  const parts = [];

  if (prefs.prefLevel === "beginner") {
    parts.push("Assume the reader is a beginner: use simple vocabulary and explain any technical terms.");
  } else if (prefs.prefLevel === "expert") {
    parts.push("Assume the reader is an expert: be technical and precise; skip basic explanations.");
  }

  if (prefs.prefLanguage && prefs.prefLanguage !== "Auto") {
    parts.push(`Always respond in ${prefs.prefLanguage}, regardless of the document's language.`);
  }

  const tone = (prefs.prefTone || "").trim();
  if (tone) {
    // User free-text — keep it clearly fenced as a style instruction.
    parts.push(`Follow this style preference from the user: "${tone}".`);
  }

  return parts.length ? "\n\n" + parts.join(" ") : "";
}

function buildPageContext(page) {
  return [
    `TITLE: ${page.title}`,
    `SOURCE: ${page.siteName} (${page.url})`,
    page.description ? `DESCRIPTION: ${page.description}` : "",
    "",
    "DOCUMENT CONTENT:",
    page.text || "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- request builders (shared by streaming + non-streaming) ------------

function summaryRequest(page, prefs) {
  const len = LENGTH_SPEC[prefs.prefLength] || LENGTH_SPEC.standard;
  return {
    system: SUMMARY_SYSTEM + prefsDirective(prefs),
    turns: [{ role: "user", text: buildPageContext(page) + summaryInstructions(prefs) }],
    temperature: 0.3,
    maxTokens: len.maxTokens,
  };
}

function answerRequest(page, history, prefs) {
  const turns = [
    {
      role: "user",
      text:
        "Here is the web page the user is reading. Use it as your primary source, " +
        "and fall back to your general knowledge for related questions it doesn't cover:\n\n" +
        buildPageContext(page),
    },
    { role: "model", text: "Got it. I've read the page and will answer questions about it, drawing on general knowledge where the page falls short." },
    ...history.map((m) => ({ role: m.role, text: m.text })),
  ];
  return { system: QA_SYSTEM + prefsDirective(prefs), turns, temperature: 0.3, maxTokens: 1024 };
}

// ---- public API --------------------------------------------------------

/** Summarize a page (text already extracted; PDFs are pre-extracted to text). */
export async function summarizePage(page) {
  const prefs = await getSettings();
  return dispatch(summaryRequest(page, prefs));
}

/**
 * Answer a question given prior chat history.
 * @param {Object} page    extracted page data (page.text holds the content)
 * @param {Array}  history [{ role: 'user'|'model', text }]
 */
export async function answerQuestion(page, history) {
  const prefs = await getSettings();
  return dispatch(answerRequest(page, history, prefs));
}

/**
 * Streaming variants. `onChunk(textPiece)` fires for each incremental token
 * chunk; the returned promise resolves with the full accumulated text.
 */
export async function summarizePageStream(page, onChunk) {
  const prefs = await getSettings();
  return dispatchStream(summaryRequest(page, prefs), onChunk);
}
export async function answerQuestionStream(page, history, onChunk) {
  const prefs = await getSettings();
  return dispatchStream(answerRequest(page, history, prefs), onChunk);
}

/** Route a neutral request to the active provider (non-streaming). */
async function dispatch(req) {
  const { provider, apiKey, model } = await getActive();
  if (!apiKey) throw new Error("NO_API_KEY");
  if (provider === "groq") return callGroq(apiKey, model, req);
  return callGemini(apiKey, model, req);
}

/** Route a streaming request to the active provider. */
async function dispatchStream(req, onChunk) {
  const { provider, apiKey, model } = await getActive();
  if (!apiKey) throw new Error("NO_API_KEY");
  if (provider === "groq") return callGroqStream(apiKey, model, req, onChunk);
  return callGeminiStream(apiKey, model, req, onChunk);
}

// ---- SSE helper --------------------------------------------------------

/**
 * Read a fetch Response body as a stream of lines, invoking onLine for each.
 * Handles chunk boundaries that split mid-line.
 */
async function readSSE(resp, onLine) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  buffer = buffer.trim();
  if (buffer) onLine(buffer);
}

// ---- Gemini backend ----------------------------------------------------

function geminiBody({ system, turns, temperature, maxTokens }) {
  return {
    contents: turns.map((t) => ({
      role: t.role === "model" ? "model" : "user",
      parts: [{ text: t.text }],
    })),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
}

async function geminiError(resp) {
  let detail = "";
  try {
    detail = (await resp.json())?.error?.message || "";
  } catch (_) {}
  if (resp.status === 400 && /API key/i.test(detail)) return new Error("Invalid Gemini API key. Check it in Settings.");
  if (resp.status === 429) return new Error("Gemini rate limit hit. Wait a moment and try again.");
  return new Error(`Gemini API error (${resp.status}): ${detail || resp.statusText}`);
}

async function callGemini(apiKey, model, req) {
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody(req)),
    });
  } catch (e) {
    throw new Error("Network error reaching Gemini. Check your connection.");
  }

  if (!resp.ok) throw await geminiError(resp);

  const data = await resp.json();
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason;
    throw new Error(reason ? `Response blocked: ${reason}` : "Empty response from Gemini.");
  }
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no text.");
  return text;
}

async function callGeminiStream(apiKey, model, req, onChunk) {
  // streamGenerateContent with alt=sse emits Server-Sent Events.
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody(req)),
    });
  } catch (e) {
    throw new Error("Network error reaching Gemini. Check your connection.");
  }

  if (!resp.ok) throw await geminiError(resp);

  let full = "";
  await readSSE(resp, (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch (_) {
      return;
    }
    const piece = (json?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");
    if (piece) {
      full += piece;
      onChunk(piece);
    }
  });

  full = full.trim();
  if (!full) throw new Error("Gemini returned no text.");
  return full;
}

// ---- Groq backend (OpenAI-compatible chat completions) -----------------

function groqMessages({ system, turns }) {
  return [
    { role: "system", content: system },
    ...turns.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text,
    })),
  ];
}

async function groqError(resp) {
  let detail = "";
  try {
    detail = (await resp.json())?.error?.message || "";
  } catch (_) {}
  if (resp.status === 401) return new Error("Invalid Groq API key. Check it in Settings.");
  if (resp.status === 429) return new Error("Groq rate limit hit. Wait a moment and try again.");
  return new Error(`Groq API error (${resp.status}): ${detail || resp.statusText}`);
}

async function callGroq(apiKey, model, req) {
  const { temperature, maxTokens } = req;
  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: groqMessages(req), temperature, max_tokens: maxTokens }),
    });
  } catch (e) {
    throw new Error("Network error reaching Groq. Check your connection.");
  }

  if (!resp.ok) throw await groqError(resp);

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq returned no text.");
  return text;
}

async function callGroqStream(apiKey, model, req, onChunk) {
  const { temperature, maxTokens } = req;
  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: groqMessages(req),
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });
  } catch (e) {
    throw new Error("Network error reaching Groq. Check your connection.");
  }

  if (!resp.ok) throw await groqError(resp);

  let full = "";
  await readSSE(resp, (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch (_) {
      return;
    }
    const piece = json?.choices?.[0]?.delta?.content || "";
    if (piece) {
      full += piece;
      onChunk(piece);
    }
  });

  full = full.trim();
  if (!full) throw new Error("Groq returned no text.");
  return full;
}
