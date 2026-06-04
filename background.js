// background.js
// Service worker: orchestrates page extraction, Gemini calls, context menus,
// and injection of the floating overlay panel.

import { summarizePage, answerQuestion, getSettings } from "./gemini.js";

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source|moz-extension):/i;

function isRestricted(url) {
  return !url || RESTRICTED.test(url);
}

/** Inject content.js into a tab and return the extracted page data. */
async function extractTab(tabId, url) {
  if (isRestricted(url)) {
    throw new Error("This page can't be read (browser/internal page). Open a normal web page.");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  const page = results?.[0]?.result;
  if (!page || !page.text || page.text.length < 50) {
    throw new Error("Couldn't extract readable content from this page.");
  }
  return page;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  return tab;
}

/** Inject the floating overlay panel. Optionally seed it with selected text. */
async function openOverlay(tab, selectionText) {
  if (isRestricted(tab.url)) {
    // Can't inject into restricted pages — fall back to opening the popup is not
    // possible programmatically, so just notify via badge.
    flashBadge("✕");
    return;
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
  (async () => {
    try {
      switch (msg.type) {
        case "PING_SETTINGS": {
          const { apiKey, model } = await getSettings();
          sendResponse({ ok: true, hasKey: !!apiKey, model });
          break;
        }
        case "EXTRACT": {
          const tab = await getActiveTab();
          const page = await extractTab(tab.id, tab.url);
          sendResponse({ ok: true, page });
          break;
        }
        case "SUMMARIZE": {
          let page = msg.page;
          if (!page) {
            const tab = await getActiveTab();
            page = await extractTab(tab.id, tab.url);
          }
          const summary = await summarizePage(page);
          sendResponse({ ok: true, summary, page });
          break;
        }
        case "ASK": {
          const answer = await answerQuestion(msg.page, msg.history);
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
