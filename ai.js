// ai.js
// Provider-agnostic AI layer. Supports Google Gemini and Groq.
// The background worker calls summarizePage() / answerQuestion(); this module
// builds a provider-neutral message list and dispatches to the right backend.
//
// When MCP servers are configured (Settings -> Advanced), the Q&A path runs an
// agentic loop instead of a single call: the model is handed the servers' tools,
// and any tool calls it makes are executed over MCP and fed back until it
// answers in plain text.

import { listTools, callTool } from "./mcp.js";

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

// Advanced (MCP) defaults.
export const MCP_DEFAULTS = {
  enabled: false,
  confirm: true,    // ask the user before each tool call
  maxCalls: 4,      // tool calls allowed per user message
  servers: [],      // [{ id, name, url, headers, enabled, tools: [names] }]
};

function normalizeMcp(raw) {
  const servers = Array.isArray(raw?.servers) ? raw.servers : [];
  return {
    enabled: !!raw?.enabled,
    confirm: raw?.confirm !== false,
    maxCalls: Math.min(10, Math.max(1, Number(raw?.maxCalls) || MCP_DEFAULTS.maxCalls)),
    servers: servers
      .filter((sv) => sv && typeof sv.url === "string")
      .map((sv, i) => ({
        id: String(sv.id || `mcp${i}`),
        name: String(sv.name || "").trim() || `Server ${i + 1}`,
        url: String(sv.url || "").trim(),
        headers: String(sv.headers || ""),
        enabled: sv.enabled !== false,
        tools: Array.isArray(sv.tools) ? sv.tools.filter((t) => typeof t === "string").slice(0, 40) : [],
      })),
  };
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
    // advanced: MCP servers
    "mcp",
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
  const mcp = normalizeMcp(s.mcp);

  return { provider, geminiKey, geminiModel, groqKey, groqModel, customModels, mcp, ...prefs };
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

// Appended to the Q&A system prompt whenever MCP tools are in play.
const TOOLS_SYSTEM =
  "\n\nYou also have tools, provided by the MCP servers this user connected. " +
  "Use one whenever it would make your answer more accurate or more current — live data, " +
  "private or internal systems, anything the page doesn't cover. Answer directly, without a tool, " +
  "when the page or your own knowledge already covers the question. " +
  "Before each call the user is asked to approve it, so first state in one short line which tool " +
  "you want and why, then make the call. If a call is declined, answer with what you already have " +
  "and say plainly what you couldn't look up. Never invent tool output — only report what a tool " +
  "actually returned.";

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
 * @param {Object}   page    extracted page data (page.text holds the content)
 * @param {Array}    history [{ role: 'user'|'model', text }]
 * @param {Function} onTool  optional progress callback for MCP tool activity
 */
export async function answerQuestion(page, history, onTool, onConfirm) {
  const s = await getSettings();
  const req = answerRequest(page, history, s);
  const registry = await loadTools(s, onTool);
  if (!registry) return dispatch(req);
  return runWithTools(req, registry, () => {}, onTool, confirmHook(s, onConfirm), s.mcp.maxCalls);
}

/**
 * Streaming variants. `onChunk(textPiece)` fires for each incremental token
 * chunk; the returned promise resolves with the full accumulated text.
 */
export async function summarizePageStream(page, onChunk) {
  const prefs = await getSettings();
  return dispatchStream(summaryRequest(page, prefs), onChunk);
}
export async function answerQuestionStream(page, history, onChunk, onTool, onConfirm) {
  const s = await getSettings();
  const req = answerRequest(page, history, s);
  const registry = await loadTools(s, onTool);
  // With tools in play the answer arrives after the tool round trips, so the
  // loop emits it as a single chunk instead of token by token.
  if (!registry) return dispatchStream(req, onChunk);
  return runWithTools(req, registry, onChunk, onTool, confirmHook(s, onConfirm), s.mcp.maxCalls);
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

// ---- MCP tools ---------------------------------------------------------

// Hard stop on model<->tool round trips, independent of the user's call budget.
const MAX_TOOL_STEPS = 6;

// Providers only accept [A-Za-z0-9_-] tool names, so MCP tools are exposed as
// "<server>__<tool>". The registry maps that name back to the real server+tool.
const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

function qualify(taken, serverName, toolName) {
  let name = `${slug(serverName)}__${slug(toolName)}`.slice(0, 64);
  for (let i = 2; taken.has(name); i++) {
    name = `${name.slice(0, 60)}_${i}`;
  }
  return name;
}

/**
 * Ask every enabled MCP server what it can do and build a flat tool registry.
 * Returns null when MCP is off or nothing usable came back, so callers can fall
 * back to the plain (streaming) path.
 */
async function loadTools(settings, onTool) {
  const mcp = settings.mcp;
  if (!mcp?.enabled) return null;
  const servers = mcp.servers.filter((sv) => sv.enabled && sv.url);
  if (!servers.length) return null;

  const defs = [];
  const byName = new Map();

  const lists = await Promise.all(
    servers.map(async (server) => {
      try {
        return { server, tools: await listTools(server) };
      } catch (e) {
        console.warn("[TL;DR] MCP list failed:", server.name, e);
        onTool?.({ phase: "error", server: server.name, message: e.message || "unreachable" });
        return { server, tools: [] };
      }
    })
  );

  for (const { server, tools } of lists) {
    for (const tool of tools) {
      const name = qualify(byName, server.name, tool.name);
      defs.push({
        name,
        description: `[${server.name}] ${tool.description || tool.name}`.slice(0, 1024),
        schema: tool.inputSchema,
      });
      byName.set(name, { server, tool: tool.name });
    }
  }

  return defs.length ? { defs, byName } : null;
}

/**
 * The agentic loop: call the model with tools attached, run whatever it asks
 * for over MCP, feed the results back, repeat until it answers in text.
 */
async function runWithTools(req, registry, onChunk, onTool, onConfirm, maxCalls) {
  const { provider, apiKey, model } = await getActive();
  if (!apiKey) throw new Error("NO_API_KEY");

  const base = { ...req, system: req.system + TOOLS_SYSTEM };
  const turns = [...req.turns];
  let used = 0;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    // Once the budget is spent, keep the declarations (history already refers
    // to them) but forbid further calls, which forces a final answer.
    const turnReq = { ...base, turns, tools: registry.defs, toolChoice: used < maxCalls ? "auto" : "none" };
    const { text, toolCalls } =
      provider === "groq"
        ? await groqTurn(apiKey, model, turnReq)
        : await geminiTurn(apiKey, model, turnReq);

    if (!toolCalls.length) {
      const answer = (text || "").trim();
      if (!answer) throw new Error("The model returned no answer.");
      onChunk(answer);
      return answer;
    }

    turns.push({ role: "tool_call", calls: toolCalls });
    const results = [];
    for (const call of toolCalls) {
      // Any line the model wrote alongside the call explains why it wants it —
      // pass it along so the approval prompt can show the reason.
      results.push(
        await execTool(registry, call, { overBudget: ++used > maxCalls, onTool, onConfirm, reason: (text || "").trim() })
      );
    }
    turns.push({ role: "tool_result", results });
  }

  // Safety net: too many rounds — answer with what we have, calls forbidden.
  const lastReq = { ...base, turns, tools: registry.defs, toolChoice: "none" };
  const { text } = await (provider === "groq"
    ? groqTurn(apiKey, model, lastReq)
    : geminiTurn(apiKey, model, lastReq));
  const answer = (text || "").trim() || "I couldn't finish using the tools for this one.";
  onChunk(answer);
  return answer;
}

/**
 * Only gate calls when the user asked for it AND there's a UI able to ask.
 * The non-streaming path has no channel back to the user, so it runs directly.
 */
function confirmHook(settings, onConfirm) {
  return settings.mcp?.confirm && typeof onConfirm === "function" ? onConfirm : null;
}

/** Run a single tool call, turning any failure into text the model can read. */
async function execTool(registry, call, { overBudget, onTool, onConfirm, reason } = {}) {
  const entry = registry.byName.get(call.name);
  const base = { id: call.id, name: call.name };

  if (!entry) return { ...base, text: `Error: no tool named "${call.name}" is available.`, isError: true };
  if (overBudget) {
    return { ...base, text: "Error: tool call budget for this message is used up. Answer with what you have.", isError: true };
  }

  const info = { server: entry.server.name, tool: entry.tool, args: call.args };

  if (onConfirm) {
    onTool?.({ phase: "ask", ...info });
    let approved = false;
    try {
      approved = await onConfirm({ ...info, reason });
    } catch (_) {
      approved = false;
    }
    if (!approved) {
      onTool?.({ phase: "declined", ...info });
      return {
        ...base,
        text: "The user declined this tool call. Answer using what you already have, and say what you couldn't look up.",
        isError: true,
      };
    }
  }

  onTool?.({ phase: "call", ...info });
  try {
    const { text, isError } = await callTool(entry.server, entry.tool, call.args);
    onTool?.({ phase: "result", ...info, isError });
    return { ...base, text, isError };
  } catch (e) {
    const message = e?.message || "tool call failed";
    console.warn("[TL;DR] MCP call failed:", call.name, e);
    onTool?.({ phase: "error", ...info, message });
    return { ...base, text: `Error calling ${entry.tool}: ${message}`, isError: true };
  }
}

function safeArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
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

// Gemini takes an OpenAPI-flavoured subset of JSON Schema with UPPERCASE type
// names and rejects anything it doesn't recognise, so MCP schemas get copied
// across field by field rather than passed through.
const GEMINI_TYPES = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

function geminiSchema(node) {
  if (!node || typeof node !== "object") return null;
  const raw = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
  const type = GEMINI_TYPES[String(raw || "").toLowerCase()];
  if (!type) return null;

  const out = { type };
  if (node.description) out.description = String(node.description).slice(0, 500);
  if (Array.isArray(node.enum) && node.enum.length) out.enum = node.enum.map(String);
  if (type === "ARRAY") out.items = geminiSchema(node.items) || { type: "STRING" };
  if (type === "OBJECT") {
    const properties = {};
    for (const [key, value] of Object.entries(node.properties || {})) {
      const child = geminiSchema(value);
      if (child) properties[key] = child;
    }
    // An OBJECT with no properties is rejected; treat it as "no parameters".
    if (!Object.keys(properties).length) return null;
    out.properties = properties;
    const required = (Array.isArray(node.required) ? node.required : []).filter((r) => properties[r]);
    if (required.length) out.required = required;
  }
  return out;
}

function geminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const parameters = geminiSchema(t.schema);
        const decl = { name: t.name, description: t.description };
        if (parameters) decl.parameters = parameters;
        return decl;
      }),
    },
  ];
}

