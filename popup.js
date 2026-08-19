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

// In-memory state for this popup session. (Page content lives in the worker's
// per-tab cache; the popup only tracks chat history + display flags.)
const state = {
  isPdf: false,
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

// Open a streaming port for a SUMMARIZE/ASK request. onChunk(text) fires for
// each incremental piece, onTool(event) for MCP tool activity, and
// onConfirm(request, respond) when a tool call needs the user's go-ahead;
// resolves with the final {ok, summary|answer, page}.
function streamRequest(message, onChunk, onTool, onConfirm) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: "stream" });
    } catch (e) {
      resolve({ ok: false, error: "Couldn't reach the extension." });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      resolve(result);
    };
    port.onMessage.addListener((m) => {
      if (m.type === "chunk") onChunk(m.text);
      else if (m.type === "tool") onTool?.(m);
      else if (m.type === "confirm") {
        onConfirm?.(m, (approved) => {
          try {
            port.postMessage({ type: "TOOL_DECISION", id: m.id, approved });
          } catch (_) {}
        });
      }
      else if (m.type === "done") finish({ ok: true, ...m });
      else if (m.type === "error") finish({ ok: false, error: m.error });
    });
    port.onDisconnect.addListener(() => {
      finish({ ok: false, error: chrome.runtime.lastError?.message || "Connection lost." });
    });
    port.postMessage(message);
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

// While an MCP tool runs there is nothing to stream yet, so the thinking
// bubble narrates what the model reached for.
function showToolActivity(bubble, ev, answerSoFar) {
  if (answerSoFar) return; // real text already arrived — don't overwrite it
  const label = ev.tool ? `${ev.server} · ${ev.tool}` : ev.server;
  if (ev.phase === "ask") return; // the approval card takes the bubble over
  if (ev.phase === "call") bubble.textContent = `🔧 ${label}…`;
  else if (ev.phase === "result") bubble.textContent = `🔧 ${label} ✓`;
  else if (ev.phase === "declined") bubble.textContent = `🔧 ${label} skipped — answering without it…`;
  else if (ev.phase === "error") bubble.textContent = `🔧 ${label} failed — answering without it…`;
}

// Approval card for one tool call, drawn inside the pending answer bubble.
// Built with DOM calls, not innerHTML — the args come from the model.
function askToolPermission(bubble, req, respond) {
  const label = `${req.server} · ${req.tool}`;
  bubble.className = "msg model tool-ask";
  bubble.textContent = "";

  const title = document.createElement("div");
  title.className = "tool-ask-title";
  title.textContent = `🔧 Run ${label}?`;
  bubble.append(title);

  if (req.reason) {
    const why = document.createElement("div");
    why.className = "tool-ask-reason";
    why.textContent = req.reason;
    bubble.append(why);
  }

  const args = JSON.stringify(req.args || {});
  if (args && args !== "{}") {
    const pre = document.createElement("pre");
    pre.className = "tool-ask-args";
    pre.textContent = args.length > 300 ? `${args.slice(0, 300)}…` : args;
    bubble.append(pre);
  }

  const actions = document.createElement("div");
  actions.className = "tool-ask-actions";
  const decide = (approved) => {
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    bubble.className = "msg model thinking";
    bubble.textContent = approved ? `🔧 ${label}…` : `🔧 ${label} skipped — answering without it…`;
    respond(approved);
  };
  const run = document.createElement("button");
  run.className = "tool-run";
  run.textContent = "Run";
  run.addEventListener("click", () => decide(true));
  const skip = document.createElement("button");
  skip.className = "tool-skip";
  skip.textContent = "Skip";
  skip.addEventListener("click", () => decide(false));
  actions.append(run, skip);
  bubble.append(actions);

  bubble.scrollIntoView({ block: "end" });
  run.focus();
}

// ---- quick actions ----

// The chips shipped in popup.html are the fallback; once the model has read
// the page it replaces them with follow-ups that fit what the page actually is.
function renderQuickActions(actions) {
  els.suggestions.textContent = "";
  for (const action of actions) {
    const chip = document.createElement("button");
    chip.className = action.tool ? "chip tool" : "chip";
    chip.textContent = action.tool ? `🔧 ${action.label}` : action.label;
    chip.dataset.q = action.prompt;
    if (action.tool) chip.dataset.tool = "1";
    chip.title = action.prompt;
    els.suggestions.append(chip);
  }
}

async function loadQuickActions(summary) {
  const resp = await send({ type: "SUGGEST", summary });
  // Keep the defaults on failure, and don't stomp on a chat already underway.
  if (!resp?.ok || !resp.actions?.length) return;
  if (els.suggestions.classList.contains("hidden")) return;
  renderQuickActions(resp.actions);
}

// ---- core flows ----

