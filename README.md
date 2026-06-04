# TL;DR

A Chrome extension (Manifest V3) that reads any web page or news article, gives you a
short summary, and lets you ask follow-up questions about it — powered by the Google
Gemini API.

## Features

- **One-click summary** — TL;DR + key bullet points of the current page.
- **Ask questions** — chat with the page; answers are grounded in the page's content,
  with conversation history.
- **Right-click menu** — "Summarize this page" anywhere, or "Summarize selection" when
  text is selected.
- **Floating panel** — a draggable, minimizable panel that opens right on the page
  (no need to keep the popup open). Open it from the popup's "Open floating panel"
  button or the right-click menu.
- **Smart extraction** — pulls the real article body and skips nav, ads, comments, and
  other boilerplate.
- **Model picker** — choose between Gemini Flash (fast) and Pro (most capable).
- **Robust errors** — clear messages for missing/invalid keys, rate limits, safety
  blocks, and restricted pages.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `summarize` folder.
4. Pin the extension, then click its icon → ⚙ (Settings).
5. Paste your **Gemini API key** (get one free at
   <https://aistudio.google.com/app/apikey>), pick a model, click **Test connection**,
   then **Save**.

## Use

- **Popup:** click the toolbar icon → **Summarize this page** → ask questions in the
  chat box, or use the suggestion chips.
- **Floating panel:** popup → **Open floating panel ↗**, or right-click the page →
  **Summarize this page**. Drag it by the header; **–** minimizes, **✕** closes.
- **Selection:** select text on a page → right-click → **Summarize selection**.

## Privacy

Your API key is stored only in your browser (`chrome.storage.sync`). Page content is
sent only to Google's Gemini API to produce summaries and answers — nowhere else.

## Files

| File | Role |
|------|------|
| `manifest.json` | Extension config (MV3) |
| `background.js` | Service worker — extraction, Gemini calls, context menus, overlay injection |
| `gemini.js` | Gemini REST API wrapper (summarize / ask) |
| `content.js` | Readability-style page content extractor |
| `popup.html/.css/.js` | Toolbar popup UI |
| `overlay.html`* / `overlay.css/.js` | In-page floating panel (markup built in JS) |
| `options.html/.css/.js` | Settings page (API key + model) |
| `icons/` | 16/48/128px icons |

\* The overlay markup is created in `overlay.js`; only `overlay.css` is a separate file.