function geminiContents(turns) {
  return turns.map((t) => {
    if (t.role === "tool_call") {
      return {
        role: "model",
        parts: t.calls.map((c) => ({ functionCall: { name: c.name, args: c.args || {} } })),
      };
    }
    if (t.role === "tool_result") {
      return {
        role: "user",
        parts: t.results.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.text } },
        })),
      };
    }
    return { role: t.role === "model" ? "model" : "user", parts: [{ text: t.text }] };
  });
}

function geminiBody({ system, turns, temperature, maxTokens, tools, toolChoice }) {
  const body = {
    contents: geminiContents(turns),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (tools?.length) {
    body.tools = geminiTools(tools);
    // "NONE" keeps the declarations visible (earlier turns reference them)
    // while telling the model to stop calling and answer.
    body.toolConfig = { functionCallingConfig: { mode: toolChoice === "none" ? "NONE" : "AUTO" } };
  }
  return body;
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

/** One non-streaming Gemini turn -> { text, toolCalls }. */
async function geminiTurn(apiKey, model, req) {
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

  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `${p.functionCall.name}_${i}`,
      name: p.functionCall.name,
      args: safeArgs(p.functionCall.args),
    }));

  return { text, toolCalls };
}

async function callGemini(apiKey, model, req) {
  const { text } = await geminiTurn(apiKey, model, req);
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
  const messages = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "tool_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: t.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        })),
      });
    } else if (t.role === "tool_result") {
      for (const r of t.results) {
        messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.text });
      }
    } else {
      messages.push({ role: t.role === "model" ? "assistant" : "user", content: t.text });
    }
  }
  return messages;
}

