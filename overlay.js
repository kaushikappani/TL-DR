// overlay.js
// Injectable floating panel rendered directly inside the page.
// Self-contained: handles its own UI, talks to the background worker
// for extraction / summarize / ask. Safe to inject repeatedly (toggles).

(function () {
  const PANEL_ID = "__gem_summarizer_panel__";

  // Toggle: if already open, close and bail.
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    existing.remove();
    return { toggled: "closed" };
  }

  // ---- state ----
  const state = {
    page: null,
    history: [],
    busy: false,
    rawSummary: "",
    selectionText: window.__gemSelectionText || "",
  };

  // ---- styles (loaded from web_accessible_resource so CSP-safe) ----
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay.css");
  link.id = "__gem_summarizer_style__";
  (document.head || document.documentElement).appendChild(link);

  // ---- panel markup ----
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="gem-header" id="gem-drag">
      <span class="gem-title"><span class="gem-logo">✦</span> TL;DR</span>
      <div class="gem-header-actions">
        <button type="button" class="gem-icon" id="gem-min" title="Minimize">–</button>
        <button type="button" class="gem-icon" id="gem-close" title="Close">✕</button>
      </div>
    </div>
    <div class="gem-body" id="gem-body">
      <div class="gem-pageinfo" id="gem-pageinfo"></div>
      <button type="button" class="gem-btn gem-primary" id="gem-summarize">${state.selectionText ? "Summarize selection" : "Summarize this page"}</button>
      <div class="gem-status gem-hidden" id="gem-status"></div>

      <div class="gem-summary gem-hidden" id="gem-summary-wrap">
        <div class="gem-label">
          <span>Summary</span>
          <button type="button" class="gem-link" id="gem-copy">Copy</button>
        </div>
        <div class="gem-summary-content" id="gem-summary"></div>
      </div>

      <div class="gem-chat gem-hidden" id="gem-chat-wrap">
        <div class="gem-label"><span>Ask about this ${state.selectionText ? "text" : "page"}</span></div>
        <div class="gem-chatlog" id="gem-chatlog"></div>
        <form class="gem-chatform" id="gem-chatform">
          <input id="gem-input" type="text" placeholder="Ask a question…" autocomplete="off" />
          <button type="submit" class="gem-send" id="gem-send">➤</button>
        </form>
      </div>
      <div class="gem-footer">
        <span class="gem-credit">
          Built by
          <a href="https://kaushikappani.github.io/portfolio/" target="_blank" rel="noopener">Kaushik Appani</a>
        </span>
      </div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  // Isolate the panel from the host page: stop our events from bubbling up to
  // the page's own click handlers / SPA router (which would otherwise change
  // the URL or trigger page behavior when interacting with the panel).
  [
    "click", "mousedown", "mouseup", "dblclick", "submit",
    "keydown", "keyup", "keypress", "pointerdown", "pointerup", "wheel",
  ].forEach((type) => {
    panel.addEventListener(type, (e) => e.stopPropagation(), false);
  });

  const $ = (id) => panel.querySelector("#" + id);
  const ui = {
    body: $("gem-body"),
    pageinfo: $("gem-pageinfo"),
    summarizeBtn: $("gem-summarize"),
    status: $("gem-status"),
    summaryWrap: $("gem-summary-wrap"),
    summary: $("gem-summary"),
    copy: $("gem-copy"),
    chatWrap: $("gem-chat-wrap"),
    chatlog: $("gem-chatlog"),
    chatform: $("gem-chatform"),
    input: $("gem-input"),
    send: $("gem-send"),
  };

  // ---- helpers ----
  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else resolve(resp);
      });
    });
  }

  // Streaming port: post one request, receive {chunk|tool|confirm}* then
  // {done}|{error}. onConfirm(request, respond) gates each MCP tool call.
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
    ui.status.className = `gem-status gem-${kind}`;
    ui.status.innerHTML =
      kind === "loading" ? `<span class="gem-spin"></span>${escapeText(text)}` : escapeText(text);
    ui.status.classList.remove("gem-hidden");
  }
  function hideStatus() {
    ui.status.classList.add("gem-hidden");
  }

  function escapeText(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderMarkdown(text) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>");
    let html = "", inList = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (/^[-*•]\s+/.test(line)) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${inline(line.replace(/^[-*•]\s+/, ""))}</li>`;
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line) html += `<p>${inline(line)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  function addMessage(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = `gem-msg gem-${role}${opts.thinking ? " gem-thinking" : ""}`;
    div.innerHTML = role === "model" && !opts.thinking ? renderMarkdown(text) : escapeText(text);
    ui.chatlog.appendChild(div);
    div.scrollIntoView({ block: "end" });
    return div;
  }

  // Approval card for one MCP tool call, drawn inside the pending answer
  // bubble. Built with DOM calls, not innerHTML — the args come from the model.
  function askToolPermission(bubble, req, respond) {
    const label = `${req.server} · ${req.tool}`;
    bubble.className = "gem-msg gem-model gem-tool-ask";
    bubble.textContent = "";

    const title = document.createElement("div");
    title.className = "gem-tool-ask-title";
    title.textContent = `🔧 Run ${label}?`;
    bubble.append(title);

    if (req.reason) {
      const why = document.createElement("div");
      why.className = "gem-tool-ask-reason";
      why.textContent = req.reason;
      bubble.append(why);
    }

    const args = JSON.stringify(req.args || {});
    if (args && args !== "{}") {
      const pre = document.createElement("pre");
      pre.className = "gem-tool-ask-args";
      pre.textContent = args.length > 300 ? `${args.slice(0, 300)}…` : args;
      bubble.append(pre);
    }

    const actions = document.createElement("div");
    actions.className = "gem-tool-ask-actions";
    const decide = (approved) => {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      bubble.className = "gem-msg gem-model gem-thinking";
      bubble.textContent = approved ? `🔧 ${label}…` : `🔧 ${label} skipped — answering without it…`;
      respond(approved);
    };
    const run = document.createElement("button");
    run.className = "gem-tool-run";
    run.textContent = "Run";
    run.addEventListener("click", () => decide(true));
    const skip = document.createElement("button");
    skip.className = "gem-tool-skip";
    skip.textContent = "Skip";
    skip.addEventListener("click", () => decide(false));
    actions.append(run, skip);
    bubble.append(actions);

    bubble.scrollIntoView({ block: "end" });
    run.focus();
  }

  function setBusy(b) {
    state.busy = b;
    ui.summarizeBtn.disabled = b;
    ui.send.disabled = b;
    ui.input.disabled = b;
  }

  // Build a "page" object from the selection, or extract via background.
  // Pass forceFresh=true to re-read live page content instead of reusing the
  // cached snapshot (the page may have changed — e.g. a new email / SPA view).
  async function ensurePage(forceFresh = false) {
    // Selection mode is fixed text — never changes, safe to cache.
    if (state.selectionText) {
      if (!state.page) {
        state.page = {
          title: document.title || "Selected text",
          url: location.href,
          siteName: location.hostname,
          description: "",
          text: state.selectionText,
          wordCount: state.selectionText.split(/\s+/).filter(Boolean).length,
        };
      }
      return state.page;
    }
    if (state.page && !forceFresh) return state.page;
    const ext = await send({ type: "EXTRACT" });
    if (!ext.ok) throw new Error(ext.error);
    state.page = ext.page;
    return state.page;
  }

  // ---- flows ----
  async function doSummarize() {
    if (state.busy) return;
    setBusy(true);
    showStatus("Reading and summarizing…");
    ui.summaryWrap.classList.add("gem-hidden");
    try {
      // Refresh the lightweight page info for the header.
      const info = await ensurePage(true);
      ui.pageinfo.textContent = `${info.siteName} · ${info.wordCount} words`;

      // Only pass an explicit page for selection mode (it carries the real
      // selected text). For normal pages, omit it so the background re-extracts
      // the FULL live content server-side — same path the popup uses. The
      // descriptor from EXTRACT has its heavy `text` stripped, so passing it
      // here would summarize near-empty content.
      const reqPage = state.selectionText ? info : undefined;

      // Stream the summary in token-by-token.
      let acc = "";
      let revealed = false;
      const onChunk = (text) => {
        acc += text;
        if (!revealed) {
          hideStatus();
          ui.summaryWrap.classList.remove("gem-hidden");
          revealed = true;
        }
        ui.summary.innerHTML = renderMarkdown(acc);
      };

      const resp = await streamRequest({ type: "SUMMARIZE", page: reqPage }, onChunk);
      if (!resp.ok) throw new Error(resp.error);
      hideStatus();
      state.page = resp.page || page;
      // Reset any prior Q&A — it was about the previous content.
      state.history = [];
      ui.chatlog.innerHTML = "";
      state.rawSummary = resp.summary;
      ui.summary.innerHTML = renderMarkdown(resp.summary);
      ui.summaryWrap.classList.remove("gem-hidden");
      ui.chatWrap.classList.remove("gem-hidden");
      ui.input.focus();
    } catch (e) {
      handleError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function ask(question) {
    if (state.busy || !question.trim()) return;
    addMessage("user", question);
    state.history.push({ role: "user", text: question });
    ui.input.value = "";
    setBusy(true);
    const bubble = addMessage("model", "Thinking…", { thinking: true });
    try {
      const page = await ensurePage();
      // Pass the page only in selection mode (it carries the real selected
      // text). For normal pages, omit it so the background uses the full cached
      // / freshly-extracted content — same path the popup uses.
      const reqPage = state.selectionText ? page : undefined;
      // Stream the answer into the bubble as it arrives.
      let acc = "";
      const onChunk = (text) => {
        acc += text;
        bubble.classList.remove("gem-thinking");
        bubble.innerHTML = renderMarkdown(acc);
        bubble.scrollIntoView({ block: "end" });
      };
      // While an MCP tool runs there is nothing to stream, so narrate it.
      const onTool = (ev) => {
        if (acc || ev.phase === "ask") return; // "ask" -> the approval card owns the bubble
        const label = ev.tool ? `${ev.server} · ${ev.tool}` : ev.server;
        bubble.textContent =
          ev.phase === "call" ? `🔧 ${label}…`
          : ev.phase === "result" ? `🔧 ${label} ✓`
          : ev.phase === "declined" ? `🔧 ${label} skipped — answering without it…`
          : `🔧 ${label} failed — answering without it…`;
      };
      const resp = await streamRequest(
        { type: "ASK", page: reqPage, history: state.history },
        onChunk,
        onTool,
        (req, respond) => askToolPermission(bubble, req, respond)
      );
      if (!resp.ok) throw new Error(resp.error);
      bubble.classList.remove("gem-thinking");
      bubble.innerHTML = renderMarkdown(resp.answer);
      state.history.push({ role: "model", text: resp.answer });
      ui.input.focus();
    } catch (e) {
      bubble.remove();
      addMessage("model", "⚠ " + e.message);
      state.history.pop();
    } finally {
      setBusy(false);
    }
  }

  function handleError(msg) {
    if (msg === "NO_API_KEY") {
      showStatus("No API key set. Open the extension's Settings to add your Gemini key.", "error");
    } else {
      showStatus(msg, "error");
    }
  }

  // ---- events ----
  ui.summarizeBtn.addEventListener("click", doSummarize);
  ui.chatform.addEventListener("submit", (e) => { e.preventDefault(); ask(ui.input.value); });
  ui.copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.rawSummary); ui.copy.textContent = "Copied!"; }
    catch (_) { ui.copy.textContent = "Failed"; }
    setTimeout(() => (ui.copy.textContent = "Copy"), 1500);
  });
  function toggleMinimize() { panel.classList.toggle("gem-minimized"); }

  $("gem-close").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.remove();
    link.remove();
  });
  $("gem-min").addEventListener("click", (e) => {
    e.stopPropagation(); // don't also trigger the header-click toggle
    toggleMinimize();
  });

  // Dragging by the header — and a plain click on the header (that wasn't a
  // drag and wasn't on a button) expands/collapses the panel.
  (function makeDraggable() {
    const handle = $("gem-drag");
    let sx, sy, ox, oy, dragging = false, moved = false;
    const DRAG_THRESHOLD = 4; // px before a press counts as a drag, not a click

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".gem-icon")) return; // let buttons handle themselves
      dragging = true;
      moved = false;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = "auto";
      // Capture phase so these fire even though the panel stops bubbling.
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
      e.preventDefault();
    });

    function move(e) {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      if (!moved) return;
      let nx = Math.max(0, Math.min(ox + dx, window.innerWidth - 60));
      let ny = Math.max(0, Math.min(oy + dy, window.innerHeight - 40));
      panel.style.left = nx + "px";
      panel.style.top = ny + "px";
    }

    function up() {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      const wasDrag = moved;
      dragging = false;
      moved = false;
      // A press that didn't move = a click on the header → toggle collapse.
      if (!wasDrag) toggleMinimize();
    }
  })();

  // Show the page info immediately, but wait for the user to click
  // "Summarize" rather than auto-running (avoids surprise API calls).
  (async () => {
    try {
      const page = await ensurePage();
      ui.pageinfo.textContent = `${page.siteName} · ${page.wordCount} words`;
    } catch (e) {
      handleError(e.message);
    }
  })();

  return { toggled: "open" };
})();
