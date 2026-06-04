// popup.js
// Drives the popup UI: extraction, summary, and Q&A chat.

const els = {
  settingsBtn: document.getElementById("settingsBtn"),
  setupBanner: document.getElementById("setupBanner"),
  openOptions: document.getElementById("openOptions"),
  main: document.getElementById("main"),
  pageInfo: document.getElementById("pageInfo"),
  pageTitle: document.getElementById("pageTitle"),
  pageMeta: document.getElementById("pageMeta"),
  summarizeBtn: document.getElementById("summarizeBtn"),
  floatBtn: document.getElementById("floatBtn"),
  status: document.getElementById("status"),
  summarySection: document.getElementById("summarySection"),
  summaryContent: document.getElementById("summaryContent"),
  copySummary: document.getElementById("copySummary"),
  chatSection: document.getElementById("chatSection"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
  chatSend: document.getElementById("chatSend"),
  suggestions: document.getElementById("suggestions"),
  modelTag: document.getElementById("modelTag"),
};

// In-memory state for this popup session.
const state = {
  page: null,        // extracted page data
  history: [],       // [{ role: 'user'|'model', text }]
  busy: false,
  rawSummary: "",
};

// ---- helpers ----

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

function showStatus(text, kind = "loading") {
  els.status.className = `status ${kind}`;
  els.status.innerHTML =
    kind === "loading" ? `<span class="spinner"></span>${text}` : text;
  els.status.classList.remove("hidden");
}

function hideStatus() {
  els.status.classList.add("hidden");
}

// Minimal, safe markdown-ish rendering: **bold**, bullet lists, paragraphs.
function renderMarkdown(text) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = text.split("\n");
  let html = "";
  let inList = false;

  const inline = (s) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

  for (let raw of lines) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^[-*•]\s+/, ""))}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line === "") continue;
      html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function addMessage(role, text, opts = {}) {
  const div = document.createElement("div");
  div.className = `msg ${role}${opts.thinking ? " thinking" : ""}`;
  div.innerHTML = role === "model" && !opts.thinking ? renderMarkdown(text) : escapeText(text);
  els.chatLog.appendChild(div);
  els.chatLog.scrollIntoView(false);
  div.scrollIntoView({ block: "end" });
  return div;
}

function escapeText(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function setBusy(busy) {
  state.busy = busy;
  els.summarizeBtn.disabled = busy;
  els.chatSend.disabled = busy;
  els.chatInput.disabled = busy;
}

// ---- core flows ----

async function init() {
  // Check API key + model.
  const settings = await send({ type: "PING_SETTINGS" });
  if (!settings.ok) {
    showStatus(settings.error || "Could not reach extension.", "error");
    return;
  }
  els.modelTag.textContent = settings.model || "";
  if (!settings.hasKey) {
    els.setupBanner.classList.remove("hidden");
    els.main.classList.add("hidden");
    return;
  }

  // Pre-extract the page so we can show its title and enable chat.
  const ext = await send({ type: "EXTRACT" });
  if (ext.ok) {
    state.page = ext.page;
    els.pageTitle.textContent = ext.page.title;
    els.pageMeta.textContent = `${ext.page.siteName} · ${ext.page.wordCount} words`;
    els.pageInfo.classList.remove("hidden");
  } else {
    showStatus(ext.error, "error");
    els.summarizeBtn.disabled = true;
  }
}

async function doSummarize() {
  if (state.busy) return;
  setBusy(true);
  showStatus("Reading and summarizing the page…");
  els.summarySection.classList.add("hidden");

  const resp = await send({ type: "SUMMARIZE", page: state.page });
  setBusy(false);

  if (!resp.ok) {
    if (resp.error === "NO_API_KEY") {
      els.setupBanner.classList.remove("hidden");
      hideStatus();
      return;
    }
    showStatus(resp.error, "error");
    return;
  }

  hideStatus();
  state.page = resp.page || state.page;
  state.rawSummary = resp.summary;
  els.summaryContent.innerHTML = renderMarkdown(resp.summary);
  els.summarySection.classList.remove("hidden");
  els.chatSection.classList.remove("hidden");
  els.chatInput.focus();
}

async function ask(question) {
  if (state.busy || !question.trim()) return;
  if (!state.page) {
    showStatus("Page not loaded yet.", "error");
    return;
  }

  els.suggestions.classList.add("hidden");
  addMessage("user", question);
  state.history.push({ role: "user", text: question });
  els.chatInput.value = "";

  setBusy(true);
  const thinking = addMessage("model", "Thinking…", { thinking: true });

  const resp = await send({
    type: "ASK",
    page: state.page,
    history: state.history,
  });

  thinking.remove();
  setBusy(false);

  if (!resp.ok) {
    if (resp.error === "NO_API_KEY") {
      els.setupBanner.classList.remove("hidden");
      return;
    }
    addMessage("model", `⚠ ${resp.error}`);
    // drop the failed user turn so history stays consistent
    state.history.pop();
    return;
  }

  addMessage("model", resp.answer);
  state.history.push({ role: "model", text: resp.answer });
  els.chatInput.focus();
}

// ---- events ----

els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
els.summarizeBtn.addEventListener("click", doSummarize);

els.floatBtn.addEventListener("click", async () => {
  const resp = await send({ type: "OPEN_OVERLAY" });
  if (resp.ok) {
    window.close(); // hand off to the in-page panel
  } else {
    showStatus(resp.error || "Couldn't open the panel on this page.", "error");
  }
});

els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  ask(els.chatInput.value);
});

els.suggestions.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) ask(chip.dataset.q);
});

els.copySummary.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.rawSummary);
    els.copySummary.textContent = "Copied!";
    setTimeout(() => (els.copySummary.textContent = "Copy"), 1500);
  } catch (_) {
    els.copySummary.textContent = "Failed";
  }
});

init();
