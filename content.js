// content.js
// Injected on demand to extract the main readable content of the current page.
// Uses a lightweight Readability-style heuristic: find the densest text block,
// strip boilerplate (nav, ads, scripts), and return clean text + metadata.

(function () {
  const MAX_CHARS = 30000; // keep payload reasonable for the API

  function isHidden(el) {
    const style = window.getComputedStyle(el);
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      el.getAttribute("aria-hidden") === "true"
    );
  }

  const BOILERPLATE = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "NAV", "HEADER", "FOOTER",
    "ASIDE", "FORM", "BUTTON", "SVG", "CANVAS", "VIDEO", "AUDIO"
  ]);

  const BOILERPLATE_HINTS = /(nav|menu|sidebar|footer|header|comment|share|social|advert|promo|cookie|subscribe|newsletter|related|recommend|breadcrumb|pagination)/i;

  function looksLikeBoilerplate(el) {
    const id = (el.id || "").toString();
    const cls = (el.className || "").toString();
    return BOILERPLATE_HINTS.test(id) || BOILERPLATE_HINTS.test(cls);
  }

  // Score a candidate container by how much real paragraph text it holds.
  function scoreNode(node) {
    let textLen = 0;
    const paragraphs = node.querySelectorAll("p, li, blockquote");
    paragraphs.forEach((p) => {
      const t = (p.innerText || "").trim();
      if (t.length > 25) textLen += t.length;
    });
    // commas correlate with prose density
    const commas = (node.innerText || "").split(",").length - 1;
    return textLen + commas * 3;
  }

  function getMainContent() {
    // Prefer semantic <article>, then scored containers.
    const candidates = [];
    document
      .querySelectorAll("article, main, [role='main'], .post, .article, .content, #content, #main")
      .forEach((el) => candidates.push(el));

    // Fall back to scanning divs/sections if nothing semantic.
    if (candidates.length === 0) {
      document.querySelectorAll("div, section").forEach((el) => {
        if (el.querySelectorAll("p").length >= 3) candidates.push(el);
      });
    }

    let best = null;
    let bestScore = 0;
    candidates.forEach((el) => {
      if (isHidden(el) || looksLikeBoilerplate(el)) return;
      const s = scoreNode(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    });

    return best || document.body;
  }

  function extractText(root) {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (BOILERPLATE.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (isHidden(el)) return NodeFilter.FILTER_REJECT;
        if (looksLikeBoilerplate(el)) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName;
        if (/^(P|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|PRE|TD|FIGCAPTION)$/.test(tag)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });

    const seen = new Set();
    let current = walker.nextNode();
    while (current) {
      const text = (current.innerText || "").trim().replace(/\s+/g, " ");
      if (text.length > 20 && !seen.has(text)) {
        seen.add(text);
        const prefix = /^H[1-6]$/.test(current.tagName) ? "\n## " : "";
        parts.push(prefix + text);
      }
      current = walker.nextNode();
    }
    return parts.join("\n\n");
  }

  function getMeta(name) {
    const el =
      document.querySelector(`meta[property='${name}']`) ||
      document.querySelector(`meta[name='${name}']`);
    return el ? el.getAttribute("content") : null;
  }

  const root = getMainContent();
  let text = extractText(root);
  if (text.length < 200) {
    // extraction too thin — fall back to whole body
    text = extractText(document.body);
  }
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + "\n\n[...content truncated...]";
  }

  return {
    title: document.title || getMeta("og:title") || "Untitled",
    url: location.href,
    siteName: getMeta("og:site_name") || location.hostname,
    description: getMeta("description") || getMeta("og:description") || "",
    text: text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
  };
})();
