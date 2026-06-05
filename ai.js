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
    defaultModel: "llama-3.3-70b-versatile",
    keysUrl: "https://console.groq.com/keys",
  },
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ---- settings ----------------------------------------------------------

export async function getSettings() {
  const s = await chrome.storage.sync.get([
    "provider",
    "geminiKey",
    "geminiModel",
    "groqKey",
    "groqModel",
    // legacy keys from the Gemini-only version
    "apiKey",
    "model",
  ]);

  const provider = s.provider || "gemini";

  // Migrate legacy single-key settings into the Gemini slot.
  const geminiKey = s.geminiKey || s.apiKey || "";
  const geminiModel = s.geminiModel || s.model || PROVIDERS.gemini.defaultModel;
  const groqKey = s.groqKey || "";
  const groqModel = s.groqModel || PROVIDERS.groq.defaultModel;

  return { provider, geminiKey, geminiModel, groqKey, groqModel };
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
  "You answer questions strictly about the provided document content. " +
  "If the answer is not in the content, say so plainly instead of guessing. " +
  "Be concise and cite specifics from the document when relevant.";

const SUMMARY_INSTRUCTIONS =
  "\n\n---\nWrite a summary of the document above in this exact format:\n\n" +
  "**TL;DR:** one or two sentences capturing the core point.\n\n" +
  "**Key points:**\n- 3 to 6 short bullet points of the most important takeaways.\n\n" +
  "Keep it tight. No preamble, just the summary.";

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

// ---- public API --------------------------------------------------------

/** Summarize a page (text already extracted; PDFs are pre-extracted to text). */
export async function summarizePage(page) {
  const userText = buildPageContext(page) + SUMMARY_INSTRUCTIONS;
  return dispatch({
    system: SUMMARY_SYSTEM,
    turns: [{ role: "user", text: userText }],
    temperature: 0.3,
    maxTokens: 800,
  });
}

/**
 * Answer a question given prior chat history.
 * @param {Object} page    extracted page data (page.text holds the content)
 * @param {Array}  history [{ role: 'user'|'model', text }]
 */
export async function answerQuestion(page, history) {
  const turns = [
    {
      role: "user",
      text:
        "Here is the document you must answer questions about:\n\n" +
        buildPageContext(page),
    },
    { role: "model", text: "Got it. I've read the document and will answer your questions about it." },
    ...history.map((m) => ({ role: m.role, text: m.text })),
  ];
  return dispatch({ system: QA_SYSTEM, turns, temperature: 0.2, maxTokens: 1024 });
}

/** Route a neutral request to the active provider. */
async function dispatch(req) {
  const { provider, apiKey, model } = await getActive();
  if (!apiKey) throw new Error("NO_API_KEY");
  if (provider === "groq") return callGroq(apiKey, model, req);
  return callGemini(apiKey, model, req);
}

// ---- Gemini backend ----------------------------------------------------

async function callGemini(apiKey, model, { system, turns, temperature, maxTokens }) {
  const body = {
    contents: turns.map((t) => ({
      role: t.role === "model" ? "model" : "user",
      parts: [{ text: t.text }],
    })),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };

  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Network error reaching Gemini. Check your connection.");
  }

  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json())?.error?.message || "";
    } catch (_) {}
    if (resp.status === 400 && /API key/i.test(detail)) throw new Error("Invalid Gemini API key. Check it in Settings.");
    if (resp.status === 429) throw new Error("Gemini rate limit hit. Wait a moment and try again.");
    throw new Error(`Gemini API error (${resp.status}): ${detail || resp.statusText}`);
  }

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

// ---- Groq backend (OpenAI-compatible chat completions) -----------------

async function callGroq(apiKey, model, { system, turns, temperature, maxTokens }) {
  const messages = [
    { role: "system", content: system },
    ...turns.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text,
    })),
  ];

  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (e) {
    throw new Error("Network error reaching Groq. Check your connection.");
  }

  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json())?.error?.message || "";
    } catch (_) {}
    if (resp.status === 401) throw new Error("Invalid Groq API key. Check it in Settings.");
    if (resp.status === 429) throw new Error("Groq rate limit hit. Wait a moment and try again.");
    throw new Error(`Groq API error (${resp.status}): ${detail || resp.statusText}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq returned no text.");
  return text;
}
