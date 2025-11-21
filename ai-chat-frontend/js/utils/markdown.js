// utils/markdown.js
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyInlineFormatting(value) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

export function renderMarkdown(rawText) {
  if (!rawText) return "";

  const lines = String(rawText).split(/\r?\n/);

  let html = "";
  let inList = false;

  // fenced code support
  let inFence = false;
  let fenceLang = "";
  let fenceBuffer = [];

  const flushList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  const flushFence = () => {
    if (!inFence) return;
    const code = fenceBuffer.join("\n");
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : "";
    html += `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
    inFence = false;
    fenceLang = "";
    fenceBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    "); // normalize tabs
    const trimmed = line.trim();

    // fenced code: start or end
    const fenceMatch = trimmed.match(/^```([a-z0-9+\-_.]*)\s*$/i);
    if (fenceMatch) {
      if (inFence) {
        // end fence
        flushFence();
      } else {
        // start fence
        flushList();
        inFence = true;
        fenceLang = fenceMatch[1] || "";
        fenceBuffer = [];
      }
      continue;
    }

    if (inFence) {
      fenceBuffer.push(rawLine); // keep original (do not trim)
      continue;
    }

    // empty line => paragraph break
    if (!trimmed) {
      flushList();
      html += '<div class="message__break"></div>';
      continue;
    }

    // list item
    if (trimmed.startsWith("- ")) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      const content = applyInlineFormatting(escapeHtml(trimmed.slice(2).trim()));
      html += `<li>${content}</li>`;
      continue;
    }

    // normal paragraph
    flushList();
    const content = applyInlineFormatting(escapeHtml(trimmed));
    html += `<p>${content}</p>`;
  }

  // trailing states
  flushFence();
  flushList();
  return html;
}
