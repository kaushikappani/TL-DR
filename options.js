// options.js
import { PROVIDERS, MCP_DEFAULTS, getSettings } from "./ai.js";
import { probe } from "./mcp.js";

const els = {
  providerGroup: document.getElementById("provider"),
  toggleBtns: document.querySelectorAll("#provider .toggle-btn"),
  geminiPanel: document.getElementById("geminiPanel"),
  groqPanel: document.getElementById("groqPanel"),
  geminiKey: document.getElementById("geminiKey"),
  geminiModel: document.getElementById("geminiModel"),
  groqKey: document.getElementById("groqKey"),
  groqModel: document.getElementById("groqModel"),
  // personalization
  prefLength: document.getElementById("prefLength"),
  prefFormat: document.getElementById("prefFormat"),
  prefLevel: document.getElementById("prefLevel"),
  prefLanguage: document.getElementById("prefLanguage"),
  prefTone: document.getElementById("prefTone"),
  // advanced / MCP
  tabs: document.getElementById("tabs"),
  panes: { general: document.getElementById("generalPane"), advanced: document.getElementById("advancedPane") },
  mcpEnabled: document.getElementById("mcpEnabled"),
  mcpConfirm: document.getElementById("mcpConfirm"),
  mcpActions: document.getElementById("mcpActions"),
  mcpMaxCalls: document.getElementById("mcpMaxCalls"),
  mcpList: document.getElementById("mcpList"),
  addServerBtn: document.getElementById("addServerBtn"),
  mcpCardTpl: document.getElementById("mcpCardTpl"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status"),
};

let currentProvider = "gemini";

// Sentinel option that opens the "type your own model ID" row.
const CUSTOM = "__custom__";
// Model IDs the user typed in, per provider. Persisted alongside the settings.
let customModels = { gemini: [], groq: [] };

const modelSelect = (provider) => (provider === "groq" ? els.groqModel : els.geminiModel);
const providerOf = (sel) => (sel === els.groqModel ? "groq" : "gemini");
const partOf = (sel, suffix) => document.getElementById(sel.id.replace("Model", suffix));
const hasOption = (sel, id) => [...sel.options].some((o) => o.value === id);

// Add a model ID to the dropdown (just above the "add" sentinel) if it's new.
function ensureOption(sel, id, custom) {
  if (hasOption(sel, id)) return;
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = custom ? `${id} (custom)` : id;
  opt.dataset.custom = custom ? "1" : "";
  sel.insertBefore(opt, sel.querySelector(`option[value="${CUSTOM}"]`));
}

// The custom row is only open while the sentinel is picked; the remove link
// only shows while a user-added model is picked.
function syncModelRow(sel) {
  const adding = sel.value === CUSTOM;
  partOf(sel, "CustomRow").classList.toggle("hidden", !adding);
  partOf(sel, "Remove").classList.toggle("hidden", !customModels[providerOf(sel)].includes(sel.value));
}

/** The model to save/test — never the sentinel. */
function chosenModel(sel) {
  return sel.value === CUSTOM ? "" : sel.value;
}

function addCustomModel(sel) {
  const input = partOf(sel, "CustomInput");
  const id = input.value.trim();
  if (!id) {
    status("Type a model ID first.", "error");
    input.focus();
    return false;
  }
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(id)) {
    status("That doesn't look like a model ID.", "error");
    input.focus();
    return false;
  }
  const provider = providerOf(sel);
  if (!hasOption(sel, id)) {
    customModels[provider] = [...customModels[provider], id];
    ensureOption(sel, id, true);
  }
  sel.value = id;
  input.value = "";
  syncModelRow(sel);
  status(`Added ${id}. Use "Test connection" to check it, then Save.`, "ok");
  return true;
}

function removeCustomModel(sel) {
  const provider = providerOf(sel);
  const id = sel.value;
  if (!customModels[provider].includes(id)) return;
  customModels[provider] = customModels[provider].filter((m) => m !== id);
  sel.querySelector(`option[value="${CSS.escape(id)}"]`)?.remove();
  sel.selectedIndex = 0;
  syncModelRow(sel);
  status(`Removed ${id}. Don't forget to Save.`, "ok");
}

// ---- Advanced tab: MCP servers -----------------------------------------

function showTab(name) {
  for (const [key, pane] of Object.entries(els.panes)) pane.classList.toggle("active", key === name);
  els.tabs.querySelectorAll(".toggle-btn").forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
}

let serverSeq = 1;

function cardStatus(card, text, kind = "") {
  const el = card.querySelector(".mcp-status");
  el.className = `mcp-status hint ${kind}`;
  el.textContent = text;
}