async function init() {
  // Check API key + model.
  const settings = await send({ type: "PING_SETTINGS" });
  if (!settings.ok) {
    showStatus(settings.error || "Could not reach extension.", "error");
    return;
  }
  const providerLabel = settings.provider === "groq" ? "Groq" : "Gemini";
  const mcpTag = settings.mcpServers ? ` · ${settings.mcpServers} MCP` : "";
  els.modelTag.textContent =
    (settings.model ? `${providerLabel} · ${settings.model}` : providerLabel) + mcpTag;
  if (!settings.hasKey) {
    els.setupBanner.classList.remove("hidden");
    els.main.classList.add("hidden");
    return;
  }

  // Lightweight page info for the header (no PDF download until summarize).
  const info = await send({ type: "PAGE_INFO" });
  if (info.ok) {
    const i = info.info;
    state.isPdf = i.isPdf;
    els.pageTitle.textContent = i.title;
    els.pageMeta.textContent = i.isPdf ? `${i.siteName} · PDF` : i.siteName;
    els.pageInfo.classList.remove("hidden");
    if (i.restricted) {
      showStatus("This page can't be read (browser/internal page).", "error");
      els.summarizeBtn.disabled = true;
      els.floatBtn.classList.add("hidden");
    } else {
      els.summarizeBtn.textContent = i.isPdf ? "Summarize this PDF" : "Summarize this page";
      // The floating panel can't be injected into Chrome's PDF viewer.
      if (i.isPdf) els.floatBtn.classList.add("hidden");
    }
  }
}

async function doSummarize() {
  if (state.busy) return;
  setBusy(true);
  showStatus(state.isPdf ? "Reading and summarizing the PDF…" : "Reading and summarizing the page…");
  els.summarySection.classList.add("hidden");

  // Re-read the LIVE page/PDF each time (handles SPA/email view changes). The
  // background worker holds any PDF bytes; we don't ship them through messaging.
  // Stream the summary in token-by-token for instant feedback.
  let acc = "";
  let revealed = false;
  const onChunk = (text) => {
    acc += text;
    if (!revealed) {
      hideStatus();
      els.summarySection.classList.remove("hidden");
      revealed = true;
    }
    els.summaryContent.innerHTML = renderMarkdown(acc);
  };

  const resp = await streamRequest({ type: "SUMMARIZE" }, onChunk);
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
  // Refresh the header from the freshly-extracted page and reset chat, since
  // any prior Q&A was about the previous content.
  if (resp.page) {
    state.isPdf = !!resp.page.isPdf;
    els.pageTitle.textContent = resp.page.title;
    els.pageMeta.textContent = resp.page.isPdf
      ? `${resp.page.siteName} · PDF${resp.page.sizeKB ? ` · ${resp.page.sizeKB} KB` : ""}`
      : `${resp.page.siteName}${resp.page.wordCount ? ` · ${resp.page.wordCount} words` : ""}`;
    els.pageInfo.classList.remove("hidden");
  }
  state.history = [];
  els.chatLog.innerHTML = "";
  els.suggestions.classList.remove("hidden");

  state.rawSummary = resp.summary;
  els.summaryContent.innerHTML = renderMarkdown(resp.summary);
  els.summarySection.classList.remove("hidden");
  els.chatSection.classList.remove("hidden");
  els.chatInput.focus();

  loadQuickActions(resp.summary); // fills in behind the summary
}

async function ask(question, opts = {}) {
  if (state.busy || !question.trim()) return;

  els.suggestions.classList.add("hidden");
  addMessage("user", question);
  state.history.push({ role: "user", text: question });
  els.chatInput.value = "";

  setBusy(true);
  const bubble = addMessage("model", "Thinking…", { thinking: true });

  // The background reuses the cached page (incl. PDF bytes) for this tab.
  // Stream the answer into the bubble as it arrives.
  let acc = "";
  const onChunk = (text) => {
    acc += text;
    bubble.classList.remove("thinking");
    bubble.innerHTML = renderMarkdown(acc);
    bubble.scrollIntoView({ block: "end" });
  };

  const resp = await streamRequest(
    { type: "ASK", history: state.history, preapproved: !!opts.preapproved },
    onChunk,
    (ev) => showToolActivity(bubble, ev, acc),
    (req, respond) => askToolPermission(bubble, req, respond)
  );
  setBusy(false);

  if (!resp.ok) {
    bubble.remove();
    if (resp.error === "NO_API_KEY") {
      els.setupBanner.classList.remove("hidden");
      return;
    }
    addMessage("model", `⚠ ${resp.error}`);
    // drop the failed user turn so history stays consistent
    state.history.pop();
    return;
  }

  bubble.classList.remove("thinking");
  bubble.innerHTML = renderMarkdown(resp.answer);
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
  // Tapping a tool-backed action IS the approval — no second confirmation.
  if (chip) ask(chip.dataset.q, { preapproved: chip.dataset.tool === "1" });
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