// OpenAI-compatible function schemas. MCP input schemas are already JSON
// Schema, so only the envelope needs normalising.
function groqTools(tools) {
  return tools.map((t) => {
    const schema = t.schema && typeof t.schema === "object" ? t.schema : {};
    const parameters = {
      type: "object",
      properties: schema.properties && typeof schema.properties === "object" ? schema.properties : {},
    };
    if (Array.isArray(schema.required) && schema.required.length) parameters.required = schema.required;
    return { type: "function", function: { name: t.name, description: t.description, parameters } };
  });
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

/** One non-streaming Groq turn -> { text, toolCalls }. */
async function groqTurn(apiKey, model, req) {
  const { temperature, maxTokens, tools, toolChoice } = req;
  const body = { model, messages: groqMessages(req), temperature, max_tokens: maxTokens };
  if (tools?.length) {
    body.tools = groqTools(tools);
    body.tool_choice = toolChoice === "none" ? "none" : "auto";
  }

  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("Network error reaching Groq. Check your connection.");
  }

  if (!resp.ok) throw await groqError(resp);

  const message = (await resp.json())?.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls || [])
    .filter((c) => c?.function?.name)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function.name,
      args: safeArgs(c.function.arguments),
    }));

  return { text: (message?.content || "").trim(), toolCalls };
}

async function callGroq(apiKey, model, req) {
  const { text } = await groqTurn(apiKey, model, req);
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