/** Read one card back into a server object. */
function readCard(card) {
  let tools = [];
  try {
    tools = JSON.parse(card.dataset.tools || "[]");
  } catch (_) {}
  return {
    id: card.dataset.id,
    name: card.querySelector(".mcp-name").value.trim(),
    url: card.querySelector(".mcp-url").value.trim(),
    headers: card.querySelector(".mcp-headers").value,
    enabled: card.querySelector(".mcp-on").checked,
    tools,
  };
}

function addServerCard(server) {
  const card = els.mcpCardTpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = server.id || `mcp_${serverSeq++}`;
  card.dataset.tools = JSON.stringify(server.tools || []);
  card.querySelector(".mcp-name").value = server.name || "";
  card.querySelector(".mcp-url").value = server.url || "";
  card.querySelector(".mcp-headers").value = server.headers || "";
  card.querySelector(".mcp-on").checked = server.enabled !== false;

  const known = server.tools || [];
  if (known.length) cardStatus(card, `${known.length} tool${known.length === 1 ? "" : "s"}: ${known.join(", ")}`);

  card.querySelector(".mcp-remove").addEventListener("click", () => card.remove());
  card.querySelector(".mcp-test").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    // Probe what's typed in right now, not what was last saved.
    const typed = readCard(card);
    if (!typed.url) {
      cardStatus(card, "Enter the server URL first.", "error");
      return;
    }
    btn.disabled = true;
    cardStatus(card, "Connecting…");
    try {
      const tools = await probe(typed);
      card.dataset.tools = JSON.stringify(tools.slice(0, 40));
      cardStatus(
        card,
        tools.length ? `✓ ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${tools.join(", ")}` : "Connected, but this server exposes no tools.",
        tools.length ? "ok" : "error"
      );
    } catch (err) {
      card.dataset.tools = "[]";
      cardStatus(card, `✗ ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  });

  els.mcpList.appendChild(card);
  return card;
}

function renderServers(servers) {
  els.mcpList.innerHTML = "";
  servers.forEach(addServerCard);
}

/** All configured servers, dropping rows the user left blank. */
function collectServers() {
  return [...els.mcpList.querySelectorAll(".mcp-card")]
    .map(readCard)
    .filter((sv) => sv.url || sv.name)
    .map((sv, i) => ({ ...sv, name: sv.name || `Server ${i + 1}` }));
}

function readMcp() {
  return {
    enabled: els.mcpEnabled.checked,
    confirm: els.mcpConfirm.checked,
    actions: els.mcpActions.checked,
    maxCalls: Math.min(10, Math.max(1, Number(els.mcpMaxCalls.value) || MCP_DEFAULTS.maxCalls)),
    servers: collectServers(),
  };
}

// A segmented control whose buttons carry data-val; tracks one selected value.
function initSegment(group) {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle-btn");
    if (!btn) return;
    setSegment(group, btn.dataset.val);
  });
}
function setSegment(group, val) {
  group.querySelectorAll(".toggle-btn").forEach((b) => {
    const active = b.dataset.val === val;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
}
function getSegment(group) {
  const active = group.querySelector(".toggle-btn.active");
  return active ? active.dataset.val : null;
}

function status(text, kind) {
  els.status.className = `status ${kind}`;
  els.status.textContent = text;
  els.status.classList.remove("hidden");
}

function setProvider(provider) {
  currentProvider = provider === "groq" ? "groq" : "gemini";
  const isGroq = currentProvider === "groq";
  els.toggleBtns.forEach((b) => {
    const active = b.dataset.provider === currentProvider;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  els.groqPanel.classList.toggle("active", isGroq);
  els.geminiPanel.classList.toggle("active", !isGroq);
}

async function load() {
  const s = await getSettings();
  customModels = s.customModels;

  els.geminiKey.value = s.geminiKey || "";
  els.groqKey.value = s.groqKey || "";
  for (const provider of ["gemini", "groq"]) {
    const sel = modelSelect(provider);
    customModels[provider].forEach((id) => ensureOption(sel, id, true));
    // A model saved before it was listed (or from an older build) still shows.
    ensureOption(sel, s[`${provider}Model`], false);
    sel.value = s[`${provider}Model`];
    syncModelRow(sel);
  }
  setProvider(s.provider);

  // advanced / MCP
  els.mcpEnabled.checked = s.mcp.enabled;
  els.mcpConfirm.checked = s.mcp.confirm;
  els.mcpActions.checked = s.mcp.actions;
  els.mcpMaxCalls.value = s.mcp.maxCalls;
  renderServers(s.mcp.servers);

  // personalization
  setSegment(els.prefLength, s.prefLength);
  setSegment(els.prefFormat, s.prefFormat);
  setSegment(els.prefLevel, s.prefLevel);
  els.prefLanguage.value = s.prefLanguage;
  els.prefTone.value = s.prefTone || "";
}

els.toggleBtns.forEach((btn) => {
  btn.addEventListener("click", () => setProvider(btn.dataset.provider));
});

// Preference segmented controls.
[els.prefLength, els.prefFormat, els.prefLevel].forEach(initSegment);

// Model dropdowns: open the custom row when the sentinel is picked.
[els.geminiModel, els.groqModel].forEach((sel) => {
  sel.addEventListener("change", () => {
    syncModelRow(sel);
    if (sel.value === CUSTOM) partOf(sel, "CustomInput").focus();
  });
});
document.querySelectorAll(".add-model").forEach((btn) => {
  btn.addEventListener("click", () => addCustomModel(document.getElementById(btn.dataset.target)));
});
document.querySelectorAll(".remove-model").forEach((btn) => {
  btn.addEventListener("click", () => removeCustomModel(document.getElementById(btn.dataset.target)));
});
document.querySelectorAll(".custom-row input").forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addCustomModel(document.getElementById(input.closest(".custom-row").querySelector(".add-model").dataset.target));
  });
});

// Tabs.
els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".toggle-btn");
  if (btn) showTab(btn.dataset.tab);
});
els.addServerBtn.addEventListener("click", () => {
  const card = addServerCard({ enabled: true });
  card.querySelector(".mcp-name").focus();
});

// Show/hide key buttons.
document.querySelectorAll(".toggle-key").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
  });
});

els.saveBtn.addEventListener("click", async () => {
  const provider = currentProvider;
  const activeKey = provider === "groq" ? els.groqKey.value.trim() : els.geminiKey.value.trim();
  if (!activeKey) {
    status(`Please enter your ${PROVIDERS[provider].label} API key.`, "error");
    return;
  }
  // Half-finished custom entry: add it now rather than saving the sentinel.
  const sel = modelSelect(provider);
  if (sel.value === CUSTOM && !addCustomModel(sel)) return;

  try {
    await chrome.storage.sync.set({
      provider,
      geminiKey: els.geminiKey.value.trim(),
      geminiModel: chosenModel(els.geminiModel) || PROVIDERS.gemini.defaultModel,
      groqKey: els.groqKey.value.trim(),
      groqModel: chosenModel(els.groqModel) || PROVIDERS.groq.defaultModel,
      customModels,
      mcp: readMcp(),
      // personalization
      prefLength: getSegment(els.prefLength) || "standard",
      prefFormat: getSegment(els.prefFormat) || "bullets",
      prefLevel: getSegment(els.prefLevel) || "general",
      prefLanguage: els.prefLanguage.value,
      prefTone: els.prefTone.value.trim().slice(0, 300),
    });
  } catch (e) {
    // Synced storage caps each key at 8 KB — long header blocks can hit it.
    status(`Couldn't save: ${e.message}`, "error");
    return;
  }
  status("Saved! You can close this tab.", "ok");
});

