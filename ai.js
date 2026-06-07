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
  "You help the user understand a web page they are reading. " +
  "Prefer the provided document content as your primary source and cite specifics from it when relevant. " +
  "If the answer is not in the document, you may draw on your own general knowledge to give a helpful, related answer — " +
  "but make the distinction clear (e.g. 'The page doesn't cover this, but generally…'). " +
  "Do not present outside knowledge as if it came from the document, and don't fabricate specifics. " +
  "If you are unsure or the topic is beyond your knowledge, say so plainly. Be concise.";

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

// ---- request builders (shared by streaming + non-streaming) ------------

function summaryRequest(page) {
  return {
    system: SUMMARY_SYSTEM,
    turns: [{ role: "user", text: buildPageContext(page) + SUMMARY_INSTRUCTIONS }],
    temperature: 0.3,
    maxTokens: 800,
  };
}

function answerRequest(page, history) {
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
  return { system: QA_SYSTEM, turns, temperature: 0.3, maxTokens: 1024 };
}

// ---- public API --------------------------------------------------------

/** Summarize a page (text already extracted; PDFs are pre-extracted to text). */
export async function summarizePage(page) {
  return dispatch(summaryRequest(page));
}

/**
 * Answer a question given prior chat history.
 * @param {Object} page    extracted page data (page.text holds the content)
 * @param {Array}  history [{ role: 'user'|'model', text }]
 */
export async function answerQuestion(page, history) {
  return dispatch(answerRequest(page, history));
}

/**
 * Streaming variants. `onChunk(textPiece)` fires for each incremental token
 * chunk; the returned promise resolves with the full accumulated text.
 */
export function summarizePageStream(page, onChunk) {
  return dispatchStream(summaryRequest(page), onChunk);
}
export function answerQuestionStream(page, history, onChunk) {
  return dispatchStream(answerRequest(page, history), onChunk);
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
