// mcp.js
// Minimal Model Context Protocol client for remote servers over the
// Streamable HTTP transport (spec revision 2025-06-18).
//
// Everything is plain fetch + JSON-RPC 2.0: POST the request to the server URL,
// read back either a JSON body or an SSE stream carrying the response. The
// extension already holds <all_urls> host permissions, so the service worker
// and the options page can talk to any MCP endpoint the user configures.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "TL;DR", version: "1.0.0" };

const REQUEST_TIMEOUT_MS = 30000;
// Discovery runs before every answer, so a wedged server must not hold the
// whole chat hostage for the full call timeout.
const CONNECT_TIMEOUT_MS = 10000;
// Re-use an initialized session and its tool list for a short while instead of
// handshaking on every message. The worker is torn down often anyway.
const SESSION_TTL_MS = 5 * 60 * 1000;
const TOOLS_TTL_MS = 2 * 60 * 1000;
// Tool results are fed straight back into the prompt — keep them bounded.
const MAX_RESULT_CHARS = 8000;

let nextId = 1;

/** url -> { sessionId, expires } */
const sessions = new Map();
/** url -> { tools, expires } */
const toolLists = new Map();

/**
 * Parse the free-text header box ("Name: value" per line) into an object.
 * Blank lines and lines without a colon are ignored.
 */
export function parseHeaders(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function checkUrl(server) {
  const url = String(server?.url || "").trim();
  if (!url) throw new Error("MCP server URL is empty.");
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("MCP server URL must start with http:// or https://.");
  }
  return url;
}

/** Pull the JSON-RPC message with our id out of an SSE response body. */
async function readSseResult(resp, id) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let found = null;

  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch (_) {
      return;
    }
    // Servers may interleave notifications/progress; we only want our answer.
    if (msg && msg.id === id) found = msg;
  };

  while (found === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      consume(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (found === null && buffer.trim()) consume(buffer.trim());
  try {
    await reader.cancel();
  } catch (_) {}

  if (!found) throw new Error("MCP server closed the stream without answering.");
  return found;
}

/**
 * One JSON-RPC round trip. `notify: true` sends a notification (no id, no
 * reply expected) and resolves as soon as the server accepts it.
 */
async function rpc(server, method, params, { notify = false, sessionId = "", timeout = REQUEST_TIMEOUT_MS } = {}) {
  const url = checkUrl(server);
  const id = notify ? null : nextId++;
  const body = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };

  const headers = {
    ...parseHeaders(server.headers),
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (method !== "initialize") headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`MCP server timed out after ${timeout / 1000}s.`);
    throw new Error(`Couldn't reach the MCP server (${e.message || "network error"}).`);
  }

  try {
    if (!resp.ok) {
      // 404 on a session request means the server dropped our session.
      if (resp.status === 404 && sessionId) {
        const err = new Error("MCP session expired.");
        err.sessionExpired = true;
        throw err;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`MCP server rejected the request (${resp.status}) — check the auth header.`);
      }
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 200);
      } catch (_) {}
      throw new Error(`MCP server error ${resp.status}${detail ? ": " + detail : ""}`);
    }

    const newSession = resp.headers.get("Mcp-Session-Id") || "";
    if (notify || resp.status === 202) return { result: null, sessionId: newSession };

    const type = (resp.headers.get("content-type") || "").toLowerCase();
    const msg = type.includes("text/event-stream")
      ? await readSseResult(resp, id)
      : await resp.json();

    if (msg?.error) throw new Error(msg.error.message || `MCP error ${msg.error.code}`);
    return { result: msg?.result ?? null, sessionId: newSession };
  } finally {
    clearTimeout(timer);
  }
}

/** Handshake (or reuse a cached session) and return the session id, if any. */
async function connect(server) {
  const url = checkUrl(server);
  const cached = sessions.get(url);
  if (cached && cached.expires > Date.now()) return cached.sessionId;

  const { result, sessionId } = await rpc(
    server,
    "initialize",
    { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    { timeout: CONNECT_TIMEOUT_MS }
  );
  if (!result) throw new Error("MCP server didn't complete the handshake.");

  // Per spec the client confirms initialization. Servers that don't track it
  // just 202/ignore — a failure here shouldn't kill an otherwise good session.
  try {
    await rpc(server, "notifications/initialized", {}, { notify: true, sessionId });
  } catch (_) {}

  sessions.set(url, { sessionId, expires: Date.now() + SESSION_TTL_MS });
  return sessionId;
}

/** Drop any cached session for a server (after config edits or expiry). */
export function forget(server) {
  try {
    const url = checkUrl(server);
    sessions.delete(url);
    toolLists.delete(url);
  } catch (_) {}
}

/** Run `fn` with a live session, retrying once if the session expired. */
async function withSession(server, fn) {
  const sessionId = await connect(server);
  try {
    return await fn(sessionId);
  } catch (e) {
    if (!e || !e.sessionExpired) throw e;
    forget(server);
    return fn(await connect(server));
  }
}

/**
 * List the tools a server exposes.
 * @returns {Promise<Array<{name, description, inputSchema}>>}
 */
export async function listTools(server) {
  const url = checkUrl(server);
  const cached = toolLists.get(url);
  if (cached && cached.expires > Date.now()) return cached.tools;

  const tools = await withSession(server, async (sessionId) => {
    const found = [];
    let cursor;
    // Paginated: keep pulling while the server hands back a cursor.
    for (let page = 0; page < 10; page++) {
      const { result } = await rpc(server, "tools/list", cursor ? { cursor } : {}, {
        sessionId,
        timeout: CONNECT_TIMEOUT_MS,
      });
      for (const t of result?.tools || []) {
        if (t && t.name) found.push(t);
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return found;
  });

  toolLists.set(url, { tools, expires: Date.now() + TOOLS_TTL_MS });
  return tools;
}

/** Flatten an MCP content array into plain text for the model. */
function contentToText(content) {
  const parts = [];
  for (const item of content || []) {
    if (!item) continue;
    if (item.type === "text" && item.text) parts.push(item.text);
    else if (item.type === "resource" && item.resource?.text) parts.push(item.resource.text);
    else if (item.type === "image") parts.push("[image omitted — this extension only forwards text]");
    else if (item.type) parts.push(`[${item.type} content omitted]`);
  }
  return parts.join("\n\n");
}

/**
 * Call one tool.
 * @returns {Promise<{text: string, isError: boolean}>}
 */
export async function callTool(server, name, args) {
  const { result } = await withSession(server, (sessionId) =>
    rpc(server, "tools/call", { name, arguments: args || {} }, { sessionId })
  );

  let text = contentToText(result?.content);
  if (!text && result?.structuredContent) text = JSON.stringify(result.structuredContent);
  if (!text) text = "(the tool returned no content)";
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS) + `\n…[truncated at ${MAX_RESULT_CHARS} characters]`;
  }
  return { text, isError: !!result?.isError };
}

/** Fresh handshake + tool list — backs the "Test" button on the options page. */
export async function probe(server) {
  forget(server);
  const tools = await listTools(server);
  return tools.map((t) => t.name);
}
