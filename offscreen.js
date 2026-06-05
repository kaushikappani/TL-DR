// offscreen.js
// Runs in an offscreen document (has full DOM), so pdf.js can load here even
// though it can't in the service worker. Extracts text from PDF bytes on
// request from the background worker.

import * as pdfjs from "./lib/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const MAX_CHARS = 60000;

async function extractText(bytes) {
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const parts = [];
  let total = 0;

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it) => it.str || "")
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) {
      parts.push(pageText);
      total += pageText.length;
    }
    page.cleanup();
    if (total > MAX_CHARS) {
      parts.push("\n\n[...content truncated...]");
      break;
    }
  }
  await doc.destroy();
  return { text: parts.join("\n\n"), pageCount };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "OFFSCREEN_EXTRACT_PDF") return; // not for us
  (async () => {
    try {
      // The bytes arrive as a regular array (structured clone of Uint8Array
      // works, but we send a plain array for safety across the boundary).
      const bytes = new Uint8Array(msg.bytes);
      const result = await extractText(bytes);
      sendResponse({ ok: true, ...result });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || "PDF parse failed." });
    }
  })();
  return true; // async response
});
