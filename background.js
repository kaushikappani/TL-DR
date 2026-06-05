// background.js
// Service worker: orchestrates page extraction, AI provider calls, context
// menus, and injection of the floating overlay panel.

import { summarizePage, answerQuestion, getActive } from "./ai.js";
import { extractPdfText } from "./pdftext.js";

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|moz-extension):/i;

// Keep PDF downloads reasonable (we extract text locally, then send text only).
const MAX_PDF_BYTES = 30 * 1024 * 1024;

function isRestricted(url) {
  return !url || RESTRICTED.test(url);
}

/** Best-effort guess of whether a tab is showing a PDF (by URL only). */
function looksLikePdf(url) {
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return /\.pdf(\?|#|$)/i.test(url);
  }
  if (/\.pdf(\?|#|$)/i.test(u.pathname)) return true;
  // Common extensionless PDF endpoints (e.g. arxiv.org/pdf/2401.00001).
  if (/\/pdf\//i.test(u.pathname) || /\/pdf$/i.test(u.pathname)) return true;
  if (/[?&](format|type)=pdf\b/i.test(u.search)) return true;
  return false;
}


/** Fetch a PDF (web or file://) and return a page object carrying its bytes. */
async function extractPdf(url, tab) {
  console.log("[TL;DR] fetching PDF:", url);
  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    console.warn("[TL;DR] PDF fetch failed:", e);
    if (/^file:/i.test(url)) {
      throw new Error(
        'Can\'t read this local PDF. Enable "Allow access to file URLs" for this extension in chrome://extensions → Details, then reload the PDF.'
      );
    }
    throw new Error(
      "Couldn't download this PDF — the site may block direct downloads. (" + (e.message || "network error") + ")"
    );
  }
  if (!resp.ok) {
    throw new Error(`Couldn't fetch the PDF (HTTP ${resp.status} ${resp.statusText || ""}).`);
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("The PDF appears to be empty.");
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `This PDF is too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB). Limit is ${Math.round(
        MAX_PDF_BYTES / 1024 / 1024
      )} MB.`
    );
  }

  let name = "PDF";
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split("/").pop() || "PDF") || "PDF";
  } catch (_) {}

  // Extract text locally with pdf.js so it works with ANY provider (Groq/Gemini
  // both take text). Scanned/image-only PDFs yield little/no text.
  let extracted;
  try {
    extracted = await extractPdfText(buffer);
  } catch (e) {
    console.warn("[TL;DR] PDF parse failed:", e);
    throw new Error("Couldn't read this PDF's text (it may be encrypted or corrupted).");
  }
  if (!extracted.text || extracted.text.trim().length < 30) {
    throw new Error(
      "No selectable text found in this PDF — it's likely a scanned/image-only document, which this extension can't read."
    );
  }

  return {
    title: (tab && tab.title) || name,
    url,
    siteName: (() => { try { return new URL(url).hostname || "PDF"; } catch (_) { return "PDF"; } })(),
    description: "",
    isPdf: true,
    sizeKB: Math.round(buffer.byteLength / 1024),
    pageCount: extracted.pageCount,
    text: extracted.text,
  };
}

/** Ask the server whether a URL is a PDF (handles extensionless PDF URLs). */
async function contentTypeIsPdf(url) {
  if (!/^https?:/i.test(url)) return false;
  try {
    // A ranged GET is more reliable than HEAD (some servers reject HEAD).
    const resp = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    return ct.includes("application/pdf");
  } catch (_) {
    return false;
  }
}

/** Inject content.js into a tab and return the extracted page data. */
async function extractTab(tabId, url, tab) {
  // PDFs can't be read from the DOM (Chrome renders them in a plugin) — fetch
  // the file and let Gemini read it directly.
  if (looksLikePdf(url)) {
    return extractPdf(url, tab);
  }
  if (isRestricted(url)) {
    throw new Error("This page can't be read (browser/internal page). Open a normal web page.");
  }

  // Try to read the DOM. Injection FAILS on Chrome's PDF viewer and some
  // special pages — if it does, or the page yields no text, check whether the
  // URL is actually serving a PDF (common for extensionless PDF links).
  let page = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    page = results?.[0]?.result;
  } catch (injectErr) {
    if (await contentTypeIsPdf(url)) return extractPdf(url, tab);
    throw new Error("Couldn't read this page. " + (injectErr?.message || ""));
  }

  if (!page || !page.text || page.text.length < 50) {
    // Thin DOM — might be a PDF served without a .pdf extension.
    if (await contentTypeIsPdf(url)) return extractPdf(url, tab);
    throw new Error("Couldn't extract readable content from this page.");
  }
  return page;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  return tab;
}

// Cache the most recently extracted page per tab+url so summarize → Q&A can
// reuse it (especially large PDF text) without re-extracting or shipping the
// full text through messaging.
//
// IMPORTANT: this MUST survive service-worker restarts. MV3 kills the worker
// after ~30s idle, so an in-memory Map would be empty by the time the user
// types a question — which silently drops the page context. chrome.storage.
// session persists across restarts (and is cleared when the browser closes).
const cacheKey = (tabId) => `page_${tabId}`;

