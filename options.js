// options.js
import { DEFAULT_MODEL } from "./gemini.js";

const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const toggleKey = document.getElementById("toggleKey");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const statusEl = document.getElementById("status");

function status(text, kind) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
  statusEl.classList.remove("hidden");
}

async function load() {
  const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
  if (apiKey) apiKeyEl.value = apiKey;
  modelEl.value = model || DEFAULT_MODEL;
}

toggleKey.addEventListener("click", () => {
  apiKeyEl.type = apiKeyEl.type === "password" ? "text" : "password";
});

saveBtn.addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  const model = modelEl.value;
  if (!apiKey) {
    status("Please enter an API key.", "error");
    return;
  }
  await chrome.storage.sync.set({ apiKey, model });
  status("Saved! You can close this tab.", "ok");
});

// Test the key by making a tiny generateContent call directly.
testBtn.addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();
  const model = modelEl.value;
  if (!apiKey) {
    status("Enter an API key first.", "error");
    return;
  }
  status("Testing…", "loading");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    });
    if (resp.ok) {
      status("✓ Connection works! Don't forget to Save.", "ok");
    } else {
      const err = await resp.json().catch(() => ({}));
      const msg = err?.error?.message || resp.statusText;
      status(`✗ Failed (${resp.status}): ${msg}`, "error");
    }
  } catch (e) {
    status(`✗ Network error: ${e.message}`, "error");
  }
});

load();
