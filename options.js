// options.js
import { PROVIDERS, getSettings } from "./ai.js";

const els = {
  providerGroup: document.getElementById("provider"),
  toggleBtns: document.querySelectorAll(".toggle-btn"),
  geminiPanel: document.getElementById("geminiPanel"),
  groqPanel: document.getElementById("groqPanel"),
  geminiKey: document.getElementById("geminiKey"),
  geminiModel: document.getElementById("geminiModel"),
  groqKey: document.getElementById("groqKey"),
  groqModel: document.getElementById("groqModel"),
  saveBtn: document.getElementById("saveBtn"),
  testBtn: document.getElementById("testBtn"),
  status: document.getElementById("status"),
};

let currentProvider = "gemini";

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
  els.geminiKey.value = s.geminiKey || "";
  els.geminiModel.value = s.geminiModel;
  els.groqKey.value = s.groqKey || "";
  els.groqModel.value = s.groqModel;
  setProvider(s.provider);
}

els.toggleBtns.forEach((btn) => {
  btn.addEventListener("click", () => setProvider(btn.dataset.provider));
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
  await chrome.storage.sync.set({
    provider,
    geminiKey: els.geminiKey.value.trim(),
    geminiModel: els.geminiModel.value,
    groqKey: els.groqKey.value.trim(),
    groqModel: els.groqModel.value,
  });
  status("Saved! You can close this tab.", "ok");
});

// Test the active provider with a tiny request.
els.testBtn.addEventListener("click", async () => {
  const provider = currentProvider;
  status("Testing…", "loading");
  try {
    if (provider === "groq") {
      await testGroq(els.groqKey.value.trim(), els.groqModel.value);
    } else {
      await testGemini(els.geminiKey.value.trim(), els.geminiModel.value);
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