async function cacheGet(tabId, url) {
  const key = cacheKey(tabId);
  const obj = await chrome.storage.session.get(key);
  const entry = obj[key];
  return entry && entry.url === url ? entry.page : null;
}
async function cacheSet(tabId, url, page) {
  await chrome.storage.session.set({ [cacheKey(tabId)]: { url, page } });
}
async function cacheDelete(tabId) {
  await chrome.storage.session.remove(cacheKey(tabId));
}
chrome.tabs.onRemoved.addListener((tabId) => cacheDelete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) cacheDelete(tabId); // navigation — drop stale cache
});

// Strip the large extracted text before sending a page descriptor to the UI —
// the popup/overlay only needs title/meta; the full text stays in the cache.
function stripHeavy(page) {
  if (!page) return page;
  const { text, pdf, ...rest } = page;
  return rest;
}

// Lightweight page descriptor for display (no PDF download).
function pageInfoFor(tab) {
  const url = tab.url || "";
  const pdf = looksLikePdf(url);
  let siteName = "page";
  let name = tab.title || "Untitled";
  try {
    const u = new URL(url);
    siteName = u.hostname || (pdf ? "PDF" : "page");
    if (pdf) name = tab.title || decodeURIComponent(u.pathname.split("/").pop() || "PDF");
  } catch (_) {}
  return { title: name, url, siteName, isPdf: pdf, restricted: isRestricted(url) && !pdf };
}

/** Inject the floating overlay panel. Optionally seed it with selected text. */
async function openOverlay(tab, selectionText) {
  // Chrome renders PDFs in a restricted plugin we can't inject into. The popup
  // handles PDFs instead — signal that the panel isn't available here.
  if (looksLikePdf(tab.url)) {
    flashBadge("PDF");
    throw new Error("Open the extension popup to summarize this PDF — the floating panel isn't available on PDFs.");
  }
  if (isRestricted(tab.url)) {
    // Can't inject into restricted pages — fall back to opening the popup is not
    // possible programmatically, so just notify via badge.
    flashBadge("✕");
    throw new Error("This page can't be read (browser/internal page).");
  }
  // Pass the selection into the page before injecting the overlay script.
  if (selectionText) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (text) => { window.__gemSelectionText = text; },
      args: [selectionText],
    });
  } else {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__gemSelectionText = ""; },
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["overlay.js"],
  });
}

function flashBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#ff6b6b" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);
}

// ---- context menus ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "gem-summarize-page",
    title: "Summarize this page",
    contexts: ["page", "link"],
  });
  chrome.contextMenus.create({
    id: "gem-summarize-selection",
    title: "Summarize selection",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  try {
    if (info.menuItemId === "gem-summarize-selection") {
      await openOverlay(tab, info.selectionText || "");
    } else {
      await openOverlay(tab, "");
    }
  } catch (e) {
    flashBadge("✕");
  }
});

// ---- toolbar icon: we keep the popup as default, but expose overlay via menu.
// (The action popup opens automatically because it's set in the manifest.)

// ---- message router (used by both popup and overlay) ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Messages aimed at the offscreen document are handled there, not here.
  if (msg && msg.type === "OFFSCREEN_EXTRACT_PDF") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "PING_SETTINGS": {
          const { provider, apiKey, model } = await getActive();
          sendResponse({ ok: true, hasKey: !!apiKey, provider, model });
          break;
        }
        case "PAGE_INFO": {
          const tab = await getActiveTab();
          sendResponse({ ok: true, info: pageInfoFor(tab) });
          break;
        }
        case "EXTRACT": {
          const tab = await getActiveTab();
          const page = await extractTab(tab.id, tab.url, tab);
          await cacheSet(tab.id, tab.url, page);
          // For PDFs, don't ship the (large) bytes back to the popup; return a
          // lightweight descriptor. The bytes stay cached in session storage.
          sendResponse({ ok: true, page: stripHeavy(page) });
          break;
        }
        case "SUMMARIZE": {
          const tab = await getActiveTab();
          // Honor an explicitly-passed page (e.g. "Summarize selection", where
          // the caller supplies the selected text). Otherwise re-read the live
          // page (handles SPA/email/PDF view changes). Either way, cache it so
          // the follow-up Q&A uses the exact same content.
          const page = msg.page || (await extractTab(tab.id, tab.url, tab));
          await cacheSet(tab.id, tab.url, page);
          const summary = await summarizePage(page);
          sendResponse({ ok: true, summary, page: stripHeavy(page) });
          break;
        }
        case "ASK": {
          const tab = await getActiveTab();
          // Use the page cached at summarize time. If the worker restarted and
          // the cache is gone, re-extract live so we never answer blind.
          let page = await cacheGet(tab.id, tab.url);
          if (!page) {
            page = await extractTab(tab.id, tab.url, tab);
            await cacheSet(tab.id, tab.url, page);
          }
          const answer = await answerQuestion(page, msg.history);
          sendResponse({ ok: true, answer });
          break;
        }
        case "OPEN_OVERLAY": {
          const tab = await getActiveTab();
          await openOverlay(tab, "");
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown request." });
      }
    } catch (e) {
      const error = e && e.message === "NO_API_KEY"
        ? "NO_API_KEY"
        : (e && e.message) || "Something went wrong.";
      sendResponse({ ok: false, error });
    }
  })();
  return true;
});