// Test the active provider with a tiny request.
els.testBtn.addEventListener("click", async () => {
  const provider = currentProvider;
  status("Testing…", "loading");
  try {
    const model = chosenModel(modelSelect(provider));
    if (!model) throw new Error("Pick a model, or add one and press Add.");
    if (provider === "groq") {
      await testGroq(els.groqKey.value.trim(), model);
    } else {
      await testGemini(els.geminiKey.value.trim(), model);
    }
    status("✓ Connection works! Don't forget to Save.", "ok");
  } catch (e) {
    status(`✗ ${e.message}`, "error");
  }
});

async function testGemini(apiKey, model) {
  if (!apiKey) throw new Error("Enter a Gemini API key first.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with: OK" }] }],
      generationConfig: { maxOutputTokens: 5 },
    }),
  });
  if (!resp.ok) {
    const msg = (await resp.json().catch(() => ({})))?.error?.message || resp.statusText;
    throw new Error(`Failed (${resp.status}): ${msg}`);
  }
}

async function testGroq(apiKey, model) {
  if (!apiKey) throw new Error("Enter a Groq API key first.");
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with: OK" }],
      max_tokens: 5,
    }),
  });
  if (!resp.ok) {
    const msg = (await resp.json().catch(() => ({})))?.error?.message || resp.statusText;
    throw new Error(`Failed (${resp.status}): ${msg}`);
  }
}

load();
