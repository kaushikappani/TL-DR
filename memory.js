// memory.js
// Long-term memory: small durable notes the model decides to keep, so facts it
// learned once — an auth token, an account id, a preference — survive past the
// conversation that produced them.
//
// Stored in chrome.storage.local rather than .sync: it holds credentials, so it
// stays on this device, and the quota is megabytes instead of 100 KB.

const STORE_KEY = "memories";

const MAX_ITEMS = 40;
const MAX_KEY_CHARS = 60;
const MAX_VALUE_CHARS = 1000;
// The whole set rides in every prompt, so cap what that can cost.
const MAX_BLOCK_CHARS = 4000;

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
  const live = items.filter((m) => !m.expiresAt || m.expiresAt > now);
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
    "\nUse these when they're relevant — pass a saved token, id or account detail " +
    "straight into a tool call instead of asking the user for it again. If one turns " +
    "out to be stale or rejected, forget it and get a fresh one."
  );
}
