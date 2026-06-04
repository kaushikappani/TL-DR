// gemini.js
// Thin wrapper around the Google Gemini REST API.
// Shared by the background worker. Imported as an ES module.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Default model. Flash is fast + cheap and more than enough for summaries.
export const DEFAULT_MODEL = "gemini-2.0-flash";

export async function getSettings() {
  const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
  return { apiKey: apiKey || "", model: model || DEFAULT_MODEL };
}

/**
 * Low-level call to generateContent.
 * @param {Array} contents  Gemini "contents" array (conversation turns).
 * @param {Object} opts     { systemInstruction, temperature, maxOutputTokens }
 * @returns {Promise<string>} the model's text reply
 */
export async function generate(contents, opts = {}) {
  const { apiKey, model } = await getSettings();
  if (!apiKey) {
    throw new Error("NO_API_KEY");
  }

  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
    },
  };

  if (opts.systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: opts.systemInstruction }],
    };
  }

  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
      const err = await resp.json();
      detail = err?.error?.message || "";
    } catch (_) {}
    if (resp.status === 400 && /API key/i.test(detail)) {
      throw new Error("Invalid API key. Check it in the extension options.");
    }
    if (resp.status === 429) {
      throw new Error("Rate limit hit. Wait a moment and try again.");
    }
    throw new Error(`Gemini API error (${resp.status}): ${detail || resp.statusText}`);
  }

  const data = await resp.json();

  // Handle safety blocks / empty responses gracefully.
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason;
    throw new Error(reason ? `Response blocked: ${reason}` : "Empty response from Gemini.");
  }
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    throw new Error("Gemini returned no text.");
  }
  return text;
}

/** Build a compact context block from extracted page data. */
export function buildPageContext(page) {
  return [
    `TITLE: ${page.title}`,
    `SOURCE: ${page.siteName} (${page.url})`,
    page.description ? `DESCRIPTION: ${page.description}` : "",
    "",
    "PAGE CONTENT:",
    page.text,
  ]
    .filter(Boolean)
    .join("\n");
}

// A PDF page carries { pdf: { mimeType, data } } where data is base64 bytes.
function isPdf(page) {
  return !!(page && page.pdf && page.pdf.data);
}

/** The "parts" that describe the source document for a turn. */
function sourceParts(page, leadText) {
  if (isPdf(page)) {
    return [
      { text: leadText },
      { inlineData: { mimeType: page.pdf.mimeType || "application/pdf", data: page.pdf.data } },
    ];
  }
  return [{ text: leadText + "\n\n" + buildPageContext(page) }];
}

/** Generate a structured summary of a page or PDF. */
export async function summarizePage(page) {
  const system =
    "You are a concise reading assistant. Summarize documents clearly for a busy reader. " +
    "Use plain language. Do not invent facts that are not in the content.";

  const instructions =
    "\n\n---\nWrite a summary of the document above in this exact format:\n\n" +
    "**TL;DR:** one or two sentences capturing the core point.\n\n" +
    "**Key points:**\n- 3 to 6 short bullet points of the most important takeaways.\n\n" +
    "Keep it tight. No preamble, just the summary.";

  let parts;
  if (isPdf(page)) {
    // PDF goes in as inline data; instructions follow it.
    parts = [
      { text: `Document title: ${page.title || "PDF"}` },
      { inlineData: { mimeType: page.pdf.mimeType || "application/pdf", data: page.pdf.data } },
      { text: instructions },
    ];
  } else {
    parts = [{ text: buildPageContext(page) + instructions }];
  }

  return generate([{ role: "user", parts }], {
    systemInstruction: system,
    temperature: 0.3,
    maxOutputTokens: 800,
  });
}

/**
 * Answer a question about the page/PDF given prior chat history.
 * @param {Object} page    extracted page data (may carry a pdf)
 * @param {Array}  history [{ role: 'user'|'model', text }]
 */
export async function answerQuestion(page, history) {
  const system =
    "You answer questions strictly about the provided document content. " +
    "If the answer is not in the content, say so plainly instead of guessing. " +
    "Be concise and cite specifics from the document when relevant.";

  const lead = isPdf(page)
    ? "Here is the PDF document you must answer questions about:"
    : "Here is the web page you must answer questions about:";

  const contents = [
    { role: "user", parts: sourceParts(page, lead) },
    {
      role: "model",
      parts: [{ text: "Got it. I've read the document and will answer your questions about it." }],
    },
    ...history.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
  ];

  return generate(contents, { systemInstruction: system, temperature: 0.2, maxOutputTokens: 1024 });
}
