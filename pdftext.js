// pdftext.js
// Service-worker-side helper that extracts PDF text by delegating to an
// offscreen document (pdf.js needs DOM APIs the worker doesn't have).

const OFFSCREEN_PATH = "offscreen.html";

let creating = null; // de-dupe concurrent creation

async function hasOffscreen() {
  // getContexts is the modern API; fall back to clients if unavailable.
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }
  const matchedClients = await clients.matchAll();
  return matchedClients.some((c) => c.url.endsWith(OFFSCREEN_PATH));
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "Parse PDF files to extract text for summarization.",
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

/**
 * @param {ArrayBuffer} buffer  raw PDF bytes
 * @returns {Promise<{ text: string, pageCount: number }>}
 */
export async function extractPdfText(buffer) {
  await ensureOffscreen();

  // Send bytes as a plain array (reliable structured-clone across the boundary).
  const bytes = Array.from(new Uint8Array(buffer));

  const resp = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_EXTRACT_PDF",
    bytes,
  });

  if (!resp || !resp.ok) {
    throw new Error(resp?.error || "PDF extraction failed.");
  }
  return { text: resp.text, pageCount: resp.pageCount };
}
