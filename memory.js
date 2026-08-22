// memory.js
// Long-term memory: small durable notes the model decides to keep, so facts it
// learned once — an account id, a workspace, a preference — survive past the
// conversation that produced them.
//
// Explicitly not for credentials. Everything in here is pasted into the system
// prompt of every later request and sent to the AI provider each time, so a
// token saved once leaks on every summary the user asks for afterwards. Staying
// signed in is the transport's job, not the model's: an MCP server can hand the
// client a credential out-of-band (see mcp.js) that no prompt ever sees.
// looksLikeSecret() below turns that from advice into a rule.
//
// Stored in chrome.storage.local rather than .sync, so it stays on this device
// and the quota is megabytes instead of 100 KB.

const STORE_KEY = "memories";

const MAX_ITEMS = 40;
const MAX_KEY_CHARS = 60;
const MAX_VALUE_CHARS = 1000;
// The whole set rides in every prompt, so cap what that can cost.
const MAX_BLOCK_CHARS = 4000;

// Values that describe a state rather than carry one. The model keeps trying to
// save these ("noteit_auth_status": "logged_in") even when told not to, and they
// are worse than useless: nothing authenticates with them, and they outlive the
// state they claim, so a dead session still reads as logged in. Whether
// something is still true is a question for a tool, asked fresh each time.
// Single letters and bare digits stay off this list: "1" or "n" is far more
// likely to be someone's account id than a state claim.
const STATUS_VALUE =
  /^(logged[\s_-]?(in|out)|signed[\s_-]?(in|out)|authenticated|unauthenticated|authorized|connected|disconnected|active|inactive|enabled|disabled|done|completed?|finished|success(ful)?|failed|failure|valid|invalid|verified|unverified|pending|ready|configured|installed|registered|subscribed|true|false|yes|no|on|off|ok|okay|none|null|n\/a)$/i;

/** True when a value is a state claim, not something you could pass to a tool. */
export function looksLikeStatus(value) {
  const bare = String(value || "").trim().replace(/[.!"']+$/, "");
  return STATUS_VALUE.test(bare);
}

// Key names that announce a secret whatever the value turns out to be.
const SECRET_KEY =
  /(^|[\s_-])(token|secret|password|passwd|pwd|apikey|api[\s_-]?key|jwt|bearer|credential|auth|cookie|private[\s_-]?key|refresh|session[\s_-]?id)([\s_-]|$)/i;

// Values that are unmistakably a credential rather than an identifier.
const JWT_VALUE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const BEARER_VALUE = /^(bearer|basic|token)\s+\S/i;
// A long unbroken run of token characters. The floor is deliberately high: a
// Mongo ObjectId is 24 characters and someone's account id has every right to
// be saved.
const OPAQUE_VALUE = /^[A-Za-z0-9_\-.=+/]{40,}$/;

/**
 * True when saving this would put a credential into every future prompt.
 *
 * Deliberately errs towards refusing. The cost of a false positive is the model
 * asking for an id again; the cost of a false negative is a live token shipped
 * to Gemini or Groq on every page the user summarises from now on.
 */
export function looksLikeSecret(key, value) {
  const name = String(key || "").trim();
  const bare = String(value || "").trim();
  if (!bare) return false;
  if (SECRET_KEY.test(name)) return true;
  return JWT_VALUE.test(bare) || BEARER_VALUE.test(bare) || OPAQUE_VALUE.test(bare);
}

/** chrome.storage.local, or nothing at all outside the extension. */
function store() {
  return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
}

function clean(item) {
  if (!item || typeof item.key !== "string" || typeof item.value !== "string") return null;
  const key = item.key.trim().slice(0, MAX_KEY_CHARS);
  const value = item.value.trim().slice(0, MAX_VALUE_CHARS);
  if (!key || !value) return null;
  return {
    key,
    value,
    savedAt: Number(item.savedAt) || Date.now(),
    expiresAt: Number(item.expiresAt) || 0, // 0 = keep until deleted
  };
}

/** Everything still valid, newest first. Expired entries are swept on read. */
export async function listMemories() {
  const area = store();
  if (!area) return [];

  const raw = (await area.get(STORE_KEY))[STORE_KEY];
  const items = (Array.isArray(raw) ? raw : []).map(clean).filter(Boolean);

  const now = Date.now();
  // Status flags and credentials saved by older builds get swept out here
  // rather than lingering in the prompt until someone notices them in Settings.
  // For credentials the sweep is the point: the previous build saved tokens
  // deliberately, and every one still in there is going to the AI provider on
  // every request.
  const live = items.filter(
    (m) =>
      (!m.expiresAt || m.expiresAt > now) &&
      !looksLikeStatus(m.value) &&
      !looksLikeSecret(m.key, m.value)
  );
  if (live.length !== items.length) await area.set({ [STORE_KEY]: live });

  return live.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Remember one thing. Re-using a key overwrites it, which is how the model
 * refreshes a token rather than piling up copies of it.
 */
export async function saveMemory({ key, value, expiresInDays }) {
  const area = store();
  if (!area) throw new Error("Memory isn't available here.");

  const days = Number(expiresInDays);
  const item = clean({
    key,
    value,
    savedAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400000 : 0,
  });
  if (!item) throw new Error("A memory needs both a key and a value.");
  if (looksLikeStatus(item.value)) {
    throw new Error(
      `"${item.value}" is a status, not a value — it can't be passed to a tool and it goes stale on ` +
        "its own. Save the id or setting itself, or save nothing and check the state with a tool."
    );
  }
  if (looksLikeSecret(item.key, item.value)) {
    throw new Error(
      `"${item.key}" looks like a credential, and memory is the wrong place for one — everything saved ` +
        "here is replayed into every later prompt and sent to the AI provider each time. Signing in " +
        "already persists between conversations without you holding the secret; if a tool says you are " +
        "not logged in, run its sign-in flow again rather than remembering a token."
    );
  }

  const rest = (await listMemories()).filter((m) => m.key !== item.key);
  // Oldest out first once the cabinet is full.
  const next = [item, ...rest].slice(0, MAX_ITEMS);
  await area.set({ [STORE_KEY]: next });
  return item;
}

export async function forgetMemory(key) {
  const area = store();
  if (!area) return false;

  const items = await listMemories();
  const next = items.filter((m) => m.key !== String(key || "").trim());
  if (next.length === items.length) return false;

  await area.set({ [STORE_KEY]: next });
  return true;
}

export async function clearMemories() {
  const area = store();
  if (area) await area.set({ [STORE_KEY]: [] });
}

/** Render the set as a prompt block. Empty string when there's nothing to say. */
export function memoryBlock(items) {
  if (!items.length) return "";

  const lines = [];
  let budget = MAX_BLOCK_CHARS;
  for (const m of items) {
    const line = `- ${m.key}: ${m.value}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  if (!lines.length) return "";

  return (
    "\n\nTHINGS YOU REMEMBERED EARLIER (from previous conversations with this user):\n" +
    lines.join("\n") +
    "\nUse these when they're relevant — pass a saved id or account detail straight " +
    "into a tool call instead of asking the user for it again. If one turns out to be " +
    "stale or rejected, forget it and get a fresh one."
  );
}
