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

  // Block-level tags that normally hold real prose.
  const TEXT_TAGS = /^(P|LI|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|PRE|TD|FIGCAPTION)$/;

  // A "text leaf" is an element that carries its own visible text but has no
  // block-level element children — i.e. the actual unit of content. Many web
  // apps render prose into <div>/<span> rather than <p>, so we treat those as
  // text leaves too instead of only counting <p>/<li>/<blockquote>.
  function isTextLeaf(el) {
    const tag = el.tagName;
    if (TEXT_TAGS.test(tag)) return true;
    if (tag !== "DIV" && tag !== "SPAN" && tag !== "ARTICLE" && tag !== "SECTION") return false;
    // Only count it if it doesn't contain another block/text container, so we
    // don't double-count a wrapper plus the elements inside it.
    return !el.querySelector(
      "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, figcaption, div, span, article, section"
    );
  }

  // Score a candidate container by how much real text it holds (prose in
  // p/li/blockquote AND text rendered into leaf div/span nodes).
  function scoreNode(node) {
    let textLen = 0;
    const blocks = node.querySelectorAll(
      "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, figcaption, div, span"
    );
    blocks.forEach((el) => {
      if (isHidden(el) || looksLikeBoilerplate(el)) return;
      if (!isTextLeaf(el)) return;
      const t = (el.innerText || "").trim();
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

  // True if some ancestor (up to root) was already captured as a text unit —
  // used to avoid emitting both a <p> and the <span>s nested inside it.
  function hasCapturedAncestor(el, root) {
    let p = el.parentElement;
    while (p && p !== root) {
      if (TEXT_TAGS.test(p.tagName)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function extractText(root) {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (BOILERPLATE.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (isHidden(el)) return NodeFilter.FILTER_REJECT;
        if (looksLikeBoilerplate(el)) return NodeFilter.FILTER_REJECT;
        // Accept real block text AND text-leaf div/span (app-rendered content).
        // isTextLeaf() guarantees a div/span has no block children; the ancestor
        // check stops a <p>'s inner <span>s from being emitted a second time.
        if (isTextLeaf(el) && !hasCapturedAncestor(el, root)) {
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
