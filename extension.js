'use strict';

const vscode = require('vscode');
const path   = require('path');
const http   = require('http');

// ─────────────────────────────────────────────────────────────────────────────
//  Local HTTP server for embedded video playback (YouTube / Vimeo)
//  VS Code webviews are sandboxed, so YouTube blocks iframe playback.
//  Serving the embed page from localhost gives it a real HTTP origin.
// ─────────────────────────────────────────────────────────────────────────────
let videoServer = null;
let videoServerPort = 0;

function startVideoServer() {
  if (videoServer) return Promise.resolve(videoServerPort);
  return new Promise((resolve, reject) => {
    videoServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const parts = url.pathname.split('/').filter(Boolean);
      // /yt/<videoId>  or  /vimeo/<videoId>
      if (parts.length === 2 && /^[a-zA-Z0-9_-]+$/.test(parts[1])) {
        const id = parts[1];
        let embedHtml = '';
        if (parts[0] === 'yt') {
          embedHtml = `<iframe src="https://www.youtube.com/embed/${id}" ` +
            `style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" ` +
            `frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" ` +
            `allowfullscreen></iframe>`;
        } else if (parts[0] === 'vimeo') {
          embedHtml = `<iframe src="https://player.vimeo.com/video/${id}" ` +
            `style="position:absolute;top:0;left:0;width:100%;height:100%;border:none;" ` +
            `frameborder="0" allow="autoplay;fullscreen;picture-in-picture" ` +
            `allowfullscreen></iframe>`;
        }
        if (embedHtml) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">` +
            `<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}` +
            `.wrap{position:relative;width:100%;height:100%}</style></head>` +
            `<body><div class="wrap">${embedHtml}</div></body></html>`);
          return;
        }
      }
      res.writeHead(404);
      res.end('Not found');
    });
    videoServer.listen(0, '127.0.0.1', () => {
      videoServerPort = videoServer.address().port;
      resolve(videoServerPort);
    });
    videoServer.on('error', reject);
  });
}

function stopVideoServer() {
  if (videoServer) { videoServer.close(); videoServer = null; videoServerPort = 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  markdown-it
// ─────────────────────────────────────────────────────────────────────────────
const MarkdownIt = require('markdown-it');
const attrs      = require('markdown-it-attrs');

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
  .use(attrs, {
    leftDelimiter:     '{',      // MkDocs attr_list uses plain { not {:
    rightDelimiter:    '}',
    allowedAttributes: ['style','class','id','width','height','align',
                        'title','alt', /^data-.*/, /^aria-.*/],
  });

// Stamp data-line="N" on every opening block token that has source map info.
// This lets the webview scroll to the element matching the editor cursor line.
const _renderToken = md.renderer.renderToken.bind(md.renderer);
md.renderer.renderToken = function(tokens, idx, options) {
  const token = tokens[idx];
  if (token.nesting === 1 && token.map && token.map[0] >= 0) {
    token.attrSet('data-line', String(token.map[0]));
  }
  return _renderToken(tokens, idx, options);
};

// fence and code_block use custom rules that bypass renderToken — patch them too.
const _fence = md.renderer.rules.fence;
md.renderer.rules.fence = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const info  = (token.info || '').trim().toLowerCase();
  const line  = token.map ? token.map[0] : null;

  // Mermaid diagrams — render as a plain <div class="mermaid"> so that
  // the Mermaid library can replace it with an SVG at runtime.
  if (info === 'mermaid') {
    const dataLine = line !== null ? ` data-line="${line}"` : '';
    return `<div class="mermaid"${dataLine}>${escHtml(token.content)}</div>\n`;
  }

  let html = (_fence || self.renderToken.bind(self))(tokens, idx, options, env, self);
  if (line !== null) html = html.replace(/^<pre/, `<pre data-line="${line}"`);
  return html;
};

const _codeBlock = md.renderer.rules.code_block;
md.renderer.rules.code_block = function(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const line  = token.map ? token.map[0] : null;
  let html    = (_codeBlock || self.renderToken.bind(self))(tokens, idx, options, env, self);
  if (line !== null) html = html.replace(/^<pre/, `<pre data-line="${line}"`);
  return html;
};

// markdown-it's typographer converts "--" → "–" (en-dash) BEFORE attrs runs,
// which breaks class names like .md-button--primary.
// Pre-protect all { ... } attribute blocks by temporarily replacing "--" inside
// them with a safe placeholder, then restoring after render.
const DASH_PLACEHOLDER = 'DDASH';

function protectAttrDashes(text) {
  // Replace -- inside every { ... } span (non-greedy, single line)
  return text.replace(/\{[^}]*\}/g, m => m.replace(/--/g, DASH_PLACEHOLDER));
}

function restoreAttrDashes(html) {
  return html.replace(new RegExp(DASH_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '--');
}

// ─────────────────────────────────────────────────────────────────────────────
//  YAML front-matter
// ─────────────────────────────────────────────────────────────────────────────
function parseFrontmatter(text) {
  const trimmed = text.replace(/^\s*/, '');
  const m = trimmed.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { props: null, body: text, fmLines: 0 };
  const leading = text.length - trimmed.length;
  const fmLines = (text.slice(0, leading + m[0].length).match(/\n/g) || []).length;
  const body  = trimmed.slice(m[0].length);
  const props = Object.create(null);
  let   lastKey = null;

  for (const line of m[1].split(/\r?\n/)) {
    // list item under the previous key:  "  - value"
    const li = line.match(/^[ \t]+-[ \t]+(.+)$/);
    if (li && lastKey) {
      if (!Array.isArray(props[lastKey])) props[lastKey] = [];
      props[lastKey].push(li[1].trim());
      continue;
    }
    // key: value  (value may be empty for a list-only key)
    const kv = line.match(/^([\w\u0080-\uFFFF][\w\u0080-\uFFFF-]*):\s*(.*)$/);
    if (!kv) continue;
    lastKey = kv[1];
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    props[lastKey] = val === '' ? [] : val;
  }

  for (const k of Object.keys(props))
    if (Array.isArray(props[k]) && props[k].length === 0) props[k] = '';

  return { props: Object.keys(props).length ? props : null, body, fmLines };
}

function renderFrontmatter(props) {
  if (!props) return '';
  const rows = Object.entries(props).map(([k, v]) => {
    let cell;
    if (Array.isArray(v)) {
      const pills = v.map(item =>
        `<span class="fm-pill">${escHtml(item)}</span>`
      ).join('');
      cell = `<td class="fm-pills">${pills}</td>`;
    } else {
      cell = `<td>${escHtml(v)}</td>`;
    }
    return `<tr><td class="fm-key">${escHtml(k)}</td>${cell}</tr>`;
  }).join('');
  return `<div class="fm-block"><table class="fm-table"><tbody>${rows}</tbody></table></div>\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tab group pre-processor  (MkDocs === "Label" syntax)
//
//  Syntax:
//    === "Tab A"
//
//        content indented 4 spaces
//
//    === "Tab B"
//
//        more content
//
//  Adjacent === blocks are collapsed into a single <div class="tab-group">.
//  Content lines must be indented 4 spaces (one level); the indentation is
//  stripped before being passed back through markdown-it.
// ─────────────────────────────────────────────────────────────────────────────
let _tabGroupId = 0;

function parseTabs(text, fmOffset) {
  fmOffset = fmOffset || 0;
  const lines  = text.split(/\n/);
  const out    = [];
  let   i      = 0;
  let   inFence = false;

  while (i < lines.length) {
    const line = lines[i];

    // Track fenced code blocks — don't parse tabs inside them
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) { out.push(line); i++; continue; }

    // Detect start of a tab group: line matches === "Label"
    if (/^===[ \t]+"[^"]+"/.test(line)) {
      const startI  = i;   // remember start for line-count and data-line
      const groupId = `tab-group-${++_tabGroupId}`;
      const tabs    = [];   // [{ label, bodyLines }]

      // Consume consecutive === blocks
      while (i < lines.length && /^===[ \t]+"([^"]+)"/.test(lines[i])) {
        const tabLine    = i;   // source line of this === header (for revealLine sync)
        const labelMatch = lines[i].match(/^===[ \t]+"([^"]+)"/);
        const label      = labelMatch[1];
        i++;

        // Collect body lines (4-space indented or blank)
        const bodyLines = [];
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.startsWith('    ') || bl.trim() === '') {
            bodyLines.push(bl.startsWith('    ') ? bl.slice(4) : bl);
            i++;
          } else {
            break;
          }
        }
        // Count trailing blank lines but do NOT rewind i here —
        // rewinding inside the per-tab loop would prevent the outer while
        // from seeing the next === header (it needs to step over that blank).
        // We store the count and rewind once after all tabs are collected.
        let trailingBlanks = 0;
        while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
          bodyLines.pop();
          trailingBlanks++;
        }
        tabs.push({ label, bodyLines, tabLine, trailingBlanks });
      }

      if (tabs.length === 0) continue;

      // Rewind i by the trailing blank lines that the LAST tab's body collector
      // consumed but discarded.  Those blanks belong to the outer document
      // (they separate the tab group from whatever follows, e.g. ## Task lists),
      // so they must stay outside the group's line-count.
      i -= tabs[tabs.length - 1].trailingBlanks;

      // Build HTML for the tab group
      const safeGroupId = escHtml(groupId);
      const btnHtml = tabs.map((t, idx) => {
        const active  = idx === 0 ? ' active' : '';
        const tabId   = `${groupId}-${idx}`;
        // data-line lets revealLine know which editor line this tab header is on
        return `<button class="tab-btn${active}" data-tab="${escHtml(tabId)}" data-line="${t.tabLine}">${escHtml(t.label)}</button>`;
      }).join('');

      const panelHtml = tabs.map((t, idx) => {
        const hidden  = idx === 0 ? '' : ' hidden';
        const tabId   = `${groupId}-${idx}`;
        // Recurse: inner content may itself contain admonitions / tabs.
        // Strip inner data-line attrs — inner source maps are local and would
        // be wrong after the global fmOffset is applied in renderDoc.
        const rawInner  = restoreAttrDashes(md.render(parseTabs(protectAttrDashes(t.bodyLines.join('\n')))));
        const cleanInner = rawInner.replace(/\s*data-line="\d+"/g, '');
        return `<div class="tab-panel${hidden}" id="${escHtml(tabId)}">${cleanInner}</div>`;
      }).join('');

      // Stamp data-line / data-line-end with body-relative lines (renderDoc will add fmOffset).
      // data-line-end lets revealLine skip this element once the cursor moves past it.
      out.push(
        `<div class="tab-group" data-line="${startI}" data-line-end="${i - 1}" id="${safeGroupId}">` +
        `<div class="tab-bar">${btnHtml}</div>` +
        `<div class="tab-panels">${panelHtml}</div>` +
        `</div>`
      );
      // Emit filler lines to keep total line count identical to the original,
      // so markdown-it source maps stay aligned with the file.
      // IMPORTANT: a type-6 HTML block (<div>) ends only at a blank line.
      // We must emit one blank line first to close it, then <!-- --> comments
      // for the remaining slots (each <!-- --> is a self-contained type-2 block).
      const linesConsumed = i - startI;
      if (linesConsumed > 1) {
        out.push('');                                          // terminates the <div> block
        for (let f = 2; f < linesConsumed; f++) out.push('<!-- -->');
      }
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Admonition pre-processor  (!!! type "title")
//
//  Handles MkDocs / Material-style admonitions before markdown-it runs.
//  Supports all 12 standard types with optional custom title.
//  Body lines must be indented with 4 spaces (or 1 tab).
// ─────────────────────────────────────────────────────────────────────────────
const ADMONITION_TYPES = {
  note:      { icon: '📝' },
  abstract:  { icon: '📋' }, summary:  { icon: '📋' }, tldr: { icon: '📋' },
  info:      { icon: 'ℹ️'  }, todo:     { icon: 'ℹ️'  },
  tip:       { icon: '🔥' }, hint:     { icon: '🔥' }, important: { icon: '🔥' },
  success:   { icon: '✅' }, check:    { icon: '✅' }, done: { icon: '✅' },
  question:  { icon: '❓' }, help:     { icon: '❓' }, faq:  { icon: '❓' },
  warning:   { icon: '⚠️' }, caution:  { icon: '⚠️' }, attention: { icon: '⚠️' },
  failure:   { icon: '❌' }, fail:     { icon: '❌' }, missing: { icon: '❌' },
  danger:    { icon: '⚡' }, error:    { icon: '⚡' },
  bug:       { icon: '🐛' },
  example:   { icon: '🔬' },
  quote:     { icon: '💬' }, cite: { icon: '💬' },
};

// Regex covers all variants:
//   !!!  type
//   !!!  type "Title"
//   !!!  type ""           ← no-title
//   !!!  type inline
//   !!!  type inline end
//   ???  type              ← collapsible closed
//   ???+ type              ← collapsible open
const ADM_RE = /^(\s*)(?::[ \t]+)?(!!!|\?\?\?[+]?)\s+(\w+)((?:\s+(?:inline(?:\s+end)?))*)(?:\s+"([^"]*)")?\s*$/;

function parseAdmonitions(text) {
  const lines   = text.split(/\n/);
  const out     = [];
  let   i       = 0;
  let   inFence = false;   // true while inside a ``` or ~~~ code fence

  while (i < lines.length) {
    const line = lines[i];

    // Track fenced code blocks — toggle on opening/closing fence
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }

    // Inside a code fence — pass through verbatim, no admonition parsing
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    const m = line.match(ADM_RE);

    if (m) {
      const startI     = i;              // remember for data-line and filler count
      const baseIndent = m[1];          // leading whitespace of the !!! line
      const trigger    = m[2];          // !!! / ??? / ???+
      const typeKey    = m[3].toLowerCase();
      const modifiers  = (m[4] || '').trim().toLowerCase();
      // m[5]: title string (undefined = auto, '' = no title, 'text' = custom)
      const titleRaw   = m[5];

      const def        = ADMONITION_TYPES[typeKey];
      const icon       = def ? def.icon : '📌';
      const autoTitle  = typeKey.charAt(0).toUpperCase() + typeKey.slice(1);

      const isCollapsible = trigger.startsWith('???');
      const isOpen        = trigger === '???+';
      const isInlineEnd   = modifiers.includes('inline end');
      const isInline      = !isInlineEnd && modifiers.includes('inline');
      const noTitle       = titleRaw === '';
      const titleText     = noTitle ? '' : (titleRaw !== undefined ? titleRaw : autoTitle);

      const childPrefix = baseIndent + '    ';
      i++;

      // Collect body lines.
      // Primary: lines indented one level deeper than the !!! header.
      // Fallback: if the very first body line has NO indent (author omitted it),
      //           collect consecutive non-blank lines as the body instead.
      const bodyLines = [];
      const firstBody = i < lines.length ? lines[i] : null;
      const useLooseMode = firstBody !== null
        && firstBody.trim() !== ''
        && !firstBody.startsWith(childPrefix)
        && !firstBody.match(ADM_RE);  // not a sibling admonition

      while (i < lines.length) {
        const bl = lines[i];
        if (useLooseMode) {
          // Loose mode: collect until blank line or new !!! / ??? block
          if (bl.trim() === '' || bl.match(ADM_RE)) break;
          bodyLines.push(bl);
          i++;
        } else {
          // Strict mode: require 4-space indent (standard MkDocs format)
          if (bl.startsWith(childPrefix) || bl.trim() === '') {
            bodyLines.push(bl);
            i++;
          } else {
            break;
          }
        }
      }
      // Trim trailing blank lines
      while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();

      // Strip one level of indent, recurse for nested admonitions.
      // Strip inner data-line attrs — inner source maps are local and would
      // be wrong after the global fmOffset is applied in renderDoc.
      const stripped   = bodyLines.map(l => l.startsWith(childPrefix) ? l.slice(childPrefix.length) : l).join('\n');
      const rawInner   = restoreAttrDashes(md.render(parseAdmonitions(protectAttrDashes(stripped))));
      const innerHtml  = rawInner.replace(/\s*data-line="\d+"/g, '');

      // Build class list
      const classes = ['admonition', `admonition-${escHtml(typeKey)}`];
      if (isInlineEnd) classes.push('admonition-inline-end');
      else if (isInline) classes.push('admonition-inline');

      const titleHtml = noTitle ? '' :
        `<div class="admonition-title"><span class="admonition-icon">${icon}</span>${escHtml(titleText)}</div>`;

      // Stamp data-line with body-relative start line (renderDoc will add fmOffset)
      if (isCollapsible) {
        out.push(
          `<details class="${classes.join(' ')}" data-line="${startI}"${isOpen ? ' open' : ''}>` +
          `<summary class="admonition-title"><span class="admonition-icon">${icon}</span>${escHtml(titleText || autoTitle)}</summary>` +
          `<div class="admonition-body">${innerHtml}</div>` +
          `</details>`
        );
      } else {
        out.push(
          `<div class="${classes.join(' ')}" data-line="${startI}">` +
          titleHtml +
          `<div class="admonition-body">${innerHtml}</div>` +
          `</div>`
        );
      }
      // Emit filler lines to keep total line count identical to the original.
      // Blank line first to terminate the <div>/<details> type-6 HTML block,
      // then <!-- --> comments for remaining slots.
      const linesConsumed = i - startI;
      if (linesConsumed > 1) {
        out.push('');
        for (let f = 2; f < linesConsumed; f++) out.push('<!-- -->');
      }
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  YouTube iframe  →  inline embed via local server
// ─────────────────────────────────────────────────────────────────────────────
const YT_IFRAME_RE = /<iframe[^>]+src="(https?:\/\/(?:www\.)?(?:youtube\.com|youtube-nocookie\.com)\/embed\/([a-zA-Z0-9_-]+)[^"]*)"[^>]*(?:width="([^"]*)")?[^>]*(?:height="([^"]*)")?[^>]*>.*?<\/iframe>/gis;

function youtubeIdFromUrl(src) {
  const m = src.match(/\/embed\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function patchYoutubeIframes(html) {
  if (!videoServerPort) return html;   // server not ready – leave unchanged
  return html.replace(YT_IFRAME_RE, (match, src, id, w, h) => {
    const videoId = youtubeIdFromUrl(src) || id;
    if (!videoId) return match;
    const width  = w || '560';
    const height = h || '315';
    const widthStyle  = isNaN(width)  ? width  : width + 'px';
    const heightStyle = isNaN(height) ? height : height + 'px';
    const localSrc = `http://127.0.0.1:${videoServerPort}/yt/${videoId}`;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    return `
<div class="video-wrap" style="width:${widthStyle}; max-width:100%; margin:12px 0;">
  <iframe src="${escHtml(localSrc)}"
          style="width:100%; height:${heightStyle}; border:none; border-radius:8px;"
          frameborder="0" allow="fullscreen" allowfullscreen></iframe>
  <div class="video-controls">
    <button class="video-fs-btn" title="Maximize">⛶</button>
  </div>
</div>`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Vimeo iframe  →  inline embed via local server
// ─────────────────────────────────────────────────────────────────────────────
const VIMEO_IFRAME_RE = /<iframe[^>]+src="(https?:\/\/player\.vimeo\.com\/video\/(\d+)[^"]*)"[^>]*(?:width="([^"]*)")?[^>]*(?:height="([^"]*)")?[^>]*>.*?<\/iframe>/gis;

function patchVimeoIframes(html) {
  if (!videoServerPort) return html;   // server not ready – leave unchanged
  return html.replace(VIMEO_IFRAME_RE, (match, src, id, w) => {
    if (!id) return match;
    const width  = w || '560';
    const height = '315';
    const widthStyle  = isNaN(width)  ? width  : width + 'px';
    const localSrc = `http://127.0.0.1:${videoServerPort}/vimeo/${id}`;
    const watchUrl = `https://vimeo.com/${id}`;
    return `
<div class="video-wrap" style="width:${widthStyle}; max-width:100%; margin:12px 0;">
  <iframe src="${escHtml(localSrc)}"
          style="width:100%; height:${height}px; border:none; border-radius:8px;"
          frameborder="0" allow="fullscreen" allowfullscreen></iframe>
  <div class="video-controls">
    <button class="video-fs-btn" title="Maximize">⛶</button>
  </div>
</div>`;
  });
}
// ─────────────────────────────────────────────────────────────────────────────
function rewriteLocalImages(html, docPath, webview) {
  const docDir = path.dirname(docPath);

  function rewriteSrc(match, pre, q, src) {
    if (/^(?:https?|data|vscode-resource|vscode-webview-resource):/.test(src)) return match;
    try {
      const decoded = decodeURIComponent(src);
      const abs = path.resolve(docDir, decoded);
      const uri = webview.asWebviewUri(vscode.Uri.file(abs));
      return `${pre}${q}${uri.toString()}${q}`;
    } catch { return match; }
  }

  // rewrite src on <img>, <video>, <audio>, <source>
  return html.replace(/(<(?:img|video|audio|source)\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, rewriteSrc);
}

// ─────────────────────────────────────────────────────────────────────────────
//  md-button post-processor
//
//  markdown-it-attrs already attaches class="md-button md-button--primary"
//  onto <a> tags.  This pass stamps data-md-btn="1" and, for relative .md
//  links, resolves the absolute fsPath into data-md-path so the webview JS
//  can ask the extension to open the file in VS Code.
// ─────────────────────────────────────────────────────────────────────────────
function rewriteMdButtons(html, docPath) {
  return html.replace(
    /(<a\b([^>]*)>)([\s\S]*?)<\/a>/gi,
    (match, openTag, attrStr, inner) => {
      if (!/\bmd-button\b/.test(attrStr)) return match;

      const hrefM = attrStr.match(/\bhref=(["'])([^"']*)\1/i);
      const href  = hrefM ? hrefM[2] : '';

      let mdPath = '';
      if (href && !/^(?:https?|mailto|vscode):/.test(href)) {
        try { mdPath = path.resolve(path.dirname(docPath), decodeURIComponent(href.split(/[#?]/)[0])); } catch {}
      }

      const extra = ` data-md-btn="1"` +
        (mdPath                ? ` data-md-path="${escHtml(mdPath)}"` : '') +
        (/^https?:/.test(href) ? ` data-md-url="${escHtml(href)}"`   : '');
      return `<a${attrStr}${extra}>${inner}</a>`;
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Plain-link .md rewriter
//
//  Stamps data-md-path on every <a href="relative/path.md"> that was NOT
//  already handled by rewriteMdButtons (i.e. has no data-md-btn attribute).
//  The webview click handler then intercepts these to open the file in VS Code
//  instead of following the href (which would be a dead link inside a webview).
// ─────────────────────────────────────────────────────────────────────────────
function rewriteMdLinks(html, docPath) {
  return html.replace(
    /(<a\b([^>]*)>)([\s\S]*?)<\/a>/gi,
    (match, openTag, attrStr, inner) => {
      // Already stamped by rewriteMdButtons — leave alone
      if (/\bdata-md-btn\b/.test(attrStr)) return match;

      const hrefM = attrStr.match(/\bhref=(["'])([^"']*)\1/i);
      const href  = hrefM ? hrefM[2] : '';

      // Only intercept relative links whose path component ends with .md
      if (!href) return match;
      if (/^https?:/.test(href)) {
        const newAttr = attrStr.replace(/\bhref=(["'])[^"']*\1/i, 'href="#"');
        return `<a${newAttr} data-md-url="${escHtml(href)}">${inner}</a>`;
      }
      if (/^(?:mailto|vscode|#)/.test(href)) return match;

      try {
        // Strip any fragment/query before resolving the fs path
        // Decode URL-encoded characters (markdown-it encodes spaces etc.)
        const filePart = decodeURIComponent(href.split(/[#?]/)[0]);
        const resolved = path.resolve(path.dirname(docPath), filePart);
        if (/\.md(?:[#?]|$)/i.test(href)) {
          return `<a${attrStr} data-md-path="${escHtml(resolved)}">${inner}</a>`;
        }
        // Non-.md relative links (PDFs, images, etc.) — open in VS Code panel
        // Replace href with "#" and strip download attr so the webview doesn't
        // intercept the click before JS runs.
        let cleanAttr = attrStr.replace(/\bhref=(["'])[^"']*\1/i, 'href="#"');
        cleanAttr = cleanAttr.replace(/\s*\bdownload\b(?:=(["'])[^"']*\1)?/gi, '');
        return `<a${cleanAttr} data-file-path="${escHtml(resolved)}">${inner}</a>`;
      } catch {
        return match;
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Heading ID stamper
//
//  Adds id="slug" to every <h1>–<h6> that doesn't already have one so that
//  TOC anchor links like [Section](#section) can scroll to the target.
//  Duplicate slugs get a numeric suffix (-1, -2, …).
// ─────────────────────────────────────────────────────────────────────────────
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')          // strip any inner tags
    .replace(/[^\w\s-]/g, '')         // remove punctuation
    .trim()
    .replace(/[\s]+/g, '-');          // spaces → hyphens
}

function addHeadingIds(html) {
  const counts = Object.create(null);
  return html.replace(/(<h([1-6])(\b[^>]*)>)([\s\S]*?)<\/h[1-6]>/gi,
    (match, openTag, level, attrs, inner) => {
      if (/\bid=/.test(attrs)) return match;   // already has id
      let slug = slugifyHeading(inner);
      if (!slug) return match;
      if (counts[slug] !== undefined) {
        counts[slug]++;
        slug += '-' + counts[slug];
      } else {
        counts[slug] = 0;
      }
      return `<h${level}${attrs} id="${slug}">${inner}</h${level}>`;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Task-list post-processor  (PyMdown tasklist-compatible)
//
//  markdown-it renders "- [x] text" as "<li>[x] text</li>".
//  This pass:
//    1. Replaces the bracketed marker with a <label class="task-list-indicator">
//       wrapping an <input type="checkbox">, and stamps "task-list-item" /
//       "task-list-item-checked" on the <li>.
//    2. Stamps class="task-list" on any <ul>/<ol> whose first direct <li> is
//       already a task-list-item (markdown-it produces homogeneous lists).
//
//  Output mirrors the PyMdown Extensions tasklist HTML spec:
//    https://facelessuser.github.io/pymdown-extensions/extensions/tasklist/
// ─────────────────────────────────────────────────────────────────────────────
function patchTaskLists(html) {
  // Heroicons-style SVGs (MIT licence, inline)
  // Unchecked: rounded square outline
  const SVG_UNCHECKED =
    `<svg class="task-checkbox" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="1.5" y="1.5" width="13" height="13" rx="2.5" stroke="#4c566a" stroke-width="1.5"/>` +
    `</svg>`;
  // Checked: filled teal square + white tick path (Heroicons check style)
  const SVG_CHECKED =
    `<svg class="task-checkbox task-checkbox-checked" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0.5" y="0.5" width="15" height="15" rx="3" fill="#5e81ac" stroke="#5e81ac"/>` +
    `<path d="M4 8.5l2.5 2.5 5.5-5.5" stroke="#eceff4" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`;

  html = html.replace(
    /<li([^>]*)>([\s]*)(<p[^>]*>)?\[([ xX])\] /g,
    (_, attrs, space, p, mark) => {
      const checked = mark.toLowerCase() === 'x';
      const cls     = checked ? 'task-list-item task-list-item-checked' : 'task-list-item';
      const svg     = checked ? SVG_CHECKED : SVG_UNCHECKED;
      return `<li${attrs} class="${cls}">${space}${p || ''}${svg} `;
    }
  );

  // Wrap inline text in a span for strikethrough targeting
  html = html.replace(
    /(<\/svg>) ([^<\n]+)/g,
    (_, close, text) => `${close} <span class="task-list-text">${text}</span>`
  );

  // Stamp class="task-list" on parent <ul>/<ol>
  html = html.replace(
    /<(ul|ol)([^>]*)>(\s*<li [^>]*class="task-list-item)/g,
    '<$1$2 class="task-list">$3'
  );

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Math pre-processor  ($...$ / $$...$$ / \(...\) / \[...\])
//
//  Converts math spans into HTML placeholders BEFORE markdown-it runs so
//  that underscores, asterisks and backslashes inside LaTeX are never
//  processed as Markdown syntax.
//
//  Supported syntaxes (arithmatex-compatible):
//    $$...$$          block  (may be multi-line)
//    $...$            inline (single line only, no space at inner edges)
//    \[...\]          block
//    \(...\)          inline
// ─────────────────────────────────────────────────────────────────────────────
function parseMath(text) {
  // IMPORTANT: We store the raw LaTeX in a data-latex attribute and leave the
  // element body EMPTY.  If we put LaTeX text inside a <span>, markdown-it
  // re-parses the content with its inline engine and markdown-it-attrs consumes
  // every {…} group (e.g. \frac{a}{b}) as an attribute block, destroying the
  // expression.  An empty body with data-latex is opaque to markdown-it.

  // ── block: $$ ... $$ (multi-line) ─────────────────────────────────────────
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) =>
    `<div class="math-block" data-latex="${escHtml(tex.trim())}"></div>`
  );

  // ── block: \[ ... \] (multi-line) ─────────────────────────────────────────
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) =>
    `<div class="math-block" data-latex="${escHtml(tex.trim())}"></div>`
  );

  // ── inline: \( ... \) ─────────────────────────────────────────────────────
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, tex) =>
    `<span class="math-inline" data-latex="${escHtml(tex.trim())}"></span>`
  );

  // ── inline: $...$ — single line, must not start/end with a space ──────────
  text = text.replace(/(?<!\$)\$(?!\$)([^\n$]+?)(?<!\s)\$(?!\$)/g, (_, tex) =>
    `<span class="math-inline" data-latex="${escHtml(tex.trim())}"></span>`
  );

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Combined doc renderer
// ─────────────────────────────────────────────────────────────────────────────
function renderDoc(docText, docPath, webview) {
  _tabGroupId = 0;
  const { props, body, fmLines } = parseFrontmatter(docText);
  const withTabs   = parseTabs(body);
  const withMath   = parseMath(withTabs);
  const processed  = parseAdmonitions(withMath);

  // md.render source maps are 0-based from body start.
  // Shift all data-line values by fmLines to align with original file line numbers.
  const rendered  = restoreAttrDashes(md.render(protectAttrDashes(processed)));
  const shifted   = fmLines > 0
    ? rendered.replace(/\bdata-line(-end)?="(\d+)"/g, (_, suf, n) => `data-line${suf || ''}="${+n + fmLines}"`)
    : rendered;

  const raw        = renderFrontmatter(props) + patchTaskLists(patchVimeoIframes(patchYoutubeIframes(shifted)));
  const withImages  = rewriteLocalImages(raw, docPath, webview);
  const withButtons = rewriteMdButtons(withImages, docPath);
  const withLinks   = rewriteMdLinks(withButtons, docPath);
  return addHeadingIds(withLinks);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Local resource roots
// ─────────────────────────────────────────────────────────────────────────────
function getLocalRoots(extUri, docPath) {
  const roots = [extUri];
  if (!docPath) return roots;

  // Always include the doc dir and walk up 4 levels so that relative paths
  // like ../../_sources/ are always within an allowed root.
  let dir = path.dirname(docPath);
  for (let i = 0; i < 4; i++) {
    roots.push(vscode.Uri.file(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;   // reached filesystem root
    dir = parent;
  }

  // Also include workspace folders
  for (const wf of (vscode.workspace.workspaceFolders || [])) roots.push(wf.uri);

  return roots;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML builder
// ─────────────────────────────────────────────────────────────────────────────
function buildHtml({ body, webview, extUri, filename = '', savedTheme = 'dark', savedColors = null }) {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'markdown.css'));
  const csp = [
    `default-src 'none'`,
    `style-src  ${webview.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com`,
    `img-src    ${webview.cspSource} https://img.youtube.com https://i.ytimg.com https://vumbnail.com https: data: blob:`,
    `frame-src  http://127.0.0.1:* https://player.vimeo.com https://codepen.io https:`,
    `media-src  ${webview.cspSource} https: blob:`,
    `font-src   https://cdnjs.cloudflare.com https: data:`,
    `script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/atom-one-dark.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: #1e2128; color: #a8cbaf;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Noto Sans CJK KR", "Noto Sans KR", "NanumGothic", sans-serif;
      font-size: 15px; line-height: 1.7; height: 100%;
    }
    body.nm-light, html:has(body.nm-light) { background: #ffffff; color: #2e3440; }
    .nm-toolbar {
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
      background: #22272f; border-bottom: 1px solid #3b4252;
      padding: 4px 12px; gap: 8px;
      transition: transform .25s ease, opacity .25s ease;
    }
    .nm-toolbar.nm-toolbar-hidden {
      transform: translateY(-100%); opacity: 0; pointer-events: none;
    }
    .nm-toolbar.nm-toolbar-pinned {
      position: fixed; left: 0; right: 0;
    }
    body.nm-pinned .vscode-body { padding-top: 68px; }
    .nm-toolbar-hover-zone {
      position: fixed; top: 0; left: 0; right: 0; height: 8px; z-index: 99;
    }
    .nm-toolbar-nav { display: flex; gap: 2px; }
    .nm-btn:disabled { opacity: .3; cursor: default; }
    .nm-btn:disabled:hover { background: transparent; }
    .nm-filename { font-size: 12px; color: #81a1c1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .nm-toolbar-actions { display: flex; gap: 2px; align-items: center; }
    .nm-zoom-level {
      font-size: 11px; color: #81a1c1; min-width: 36px; text-align: center;
      cursor: pointer; user-select: none; line-height: 30px;
    }
    .nm-zoom-level:hover { color: #88c0d0; }
    /* ── Settings modal ────────────────────────────────────── */
    .nm-settings-overlay {
      display: none; position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,.5); align-items: center; justify-content: center;
    }
    .nm-settings-overlay.open { display: flex; }
    .nm-settings-panel {
      background: #2e3440; border: 1px solid #3b4252; border-radius: 10px;
      padding: 24px 28px; min-width: 380px; max-width: 460px; width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,.5); color: #d8dee9;
      max-height: 80vh; overflow-y: auto;
    }
    .nm-settings-panel h3 { margin: 0 0 16px; font-size: 15px; color: #88c0d0; }
    .nm-settings-section { margin-bottom: 18px; }
    .nm-settings-section h4 {
      margin: 0 0 10px; font-size: 13px; color: #81a1c1; text-transform: uppercase;
      letter-spacing: .5px; border-bottom: 1px solid #3b4252; padding-bottom: 6px;
    }
    .nm-color-row {
      display: flex; align-items: center; justify-content: space-between;
      margin: 6px 0; font-size: 13px;
    }
    .nm-color-row label { flex: 1; color: #d8dee9; }
    .nm-color-row input[type="color"] {
      width: 36px; height: 26px; border: 1px solid #4c566a; border-radius: 4px;
      background: transparent; cursor: pointer; padding: 1px;
    }
    .nm-settings-btns {
      display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;
      border-top: 1px solid #3b4252; padding-top: 14px;
    }
    .nm-settings-btns button {
      border: none; border-radius: 6px; padding: 6px 16px; font-size: 12px;
      cursor: pointer; font-family: inherit;
    }
    .nm-sbtn-reset { background: #3b4252; color: #d8dee9; }
    .nm-sbtn-reset:hover { background: #434c5e; }
    .nm-sbtn-close { background: #5e81ac; color: #eceff4; }
    .nm-sbtn-close:hover { background: #81a1c1; }
    body.nm-light .nm-settings-panel {
      background: #f0f2f8; border-color: #c8cdd8; color: #2e3440;
      box-shadow: 0 8px 32px rgba(0,0,0,.15);
    }
    body.nm-light .nm-settings-panel h3 { color: #5e81ac; }
    body.nm-light .nm-settings-section h4 { color: #4c6a9c; border-bottom-color: #c8cdd8; }
    body.nm-light .nm-color-row label { color: #2e3440; }
    body.nm-light .nm-color-row input[type="color"] { border-color: #b0b8cc; }
    body.nm-light .nm-settings-btns { border-top-color: #c8cdd8; }
    body.nm-light .nm-sbtn-reset { background: #dde2ee; color: #2e3440; }
    body.nm-light .nm-sbtn-reset:hover { background: #c8cdd8; }
    .nm-btn {
      background: transparent; border: none; color: #a8cbaf;
      border-radius: 6px; padding: 0; width: 30px; height: 30px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .15s;
    }
    .nm-btn:hover { background: rgba(255,255,255,.1); }
    .nm-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .nm-btn-pin { color: #616e88; }
    .nm-btn-pin.pinned { color: #88c0d0; }
    .nm-export-wrap { position: relative; }
    .nm-export-menu {
      display: none; position: absolute; top: 100%; right: 0; z-index: 200;
      background: #2e3440; border: 1px solid #3b4252; border-radius: 6px;
      padding: 4px 0; min-width: 130px; box-shadow: 0 4px 16px rgba(0,0,0,.35);
      margin-top: 4px;
    }
    .nm-export-menu.open { display: block; }
    .nm-export-menu button {
      display: flex; align-items: center; gap: 8px; width: 100%;
      background: transparent; border: none; color: #a8cbaf;
      padding: 6px 14px; font-size: 12px; cursor: pointer; white-space: nowrap;
    }
    .nm-export-menu button:hover { background: rgba(255,255,255,.08); }
    .nm-export-menu button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    body.nm-light .nm-export-menu { background: #e8eaf0; border-color: #c8cdd8; box-shadow: 0 4px 16px rgba(0,0,0,.1); }
    body.nm-light .nm-export-menu button { color: #2e3440; }
    body.nm-light .nm-export-menu button:hover { background: rgba(0,0,0,.06); }
    .vscode-body { max-width: 900px; margin: 0 auto; padding: 28px 40px 80px; word-break: keep-all; overflow-wrap: break-word; }
    img         { max-width: 100%; height: auto; }
    iframe      { max-width: 100%; border: none; display: block; border-radius: 6px; }
    video       { max-width: 100%; border-radius: 6px; }
    details     { border: 1px solid #3b4252; border-radius: 4px; padding: 8px 12px; }
    summary     { cursor: pointer; color: #81a1c1; font-weight: 600; }
    blockquote  { background: transparent !important; }
    .admonition-body p  { margin: 4px 0 !important; }
    .admonition-body > *:first-child { margin-top: 0 !important; }
    .admonition-body > *:last-child  { margin-bottom: 0 !important; }
    :target     { outline: 2px solid #5e81ac; outline-offset: 4px; border-radius: 3px; }
    /* ── Math (KaTeX) ───────────────────────────────────────── */
    .math-block {
      display: flex; justify-content: center; align-items: center;
      overflow-x: auto; padding: 28px 24px; margin: 16px 0;
      background: rgba(136,192,208,0.05);
      border-radius: 6px; border: 1px solid #3b4252;
    }
    .math-block .katex { font-size: 1.4em; }
    .math-inline {
      display: inline;
      font-size: 25px;
      margin: 20px;
    }
    .math-inline .katex { font-size: 1.1em; }
    .nm-active-line {
      background-color: rgba(136, 192, 208, 0.08);
      border-left: 3px solid #88c0d0;
      padding-left: 6px;
      margin-left: -9px;
      border-radius: 0 3px 3px 0;
      transition: background-color 0.15s;
    }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #1e2128; }
    ::-webkit-scrollbar-thumb { background: #3b4252; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #4c566a; }
    /* ── Tab groups ─────────────────────────────────────────── */
    .tab-group {
      margin: 20px 0;
      border: 1px solid #3b4252;
      border-radius: 6px;
      overflow: hidden;
    }
    .tab-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      background: #22272f;
      border-bottom: 1px solid #3b4252;
      padding: 0 4px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: #7b8698;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      padding: 8px 14px;
      margin-bottom: -1px;
      transition: color .15s, border-color .15s;
      white-space: nowrap;
    }
    .tab-btn:hover { color: #a8cbaf; }
    .tab-btn.active {
      color: #88c0d0;
      border-bottom-color: #88c0d0;
      font-weight: 600;
    }
    .tab-panels { padding: 16px 20px; background: #1e2128; }
    .tab-panel[hidden] { display: none; }
    .tab-panel > *:first-child { margin-top: 0 !important; }
    .tab-panel > *:last-child  { margin-bottom: 0 !important; }
    .tab-panel pre { margin: 0; }
    .fm-block {
      background: #22272f; border: 1px solid #3b4252;
      border-left: 3px solid #5e81ac; border-radius: 0 6px 6px 0;
      padding: 10px 16px; margin-bottom: 28px; font-size: 13px;
    }
    .fm-table { border-collapse: collapse; }
    .fm-table td { border: none; padding: 2px 20px 2px 0; color: #a8cbaf; vertical-align: top; }
    .fm-key { color: #81a1c1; font-weight: 600; white-space: nowrap; }
    .fm-pills { padding-top: 3px; }
    .fm-pill {
      display: inline-block; margin: 2px 4px 2px 0;
      background: #3b4252; color: #88C0D0;
      border: 1px solid #4c566a; border-radius: 20px;
      padding: 1px 10px; font-size: 12px; white-space: nowrap;
    }
    .yt-card {
      display: inline-block; max-width: 100%; margin: 12px 0;
      border-radius: 8px; overflow: hidden; border: 2px solid #3b4252;
      transition: border-color .15s;
    }
    .vm-card {
      display: inline-block; max-width: 100%; margin: 12px 0;
      border-radius: 8px; overflow: hidden; border: 2px solid #3b4252;
      transition: border-color .15s;
    }
    .yt-card:hover { border-color: #5e81ac; }
    .vm-card:hover { border-color: #1ab7ea; }
    .yt-thumb-wrap { position: relative; line-height: 0; }
    .yt-thumb { width: 100%; height: auto; display: block; background: #2e3440; min-height: 120px; }
    .yt-play {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 68px; opacity: .92;
      filter: drop-shadow(0 2px 8px rgba(0,0,0,.6));
      transition: opacity .15s, transform .15s;
    }
    .yt-card:hover .yt-play, .vm-card:hover .yt-play { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
    .yt-label {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: linear-gradient(transparent, rgba(0,0,0,.75));
      color: #fff; font-size: 13px; font-family: sans-serif;
      padding: 24px 12px 8px; line-height: 1;
    }
    /* ── Video embed wrap + fake fullscreen ─────────────────── */
    .video-wrap { position: relative; }
    .video-wrap-local { display: inline-block; max-width: 100%; }
    .video-wrap-local video { display: block; }
    .video-controls {
      position: absolute; top: 6px; right: 6px; z-index: 10;
      display: flex; gap: 4px;
      opacity: 0; transition: opacity .2s;
    }
    .video-wrap:hover .video-controls { opacity: 1; }
    .video-fs-btn {
      background: rgba(0,0,0,.65); color: #fff; border: none; border-radius: 4px;
      font-size: 16px; width: 30px; height: 30px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .video-fs-btn:hover { background: rgba(0,0,0,.85); }
    /* Fake fullscreen: video-wrap covers the entire viewport */
    .video-wrap.video-fullscreen {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; max-width: 100vw !important;
      height: 100vh !important; margin: 0 !important;
      z-index: 99999; background: #000; border-radius: 0 !important;
    }
    .video-wrap.video-fullscreen iframe,
    .video-wrap.video-fullscreen video {
      width: 100% !important; height: 100% !important; border-radius: 0 !important;
    }
    .video-wrap.video-fullscreen .video-controls {
      opacity: 1; top: 12px; right: 12px;
    }
    .video-wrap.video-fullscreen .video-fs-btn {}
    /* ── Image fullscreen ──────────────────────────────────── */
    .img-wrap { position: relative; display: inline-block; max-width: 100%; }
    .img-wrap img { display: block; }
    .img-fs-btn {
      position: absolute; top: 6px; right: 6px; z-index: 10;
      background: rgba(0,0,0,.65); color: #fff; border: none; border-radius: 4px;
      font-size: 16px; width: 30px; height: 30px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity .2s;
    }
    .img-wrap:hover .img-fs-btn { opacity: 1; }
    .img-fs-btn:hover { background: rgba(0,0,0,.85); }
    .img-wrap.img-fullscreen {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; max-width: 100vw !important;
      height: 100vh !important; margin: 0 !important;
      z-index: 99999; background: rgba(0,0,0,.92); border-radius: 0 !important;
      display: flex; align-items: center; justify-content: center;
    }
    .img-wrap.img-fullscreen img {
      max-width: 95vw !important; max-height: 95vh !important;
      width: auto !important; height: auto !important;
      object-fit: contain;
    }
    .img-wrap.img-fullscreen .img-fs-btn {
      opacity: 1; top: 12px; right: 12px;
    }
    /* ── Task lists ─────────────────────────────────────────── */
    ul.task-list, ol.task-list { list-style: none; padding-left: 1.5em; margin: .25em 0; }
    li.task-list-item > ul.task-list,
    li.task-list-item > ol.task-list { padding-left: 1.8em; border-left: 1.5px solid #3b4252; margin-left: .2em; }
    li.task-list-item { list-style: none; margin: .2em 0; padding: 0; line-height: 1.6; }
    svg.task-checkbox { width: 1em; height: 1em; vertical-align: -0.15em; display: inline-block; flex-shrink: 0; }
    li.task-list-item-checked > span.task-list-text { color: #88c0d0; }
    /* ── md-button (Material spec, Nord palette) ───────────── */
    a.md-button {
      display: inline-block;
      padding: .4375em 1em;
      border-radius: .1rem;
      font-size: .8rem;
      font-weight: 700;
      letter-spacing: .0625em;
      text-transform: uppercase;
      text-decoration: none !important;
      line-height: 1.6;
      vertical-align: middle;
      cursor: pointer;
      margin: .125em .25em .125em 0;
      user-select: none;
      border: .1rem solid #81a1c1;
      color: #88c0d0;
      background-color: transparent;
      transition: color 125ms, background-color 125ms, border-color 125ms, box-shadow 125ms;
    }
    a.md-button:hover,
    a.md-button:focus-visible {
      background-color: #88c0d0;
      border-color: #88c0d0;
      color: #2e3440;
      box-shadow: 0 0 0 .2rem rgba(136,192,208,.25);
      outline: none;
    }
    a.md-button:active {
      background-color: #81a1c1;
      border-color: #81a1c1;
      color: #2e3440;
      box-shadow: none;
    }
    a.md-button.md-button--primary {
      background-color: #5e81ac;
      border-color: #5e81ac;
      color: #eceff4;
    }
    a.md-button.md-button--primary:hover,
    a.md-button.md-button--primary:focus-visible {
      background-color: #81a1c1;
      border-color: #81a1c1;
      color: #eceff4;
      box-shadow: 0 0 0 .2rem rgba(94,129,172,.35);
      outline: none;
    }
    a.md-button.md-button--primary:active {
      background-color: #4c6f97;
      border-color: #4c6f97;
      color: #eceff4;
      box-shadow: none;
    }
    /* ── Theme toggle button ─────────────────────────────── */
    .nm-btn-theme { }
    /* ── Light theme overrides ───────────────────────────── */
    body.nm-light {
      background: #ffffff !important; color: #2e3440 !important;
      color-scheme: light;
      scrollbar-color: #c0c8d8 #f0f2f5;
    }
    body.nm-light .nm-toolbar {
      background: #e8eaf0 !important; border-bottom-color: #c8cdd8 !important;
    }
    body.nm-light .nm-btn {
      background: transparent !important; color: #2e3440 !important;
    }
    body.nm-light .nm-btn:hover { background: rgba(0,0,0,.08) !important; }
    body.nm-light .nm-btn-pin { color: #9aa5b8 !important; }
    body.nm-light .nm-btn-pin.pinned { color: #5e81ac !important; }
    body.nm-light .nm-zoom-level { color: #4c566a !important; }
    body.nm-light .nm-zoom-level:hover { color: #5e81ac !important; }
    body.nm-light .nm-filename { color: #4c6a9c !important; }
    html:has(body.nm-light)::-webkit-scrollbar-track,
    body.nm-light::-webkit-scrollbar-track,
    body.nm-light ::-webkit-scrollbar-track { background: #f0f2f5 !important; }
    html:has(body.nm-light)::-webkit-scrollbar-thumb,
    body.nm-light::-webkit-scrollbar-thumb,
    body.nm-light ::-webkit-scrollbar-thumb { background: #c0c8d8 !important; }
    html:has(body.nm-light)::-webkit-scrollbar-thumb:hover,
    body.nm-light::-webkit-scrollbar-thumb:hover,
    body.nm-light ::-webkit-scrollbar-thumb:hover { background: #a8b4c8 !important; }
    body.nm-light .tab-bar { background: #e8eaf0 !important; border-bottom-color: #c8cdd8 !important; }
    body.nm-light .tab-btn { color: #6a7a94 !important; }
    body.nm-light .tab-btn:hover { color: #2e3440 !important; }
    body.nm-light .tab-btn.active { color: #5e81ac !important; border-bottom-color: #5e81ac !important; }
    body.nm-light .tab-panels { background: #f8f9fb !important; }
    body.nm-light .tab-group { border-color: #c8cdd8 !important; }
    body.nm-light .fm-block { background: #eef0f5 !important; border-color: #c8cdd8 !important; border-left-color: #5e81ac !important; }
    body.nm-light .fm-table td { color: #2e3440 !important; }
    body.nm-light .fm-key { color: #4c6a9c !important; }
    body.nm-light .fm-pill { background: #dde2ee !important; color: #5e81ac !important; border-color: #c0c8d8 !important; }
    body.nm-light details { border-color: #c8cdd8 !important; }
    body.nm-light summary { color: #5e81ac !important; }
    body.nm-light .math-block { background: rgba(94,129,172,0.07) !important; border-color: #c8cdd8 !important; }
    body.nm-light .nm-active-line { background-color: rgba(94,129,172,0.1) !important; border-left-color: #5e81ac !important; }
    body.nm-light .yt-card, body.nm-light .vm-card { border-color: #c8cdd8 !important; }
    /* ── Mermaid diagrams ───────────────────────────────── */
    .mermaid {
      display: flex; justify-content: center;
      padding: 24px 16px; margin: 20px 0;
      background: rgba(94,129,242,0.06);
      border: 1px solid rgba(94,129,242,0.25); border-radius: 10px;
      overflow-x: auto;
      box-shadow: 0 2px 12px rgba(0,0,0,0.18);
    }
    .mermaid svg { max-width: 100%; height: auto; }
    body.nm-light .mermaid {
      background: rgba(76,126,244,0.05) !important;
      border-color: rgba(76,126,244,0.2) !important;
      box-shadow: 0 2px 12px rgba(0,0,0,0.07) !important;
    }
    /* ── Disable all content links (pointer & keyboard) ─── */
    .vscode-body a:not(.md-button) {
      pointer-events: none !important;
      cursor: default !important;
    }
    .vscode-body a[data-md-path]:not(.md-button),
    .vscode-body a[data-md-url]:not(.md-button),
    .vscode-body a[data-file-path]:not(.md-button),
    .vscode-body a[href^="#"]:not(.md-button) {
      pointer-events: auto !important;
      cursor: pointer !important;
    }
    .vscode-body a:not(.md-button):focus,
    .vscode-body a:not(.md-button):focus-visible {
      outline: none !important;
      box-shadow: none !important;
    }
  </style>
</head>
<body class="${savedTheme === 'light' ? 'nm-light' : ''}">
<div class="nm-toolbar-hover-zone"></div>
<div class="nm-toolbar">
  <div class="nm-toolbar-nav">
    <button class="nm-btn" id="btnNavPrev" title="Previous page" disabled><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
    <button class="nm-btn" id="btnNavNext" title="Next page"     disabled><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
  </div>
  <span class="nm-filename">${escHtml(filename)}</span>
  <div class="nm-toolbar-actions">
    <button class="nm-btn" id="btnZoomOut" title="Zoom out"><svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
    <span class="nm-zoom-level" id="zoomLevel" title="Reset zoom">100%</span>
    <button class="nm-btn" id="btnZoomIn" title="Zoom in"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
    <button class="nm-btn" id="btnScrollTop"    title="Scroll to top"><svg viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg></button>
    <button class="nm-btn" id="btnScrollBottom" title="Scroll to bottom"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
    <button class="nm-btn nm-btn-theme" id="btnThemeToggle" title="Toggle light/dark theme"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>
    <button class="nm-btn" id="btnSettings" title="Color settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="nm-btn nm-btn-pin" id="btnPin" title="Pin toolbar"><svg viewBox="0 0 24 24"><path d="M9 4v6l-2 4v2h10v-2l-2-4V4"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="8" y1="4" x2="16" y2="4"/></svg></button>
    <div class="nm-export-wrap">
      <button class="nm-btn" id="btnExport" title="Export"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
      <div class="nm-export-menu" id="exportMenu">
        <button id="btnExportPdf"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Export as PDF</button>
        <button id="btnExportHtml"><svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>Export as HTML</button>
      </div>
    </div>
  </div>
</div>
<div class="nm-settings-overlay" id="settingsOverlay">
  <div class="nm-settings-panel">
    <h3>Color Settings</h3>
    <div class="nm-settings-section">
      <h4>Dark Mode</h4>
      <div class="nm-color-row"><label>Background</label><input type="color" id="clrDarkBg" data-key="darkBg"></div>
      <div class="nm-color-row"><label>Font Color</label><input type="color" id="clrDarkFont" data-key="darkFont"></div>
      <div class="nm-color-row"><label>H1 Color</label><input type="color" id="clrDarkH1" data-key="darkH1"></div>
      <div class="nm-color-row"><label>H2 Color</label><input type="color" id="clrDarkH2" data-key="darkH2"></div>
      <div class="nm-color-row"><label>H3 Color</label><input type="color" id="clrDarkH3" data-key="darkH3"></div>
      <div class="nm-color-row"><label>H4 Color</label><input type="color" id="clrDarkH4" data-key="darkH4"></div>
      <div class="nm-color-row"><label>H5 Color</label><input type="color" id="clrDarkH5" data-key="darkH5"></div>
      <div class="nm-color-row"><label>H6 Color</label><input type="color" id="clrDarkH6" data-key="darkH6"></div>
    </div>
    <div class="nm-settings-section">
      <h4>Light Mode</h4>
      <div class="nm-color-row"><label>Background</label><input type="color" id="clrLightBg" data-key="lightBg"></div>
      <div class="nm-color-row"><label>Font Color</label><input type="color" id="clrLightFont" data-key="lightFont"></div>
      <div class="nm-color-row"><label>H1 Color</label><input type="color" id="clrLightH1" data-key="lightH1"></div>
      <div class="nm-color-row"><label>H2 Color</label><input type="color" id="clrLightH2" data-key="lightH2"></div>
      <div class="nm-color-row"><label>H3 Color</label><input type="color" id="clrLightH3" data-key="lightH3"></div>
      <div class="nm-color-row"><label>H4 Color</label><input type="color" id="clrLightH4" data-key="lightH4"></div>
      <div class="nm-color-row"><label>H5 Color</label><input type="color" id="clrLightH5" data-key="lightH5"></div>
      <div class="nm-color-row"><label>H6 Color</label><input type="color" id="clrLightH6" data-key="lightH6"></div>
    </div>
    <div class="nm-settings-btns">
      <button class="nm-sbtn-reset" id="btnColorReset">Reset to Default</button>
      <button class="nm-sbtn-close" id="btnSettingsClose">Close</button>
    </div>
  </div>
</div>
<div class="vscode-body">
${body}
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/languages/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js"></script>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  const isDark = () => !document.body.classList.contains('nm-light');
  function initMermaid() {
    const darkVars = {
      background:          '#1e2128',
      primaryColor:        '#5482ec',
      primaryTextColor:    '#eceff4',
      primaryBorderColor:  '#7c9ef7',
      lineColor:           '#88c0d0',
      secondaryColor:      '#b48ead',
      tertiaryColor:       '#a3be8c',
      edgeLabelBackground: '#2e3440',
      nodeBorder:          '#4c566a',
      clusterBkg:          '#2e3440',
      clusterBorder:       '#4c566a',
      titleColor:          '#eceff4',
      edgeColor:           '#88c0d0',
      cScale0:  '#7b9cf7',
      cScale1:  '#bf6ade',
      cScale2:  '#3dba8a',
      cScale3:  '#f4a45e',
      cScale4:  '#f4605e',
      cScale5:  '#5ec8f4',
      cScale6:  '#ebcb8b',
      cScale7:  '#e05e8b',
      cScale8:  '#7cb8f4',
      cScale9:  '#a3be8c',
      cScale10: '#d08770',
      cScale11: '#8fbcbb',
    };
    const lightVars = {
      background:          '#ffffff',
      primaryColor:        '#6b91f6',
      primaryTextColor:    '#2e3440',
      primaryBorderColor:  '#3d6ee8',
      lineColor:           '#5281ac',
      secondaryColor:      '#9c5bcc',
      tertiaryColor:       '#2d9e74',
      edgeLabelBackground: '#f0f4ff',
      nodeBorder:          '#3d6ee8',
      clusterBkg:          '#eef2ff',
      clusterBorder:       '#a0b4f4',
      titleColor:          '#2e3440',
      edgeColor:           '#5281ac',
      cScale0:  '#6b91f6',
      cScale1:  '#9c5bcc',
      cScale2:  '#2d9e74',
      cScale3:  '#e8883c',
      cScale4:  '#e04848',
      cScale5:  '#3cace8',
      cScale6:  '#c8a820',
      cScale7:  '#cc3d6e',
      cScale8:  '#5c9ee8',
      cScale9:  '#5a9e58',
      cScale10: '#c8622c',
      cScale11: '#3d8c8c',
    };
    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables: isDark() ? darkVars : lightVars,
    });
  }
  async function renderMermaid(root) {
    const els = (root || document).querySelectorAll('.mermaid:not([data-mermaid-done])');
    if (!els.length) return;
    initMermaid();
    for (const el of els) {
      const src = el.dataset.mermaidSrc || el.textContent;
      el.dataset.mermaidSrc = src;
      el.removeAttribute('data-processed');
      el.textContent = src;
    }
    await mermaid.run({ nodes: Array.from(els) });
    els.forEach(el => el.setAttribute('data-mermaid-done', '1'));
  }
  window.__renderMermaid = renderMermaid;

  // Initial render + re-render when theme toggles
  renderMermaid();
  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    document.querySelectorAll('.mermaid[data-mermaid-done]').forEach(el => {
      el.removeAttribute('data-mermaid-done');
    });
    renderMermaid();
  });

  // Re-render after content updates (message from extension)
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'update') {
      // Slight delay so the innerHTML swap in the main script runs first
      setTimeout(() => renderMermaid(), 0);
    }
  });
</script>
<script>
(function() {
  const vscode = acquireVsCodeApi();

  // Seed webview state with server-saved colors (first load only)
  (function() {
    var s = vscode.getState();
    if (!s || !s.colors) {
      var sc = ${savedColors ? JSON.stringify(savedColors) : 'null'};
      if (sc) vscode.setState(Object.assign({}, s || {}, { colors: sc }));
    }
  })();

  // Render all .math-inline and .math-block elements with KaTeX
  function renderMath(root) {
    if (!window.katex) return;
    (root || document).querySelectorAll('.math-inline').forEach(el => {
      const latex = el.dataset.latex;
      if (!latex) return;
      try { katex.render(latex, el, { throwOnError: false, displayMode: false }); }
      catch(e) {}
    });
    (root || document).querySelectorAll('.math-block').forEach(el => {
      const latex = el.dataset.latex;
      if (!latex) return;
      try { katex.render(latex, el, { throwOnError: false, displayMode: true }); }
      catch(e) {}
    });
  }

  // Copy button for code blocks
  function addCopyButtons() {
    document.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.nm-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'nm-copy-btn';
      btn.title = 'Copy';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        const text = code ? code.innerText : pre.innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          btn.title = 'Copied!';
          btn.classList.add('nm-copied');
          setTimeout(() => {
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            btn.title = 'Copy';
            btn.classList.remove('nm-copied');
          }, 1500);
        }).catch(() => {});
      });
      pre.appendChild(btn);
    });
  }

  // Highlight all code blocks on initial load
  if (window.hljs) {
    document.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
  }
  addCopyButtons();
  renderMath();

  document.getElementById('btnNavPrev')
    .addEventListener('click', () => vscode.postMessage({ type: 'prevPage', scrollY: window.scrollY }));
  document.getElementById('btnNavNext')
    .addEventListener('click', () => vscode.postMessage({ type: 'nextPage', scrollY: window.scrollY }));

  document.getElementById('btnScrollTop')
    .addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.getElementById('btnScrollBottom')
    .addEventListener('click', () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));

  // ── Zoom ───────────────────────────────────────────────────────────────────
  (function() {
    const ZOOM_STEP = 10, ZOOM_MIN = 50, ZOOM_MAX = 200;
    const body      = document.querySelector('.vscode-body');
    const label     = document.getElementById('zoomLevel');
    const saved     = vscode.getState();
    var   zoom      = (saved && saved.zoom) || 100;

    function applyZoom() {
      body.style.zoom = (zoom / 100).toString();
      label.textContent = zoom + '%';
      vscode.setState({ ...vscode.getState(), zoom });
    }
    applyZoom();

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      zoom = Math.min(zoom + ZOOM_STEP, ZOOM_MAX); applyZoom();
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      zoom = Math.max(zoom - ZOOM_STEP, ZOOM_MIN); applyZoom();
    });
    label.addEventListener('click', () => { zoom = 100; applyZoom(); });
  })();

  // ── Theme toggle ──────────────────────────────────────────────────────────
  function applyScrollbarStyle(isLight) {
    var el = document.getElementById('nm-scrollbar-override');
    if (!el) {
      el = document.createElement('style');
      el.id = 'nm-scrollbar-override';
      document.head.appendChild(el);
    }
    el.textContent = isLight
      ? 'pre::-webkit-scrollbar-track, pre.hljs::-webkit-scrollbar-track { background: #f0f2f8 !important; }' +
        'pre::-webkit-scrollbar-thumb, pre.hljs::-webkit-scrollbar-thumb { background: #c0c8d8 !important; border-radius: 3px; }' +
        'pre::-webkit-scrollbar-thumb:hover, pre.hljs::-webkit-scrollbar-thumb:hover { background: #a8b4c8 !important; }'
      : '';
  }

  const sunSvg  = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" color="#dfa842" fill="#ebcb8b" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" color="#dfa842" fill="#ebcb8b" /></svg>';
  const moonSvg = '<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" color="#dfa842" fill="#ebcb8b"/></svg>';

  (function() {
    const btn  = document.getElementById('btnThemeToggle');
    const body = document.body;

    // Initialise icon from server-side class (set via globalState)
    const isInitLight = body.classList.contains('nm-light');
    btn.innerHTML = isInitLight ? moonSvg : sunSvg;
    if (isInitLight) applyScrollbarStyle(true);
    vscode.setState({ ...vscode.getState(), theme: isInitLight ? 'light' : 'dark' });

    btn.addEventListener('click', () => {
      const isLight = body.classList.toggle('nm-light');
      btn.innerHTML = isLight ? moonSvg : sunSvg;
      applyScrollbarStyle(isLight);
      const theme = isLight ? 'light' : 'dark';
      vscode.setState({ ...vscode.getState(), theme });
      vscode.postMessage({ type: 'themeChanged', theme });
    });
  })();

  // ── Pin / auto-hide toolbar ────────────────────────────────────────────────
  (function() {
    const toolbar   = document.querySelector('.nm-toolbar');
    const hoverZone = document.querySelector('.nm-toolbar-hover-zone');
    const pinBtn    = document.getElementById('btnPin');
    const savedPin  = (vscode.getState() || {}).pinned;
    let pinned      = savedPin !== false;
    let lastScrollY = 0;

    function applyPin() {
      if (pinned) {
        pinBtn.classList.add('pinned');
        toolbar.classList.add('nm-toolbar-pinned');
        toolbar.classList.remove('nm-toolbar-hidden');
        document.body.classList.add('nm-pinned');
      } else {
        pinBtn.classList.remove('pinned');
        toolbar.classList.remove('nm-toolbar-pinned');
        document.body.classList.remove('nm-pinned');
      }
      vscode.setState({ ...vscode.getState(), pinned });
    }
    applyPin();

    pinBtn.addEventListener('click', () => { pinned = !pinned; applyPin(); });

    window.addEventListener('scroll', () => {
      if (pinned) return;
      const y = window.scrollY;
      if (y > lastScrollY && y > 60) {
        toolbar.classList.add('nm-toolbar-hidden');
      } else {
        toolbar.classList.remove('nm-toolbar-hidden');
      }
      lastScrollY = y;
    }, { passive: true });

    hoverZone.addEventListener('mouseenter', () => {
      toolbar.classList.remove('nm-toolbar-hidden');
    });
  })();

  // ── Export dropdown ─────────────────────────────────────────────────────────
  (function() {
    const exportBtn  = document.getElementById('btnExport');
    const exportMenu = document.getElementById('exportMenu');
    const btnPdf     = document.getElementById('btnExportPdf');
    const btnHtml    = document.getElementById('btnExportHtml');

    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });

    document.addEventListener('click', () => {
      exportMenu.classList.remove('open');
    });

    exportMenu.addEventListener('click', (e) => e.stopPropagation());

    // Remove UI-only elements from the DOM before capturing HTML, then restore them
    function captureCleanHtml(selectors) {
      var removed = [];
      selectors.forEach(function(sel) {
        var el = document.querySelector(sel);
        if (el && el.parentNode) {
          removed.push({ el: el, parent: el.parentNode, next: el.nextSibling });
          el.parentNode.removeChild(el);
        }
      });
      var html = document.documentElement.outerHTML;
      removed.reverse().forEach(function(r) {
        r.parent.insertBefore(r.el, r.next);
      });
      return html;
    }

    var uiSelectors = ['.nm-toolbar', '.nm-toolbar-hover-zone', '.nm-settings-overlay', '#nm-scrollbar-override'];

    btnPdf.addEventListener('click', () => {
      exportMenu.classList.remove('open');
      // PDF: also strip custom color overrides — use default print styles
      vscode.postMessage({ type: 'exportPdf', html: captureCleanHtml(uiSelectors.concat('#nm-color-overrides')) });
    });

    btnHtml.addEventListener('click', () => {
      exportMenu.classList.remove('open');
      // HTML: keep custom color overrides
      vscode.postMessage({ type: 'exportHtml', html: captureCleanHtml(uiSelectors) });
    });
  })();

  // ── Color settings modal ──────────────────────────────────────────────────
  (function() {
    const DEFAULTS = {
      darkBg: '#1e2128', darkFont: '#a8cbaf',
      darkH1: '#BF616A', darkH2: '#cfb682', darkH3: '#A3BE8C',
      darkH4: '#B48EAD', darkH5: '#8FBCBB', darkH6: '#88C0D0',
      lightBg: '#ffffff', lightFont: '#2e3440',
      lightH1: '#4d4d4d', lightH2: '#4d4d4d', lightH3: '#4d4d4d',
      lightH4: '#4d4d4d', lightH5: '#4d4d4d', lightH6: '#4d4d4d',
    };
    const KEYS = Object.keys(DEFAULTS);
    const overlay = document.getElementById('settingsOverlay');

    // Load saved colors from webview state or from server-injected data
    var colors = Object.assign({}, DEFAULTS);
    const saved = vscode.getState();
    if (saved && saved.colors) Object.assign(colors, saved.colors);

    function applyColors() {
      // Inject / update a <style> element with CSS custom-property overrides
      var el = document.getElementById('nm-color-overrides');
      if (!el) {
        el = document.createElement('style');
        el.id = 'nm-color-overrides';
        document.head.appendChild(el);
      }
      el.textContent =
        'html, body { background: ' + colors.darkBg + ' !important; color: ' + colors.darkFont + ' !important; }' +
        '.vscode-body h1 { color: ' + colors.darkH1 + ' !important; }' +
        '.vscode-body h2 { color: ' + colors.darkH2 + ' !important; }' +
        '.vscode-body h3 { color: ' + colors.darkH3 + ' !important; }' +
        '.vscode-body h4 { color: ' + colors.darkH4 + ' !important; }' +
        '.vscode-body h5 { color: ' + colors.darkH5 + ' !important; }' +
        '.vscode-body h6 { color: ' + colors.darkH6 + ' !important; }' +
        'body.nm-light, html:has(body.nm-light) { background: ' + colors.lightBg + ' !important; color: ' + colors.lightFont + ' !important; }' +
        'body.nm-light .vscode-body { background-color: ' + colors.lightBg + ' !important; color: ' + colors.lightFont + ' !important; }' +
        'body.nm-light .vscode-body h1 { color: ' + colors.lightH1 + ' !important; }' +
        'body.nm-light .vscode-body h2 { color: ' + colors.lightH2 + ' !important; }' +
        'body.nm-light .vscode-body h3 { color: ' + colors.lightH3 + ' !important; }' +
        'body.nm-light .vscode-body h4 { color: ' + colors.lightH4 + ' !important; }' +
        'body.nm-light .vscode-body h5 { color: ' + colors.lightH5 + ' !important; }' +
        'body.nm-light .vscode-body h6 { color: ' + colors.lightH6 + ' !important; }';
    }

    function syncInputs() {
      KEYS.forEach(function(k) {
        var inp = document.querySelector('#settingsOverlay input[data-key="' + k + '"]');
        if (inp) inp.value = colors[k];
      });
    }

    function save() {
      vscode.setState(Object.assign({}, vscode.getState(), { colors: colors }));
      vscode.postMessage({ type: 'colorsChanged', colors: colors });
    }

    // Apply on load
    applyColors();

    // Open
    document.getElementById('btnSettings').addEventListener('click', function(e) {
      e.stopPropagation();
      syncInputs();
      overlay.classList.add('open');
    });

    // Live-update on color input change
    overlay.addEventListener('input', function(e) {
      if (e.target.type === 'color' && e.target.dataset.key) {
        colors[e.target.dataset.key] = e.target.value;
        applyColors();
        save();
      }
    });

    // Reset
    document.getElementById('btnColorReset').addEventListener('click', function() {
      Object.assign(colors, DEFAULTS);
      applyColors();
      syncInputs();
      save();
    });

    // Close
    document.getElementById('btnSettingsClose').addEventListener('click', function() {
      overlay.classList.remove('open');
    });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  })();

  const state = vscode.getState() || {};
  if (state.scrollY) window.scrollTo(0, state.scrollY);

  let ticking = false;
  let revealLock = false;       // blocks syncScroll while revealLine is in effect
  let revealLockTimer = null;
  // Anchor for delta-based scroll after a heading focus.
  // Prevents syncScroll from jumping to ratio*maxScroll instead of
  // continuing from where the heading was focused.
  let scrollAnchorRatio = null;   // editor ratio at moment of revealLine
  let scrollAnchorY     = null;   // preview scrollY at moment of revealLine

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        vscode.setState({ ...vscode.getState(), scrollY: window.scrollY });
        ticking = false;
      });
      ticking = true;
    }
  });

  // Escape exits fake fullscreen
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const fs = document.querySelector('.video-wrap.video-fullscreen');
      if (fs) {
        fs.classList.remove('video-fullscreen');
        fs.querySelector('.video-fs-btn').textContent = '⛶';

      }
      const imgFs = document.querySelector('.img-wrap.img-fullscreen');
      if (imgFs) {
        imgFs.classList.remove('img-fullscreen');
        imgFs.querySelector('.img-fs-btn').textContent = '⛶';
      }
    }
  });

  document.addEventListener('click', e => {
    const card = e.target.closest('.yt-card, .vm-card');
    if (card) { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: card.dataset.url }); return; }

    // Video fake-fullscreen toggle
    const fsBtn = e.target.closest('.video-fs-btn');
    if (fsBtn) {
      e.preventDefault();
      const wrap = fsBtn.closest('.video-wrap');
      if (wrap) {
        wrap.classList.toggle('video-fullscreen');
        const isFs = wrap.classList.contains('video-fullscreen');
        fsBtn.textContent = isFs ? '✕' : '⛶';
      }
      return;
    }

    // Image fake-fullscreen toggle
    const imgFsBtn = e.target.closest('.img-fs-btn');
    if (imgFsBtn) {
      e.preventDefault();
      const wrap = imgFsBtn.closest('.img-wrap');
      if (wrap) {
        wrap.classList.toggle('img-fullscreen');
        imgFsBtn.textContent = wrap.classList.contains('img-fullscreen') ? '✕' : '⛶';
      }
      return;
    }

    // Tab switching
    const tabBtn = e.target.closest('.tab-btn');
    if (tabBtn) { activateTab(tabBtn); return; }

    // md-button: open .md files in VS Code, external URLs in browser
    const mdBtn = e.target.closest('[data-md-btn]');
    if (mdBtn) {
      e.preventDefault();
      const mdPath = mdBtn.dataset.mdPath;
      const mdUrl  = mdBtn.dataset.mdUrl;
      if (mdPath) vscode.postMessage({ type: 'openMdFile', path: mdPath, scrollY: window.scrollY });
      else if (mdUrl) vscode.postMessage({ type: 'openUrl', url: mdUrl });
      return;
    }

    // Plain markdown links (<a href="other.md">) — open in VS Code
    const mdLink = e.target.closest('a[data-md-path]:not([data-md-btn])');
    if (mdLink) {
      e.preventDefault();
      vscode.postMessage({ type: 'openMdFile', path: mdLink.dataset.mdPath, scrollY: window.scrollY });
      return;
    }

    // Plain external links (<a href="https://...">)
    const urlLink = e.target.closest('a[data-md-url]:not([data-md-btn])');
    if (urlLink) {
      e.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: urlLink.dataset.mdUrl });
      return;
    }

    // File links (PDFs, images, etc.) — open in VS Code panel
    const fileLink = e.target.closest('a[data-file-path]');
    if (fileLink) {
      e.preventDefault();
      vscode.postMessage({ type: 'openFile', path: fileLink.dataset.filePath });
      return;
    }

    // Fragment (TOC) links — scroll to the target heading
    const fragLink = e.target.closest('a[href^="#"]');
    if (fragLink && fragLink.closest('.vscode-body')) {
      e.preventDefault();
      const id = fragLink.getAttribute('href').slice(1);
      const target = id ? document.getElementById(id) : null;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    // Disable all other links inside the body
    const anchor = e.target.closest('a:not(.md-button)');
    if (anchor && anchor.closest('.vscode-body')) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  function activateTab(btn) {
    const bar    = btn.closest('.tab-bar');
    const group  = btn.closest('.tab-group');
    if (!bar || !group) return;
    bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const targetId = btn.dataset.tab;
    group.querySelectorAll('.tab-panel').forEach(p => {
      p.hidden = (p.id !== targetId);
    });
  }

  // Restore active tabs after an update (use first tab as default — state is reset)
  function initTabs(root) {
    (root || document).querySelectorAll('.tab-group').forEach(group => {
      const firstBtn = group.querySelector('.tab-btn');
      if (firstBtn) activateTab(firstBtn);
    });
  }
  initTabs();

  // Wrap each <img> in the content area with an .img-wrap + fullscreen button
  function wrapImages(root) {
    (root || document).querySelectorAll('.vscode-body img').forEach(img => {
      if (img.closest('.img-wrap')) return; // already wrapped
      const wrap = document.createElement('span');
      wrap.className = 'img-wrap';
      const btn = document.createElement('button');
      btn.className = 'img-fs-btn';
      btn.textContent = '⛶';
      btn.title = 'Maximize';
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);
      wrap.appendChild(btn);
    });
  }
  wrapImages();

  // Wrap bare <video> elements (not already inside .video-wrap) with fullscreen controls
  function wrapVideos(root) {
    (root || document).querySelectorAll('.vscode-body video').forEach(vid => {
      if (vid.closest('.video-wrap')) return; // already wrapped
      const wrap = document.createElement('div');
      wrap.className = 'video-wrap video-wrap-local';
      wrap.style.margin = '12px 0';
      // Transfer width from video to wrap so the wrap hugs the video
      const vidWidth = vid.getAttribute('width') || vid.style.width;
      if (vidWidth) {
        wrap.style.width = /^\d+$/.test(vidWidth) ? vidWidth + 'px' : vidWidth;
        vid.style.width = '100%';
        vid.removeAttribute('width');
      }
      const controls = document.createElement('div');
      controls.className = 'video-controls';
      const btn = document.createElement('button');
      btn.className = 'video-fs-btn';
      btn.textContent = '⛶';
      btn.title = 'Maximize';
      controls.appendChild(btn);
      vid.parentNode.insertBefore(wrap, vid);
      wrap.appendChild(vid);
      wrap.appendChild(controls);
    });
  }
  wrapVideos();

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'navState') {
      document.getElementById('btnNavPrev').disabled = !msg.canPrev;
      document.getElementById('btnNavNext').disabled = !msg.canNext;
    }
    if (msg.type === 'syncScroll') {
      if (revealLock) return;   // revealLine fired recently — don't clobber it
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (maxScroll <= 0) return;
      if (scrollAnchorRatio !== null) {
        // Delta from the anchor so scrolling continues from the focused heading,
        // not from ratio * maxScroll which would jump to a different position.
        window.scrollTo({ top: scrollAnchorY + (msg.ratio - scrollAnchorRatio) * maxScroll, behavior: 'auto' });
      } else {
        window.scrollTo({ top: msg.ratio * maxScroll, behavior: 'auto' });
      }
    }
    if (msg.type === 'revealLine') {
      // Exclude .tab-btn: they carry data-line only for tab-activation logic.
      const all = Array.from(document.querySelectorAll('[data-line]'))
                    .filter(el => !el.classList.contains('tab-btn'));
      if (!all.length) return;
      let target = null;

      // Pass 0: cursor is on a heading — find the matching <hN> by text content.
      // This is immune to data-line offset bugs caused by tab-group filler lines.
      if (msg.headingText && msg.headingLevel) {
        const tag = 'H' + msg.headingLevel;
        const needle = msg.headingText.trim().toLowerCase();
        for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          if (el.tagName === tag && el.textContent.trim().toLowerCase() === needle) {
            target = el;
            break;
          }
        }
      }

      // Pass 1: heading match by data-line proximity (fallback when text match fails).
      // Use a narrow tolerance; wide heading search uses Pass 0 instead.
      if (!target) {
        for (const el of all) {
          const n = parseInt(el.dataset.line, 10);
          if (/^H[1-6]$/.test(el.tagName) && Math.abs(n - msg.line) <= 3) {
            if (!target || Math.abs(n - msg.line) < Math.abs(parseInt(target.dataset.line, 10) - msg.line)) {
              target = el;
            }
          }
        }
      }

      // Pass 2a: closest real content element (not a tab-group div) at or before cursor.
      // This ensures headings and paragraphs after a tab group always win over the group itself.
      if (!target) {
        for (const el of all) {
          if (el.classList.contains('tab-group')) continue;
          const n = parseInt(el.dataset.line, 10);
          if (n > msg.line) continue;
          if (!target || n > parseInt(target.dataset.line, 10)) target = el;
        }
      }

      // Pass 2b: fall back to tab-group divs only when cursor is genuinely inside one
      // (i.e., no real content element was found closer to the cursor).
      if (!target) {
        for (const el of all) {
          const n = parseInt(el.dataset.line, 10);
          if (n > msg.line) continue;
          if (!target || n > parseInt(target.dataset.line, 10)) target = el;
        }
      }

      if (!target) target = all[0];

      // If the target is (or is inside) a tab-group, switch to the tab whose
      // === header line is the closest one at or before the cursor line.
      const tabGroup = target.classList.contains('tab-group')
        ? target
        : target.closest('.tab-group');
      if (tabGroup) {
        const btns = Array.from(tabGroup.querySelectorAll('.tab-btn[data-line]'));
        let bestBtn = null;
        for (const btn of btns) {
          const n = parseInt(btn.dataset.line, 10);
          if (n <= msg.line) {
            if (!bestBtn || n > parseInt(bestBtn.dataset.line, 10)) bestBtn = btn;
          }
        }
        if (bestBtn) activateTab(bestBtn);
      }

      // Highlight
      document.querySelectorAll('.nm-active-line').forEach(el => el.classList.remove('nm-active-line'));
      target.classList.add('nm-active-line');
      // Lock out syncScroll so it can't override this scroll
      revealLock = true;
      clearTimeout(revealLockTimer);
      revealLockTimer = setTimeout(() => { revealLock = false; }, 800);
      // Scroll so the target element sits at the same vertical fraction of the
      // preview viewport as the cursor line occupies in the editor viewport.
      // e.g. cursor at 30% down the editor → target at 30% down the preview.
      const fraction = (msg.viewportFraction !== undefined) ? msg.viewportFraction : 0.3;
      const rect = target.getBoundingClientRect();
      const targetTop = rect.top + window.scrollY;  // absolute Y of element
      window.scrollTo({ top: targetTop - fraction * window.innerHeight, behavior: 'instant' });
      // Store anchor for delta-based syncScroll after the lock expires
      scrollAnchorRatio = (msg.anchorRatio !== undefined) ? msg.anchorRatio : null;
      scrollAnchorY     = window.scrollY;
    }
    if (msg.type === 'update') {
      const container = document.querySelector('.vscode-body');
      const prevScroll = window.scrollY;
      if (container) container.innerHTML = msg.html;
      document.querySelectorAll('pre code').forEach(el => {
        if (window.hljs) window.hljs.highlightElement(el);
      });
      addCopyButtons();
      renderMath();
      initTabs();
      wrapImages();
      wrapVideos();
      // Clear any stale active-line highlight after a content swap
      document.querySelectorAll('.nm-active-line').forEach(el => el.classList.remove('nm-active-line'));
      const fn = document.querySelector('.nm-filename');
      if (fn) fn.textContent = msg.filename || '';
      // Re-apply theme after content swap
      const themeState = (vscode.getState() || {}).theme;
      const themeBtn = document.getElementById('btnThemeToggle');
      if (themeState === 'light') { document.body.classList.add('nm-light'); if (themeBtn) themeBtn.innerHTML = moonSvg; applyScrollbarStyle(true); }
      else if (themeBtn) { themeBtn.innerHTML = sunSvg; }
      const scrollTarget = msg.restoreScrollY !== undefined ? msg.restoreScrollY : prevScroll;
      requestAnimationFrame(() => window.scrollTo(0, scrollTarget));
    }
  });
})();
</script>
</body>
</html>`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Singleton preview panel — follows the active markdown editor
// ─────────────────────────────────────────────────────────────────────────────
let previewPanel   = null;   // the single WebviewPanel instance
let activeMarkdownPath = null;  // fsPath currently shown
let editorSub      = null;   // onDidChangeActiveTextEditor subscription
let textSub        = null;   // onDidChangeTextDocument subscription
let scrollSub      = null;   // onDidChangeTextEditorVisibleRanges subscription
let selectionSub   = null;   // onDidChangeTextEditorSelection subscription
let navHistory     = [];     // browsing history stack (fsPaths)
let navIndex       = -1;     // current position in navHistory
const navScrollMap = {};     // fsPath → saved scrollY for page navigation
let scrollLock     = false;  // prevents ping-pong between editor ↔ preview
let revealPending  = false;  // selection just changed — suppress syncScroll briefly
let revealPendingTimer = null;

function pushUpdate(panel, text, fsPath, restoreScrollY) {
  try {
    panel.webview.postMessage({
      type:     'update',
      html:     renderDoc(text, fsPath, panel.webview),
      filename: path.basename(fsPath),
      restoreScrollY: restoreScrollY,
    });
  } catch (_) { /* panel disposed */ }
}

function pushNavState(panel) {
  try {
    panel.webview.postMessage({
      type:    'navState',
      canPrev: navIndex > 0,
      canNext: navIndex < navHistory.length - 1,
    });
  } catch (_) { /* panel disposed */ }
}

// Push a new entry onto the history stack (clears forward history)
function navPush(fsPath) {
  if (navHistory[navIndex] === fsPath) return;   // same page, no-op
  navHistory = navHistory.slice(0, navIndex + 1); // drop forward history
  navHistory.push(fsPath);
  navIndex = navHistory.length - 1;
}

function attachEditorListeners(context) {
  // Dispose any previous subscriptions first
  editorSub  && editorSub.dispose();
  textSub    && textSub.dispose();
  scrollSub  && scrollSub.dispose();
  selectionSub && selectionSub.dispose();

  editorSub = vscode.window.onDidChangeActiveTextEditor(editor => {
    if (!previewPanel) return;
    if (!editor || editor.document.languageId !== 'markdown') return;
    const fsPath = editor.document.uri.fsPath;
    if (activeMarkdownPath === fsPath) return;  // same file, no change needed
    activeMarkdownPath = fsPath;
    previewPanel.title = 'Preview · ' + path.basename(fsPath);
    navPush(fsPath);
    pushUpdate(previewPanel, editor.document.getText(), fsPath);
    pushNavState(previewPanel);
  }, null, context.subscriptions);

  textSub = vscode.workspace.onDidChangeTextDocument(e => {
    if (!previewPanel) return;
    if (e.document.uri.fsPath !== activeMarkdownPath) return;
    pushUpdate(previewPanel, e.document.getText(), activeMarkdownPath);
  }, null, context.subscriptions);

  // Editor scroll → preview scroll
  scrollSub = vscode.window.onDidChangeTextEditorVisibleRanges(e => {
    if (!previewPanel) return;
    if (e.textEditor.document.uri.fsPath !== activeMarkdownPath) return;
    if (scrollLock) return;   // preview is driving, skip

    const lineCount = e.textEditor.document.lineCount;
    if (lineCount === 0) return;

    // Outline / command navigation: cursor is on a heading line.
    // Fire revealLine directly and suppress syncScroll so the preview
    // jumps to the heading rather than to an arbitrary ratio position.
    // This also handles the case where the cursor was ALREADY on the heading
    // (no selectionChange fires), e.g. clicking the same outline item twice.
    const cursorLine = e.textEditor.selection.active.line;
    const cursorText = e.textEditor.document.lineAt(cursorLine).text;
    const headingMatch = cursorText.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const topLine    = e.visibleRanges[0].start.line;
      const bottomLine = e.visibleRanges[0].end.line;
      const anchorRatio      = topLine / Math.max(lineCount - 1, 1);
      const visibleLineCount = Math.max(bottomLine - topLine, 1);
      const viewportFraction = Math.min((cursorLine - topLine) / visibleLineCount, 1);
      revealPending = true;
      clearTimeout(revealPendingTimer);
      revealPendingTimer = setTimeout(() => { revealPending = false; }, 500);
      try {
        previewPanel.webview.postMessage({
          type:             'revealLine',
          line:             cursorLine,
          lineText:         cursorText,
          anchorRatio,
          viewportFraction,
          headingText:      headingMatch[2],
          headingLevel:     headingMatch[1].length,
        });
      } catch (_) { /* panel disposed */ }
      return;
    }

    if (revealPending) return; // selection just changed — revealLine will handle scroll

    const topLine = e.visibleRanges[0].start.line;
    const ratio   = topLine / (lineCount - 1);
    try {
      previewPanel.webview.postMessage({ type: 'syncScroll', ratio });
    } catch (_) { /* panel disposed */ }
  }, null, context.subscriptions);

  // Editor cursor click → preview highlight + scroll to active line
  selectionSub = vscode.window.onDidChangeTextEditorSelection(e => {
    if (!previewPanel) return;
    if (e.textEditor.document.uri.fsPath !== activeMarkdownPath) return;
    const line     = e.selections[0].active.line;
    const lineText = e.textEditor.document.lineAt(line).text;

    // Heading: ## Title
    const headingMatch = lineText.match(/^(#{1,6})\s+(.+?)\s*$/);

    // Check if cursor is inside a fenced code block — links there are code, not content
    let inFence = false;
    if (!headingMatch) {
      const docText = e.textEditor.document.getText();
      const docLines = docText.split(/\n/);
      for (let l = 0; l < line; l++) {
        if (/^[ \t]*(`{3,}|~{3,})/.test(docLines[l])) inFence = !inFence;
      }
    }

    // Link line: markdown image  ![alt](...)
    //            markdown link   [text](...)   — covers .md / .html / download
    //            bare HTML tag with href/src   <a href=  <img src=
    const isLinkLine = !headingMatch && !inFence && (
      /!\[.*?\]\(.*?\)/.test(lineText) ||       // image
      /\[.*?\]\(.*?\)/.test(lineText)  ||       // any md link
      /<[a-z]+[^>]+(href|src)\s*=/i.test(lineText)  // raw HTML link/img
    );

    if (!headingMatch && !isLinkLine) return;   // nothing to sync

    const visibleRanges = e.textEditor.visibleRanges;
    const topLine    = visibleRanges[0].start.line;
    const bottomLine = visibleRanges[0].end.line;
    const lineCount  = e.textEditor.document.lineCount;
    const anchorRatio      = topLine / Math.max(lineCount - 1, 1);
    const visibleLineCount = Math.max(bottomLine - topLine, 1);
    // fraction 0 = top of editor viewport, 1 = bottom
    const viewportFraction = Math.min((line - topLine) / visibleLineCount, 1);

    revealPending = true;
    clearTimeout(revealPendingTimer);
    revealPendingTimer = setTimeout(() => { revealPending = false; }, 500);
    try {
      previewPanel.webview.postMessage({
        type:             'revealLine',
        line,
        lineText,
        anchorRatio,
        viewportFraction,
        headingText:  headingMatch ? headingMatch[2]         : null,
        headingLevel: headingMatch ? headingMatch[1].length  : null,
      });
    } catch (_) { /* panel disposed */ }
  }, null, context.subscriptions);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PDF generation via headless Edge / Chrome
// ─────────────────────────────────────────────────────────────────────────────
function findBrowser() {
  const fs = require('fs');
  const candidates = process.platform === 'win32'
    ? [
        process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

function generatePdf(html, pdfPath) {
  const fs = require('fs');
  const os = require('os');
  const { execFile } = require('child_process');

  const browserExe = findBrowser();
  if (!browserExe) {
    vscode.window.showErrorMessage('Nord Markdown: Could not find Edge or Chrome. Please install one to export PDF.');
    return;
  }

  // Write the HTML to a temp file for the browser to open
  const tmpHtml = path.join(os.tmpdir(), `nord-md-export-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const args = [
    '--headless',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--virtual-time-budget=5000',
    `--print-to-pdf=${pdfPath}`,
    tmpHtml,
  ];

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Exporting PDF…', cancellable: false },
    () => new Promise((resolve) => {
      execFile(browserExe, args, { timeout: 30000 }, (err) => {
        // Clean up temp file
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        if (err) {
          vscode.window.showErrorMessage('PDF export failed: ' + err.message);
        } else {
          vscode.window.showInformationMessage('Exported PDF: ' + path.basename(pdfPath));
        }
        resolve();
      });
    })
  );
}

function openSplitPreview(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('Nord Markdown: No active editor.'); return; }
  const doc = editor.document;
  if (doc.languageId !== 'markdown') { vscode.window.showWarningMessage('Nord Markdown: Not a Markdown file.'); return; }

  const fsPath = doc.uri.fsPath;

  // If the panel already exists just bring it to focus; the editor listener
  // will push a fresh update if the file differs.
  if (previewPanel) {
    previewPanel.reveal(vscode.ViewColumn.Beside, true);
    if (activeMarkdownPath !== fsPath) {
      activeMarkdownPath = fsPath;
      previewPanel.title = 'Preview · ' + path.basename(fsPath);
      pushUpdate(previewPanel, doc.getText(), fsPath);
    }
    return;
  }

  // Create the singleton panel
  activeMarkdownPath = fsPath;
  navHistory = [fsPath];
  navIndex   = 0;
  previewPanel = vscode.window.createWebviewPanel(
    'nordMarkdownPreview',
    'Preview · ' + path.basename(fsPath),
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts:           true,
      localResourceRoots:      getLocalRoots(context.extensionUri, fsPath),
      retainContextWhenHidden: true,
    }
  );

  previewPanel.webview.html = buildHtml({
    body:       renderDoc(doc.getText(), fsPath, previewPanel.webview),
    webview:    previewPanel.webview,
    extUri:     context.extensionUri,
    filename:   path.basename(fsPath),
    savedTheme: context.globalState.get('nordMarkdownTheme', 'dark'),
    savedColors: context.globalState.get('nordMarkdownColors', null),
  });

  previewPanel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'openUrl') {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    } else if (msg.type === 'openMdFile') {
      // Save current page scroll position before navigating
      if (msg.scrollY !== undefined && activeMarkdownPath) {
        navScrollMap[activeMarkdownPath] = msg.scrollY;
      }
      // Load the linked .md file and update the preview without opening the editor
      const uri = vscode.Uri.file(msg.path);
      vscode.workspace.openTextDocument(uri).then(doc => {
        if (!previewPanel) return;
        navPush(msg.path);
        activeMarkdownPath = msg.path;
        previewPanel.title = 'Preview · ' + path.basename(msg.path);
        pushUpdate(previewPanel, doc.getText(), msg.path);
        pushNavState(previewPanel);
      }, () => {
        vscode.window.showWarningMessage('Nord Markdown: Cannot open ' + msg.path);
      });
    } else if (msg.type === 'prevPage' || msg.type === 'nextPage') {
      const step = msg.type === 'prevPage' ? -1 : 1;
      const target = navIndex + step;
      if (target < 0 || target >= navHistory.length) return;
      // Save current page scroll position before navigating
      if (msg.scrollY !== undefined) {
        navScrollMap[navHistory[navIndex]] = msg.scrollY;
      }
      navIndex = target;
      const targetPath = navHistory[navIndex];
      const savedScroll = navScrollMap[targetPath];
      vscode.workspace.openTextDocument(vscode.Uri.file(targetPath)).then(doc => {
        if (!previewPanel) return;
        activeMarkdownPath = targetPath;
        previewPanel.title = 'Preview · ' + path.basename(targetPath);
        pushUpdate(previewPanel, doc.getText(), targetPath, savedScroll);
        pushNavState(previewPanel);
      }, () => {
        vscode.window.showWarningMessage('Nord Markdown: Cannot open ' + targetPath);
      });
    } else if (msg.type === 'openFile') {
      const uri = vscode.Uri.file(msg.path);
      vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One).then(
        undefined,
        err => vscode.window.showWarningMessage('Nord Markdown: Cannot open ' + msg.path)
      );
    } else if (msg.type === 'scrollSync') {
      // Preview is driving — move the editor without re-triggering the scroll listener
      const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.uri.fsPath === activeMarkdownPath
      );
      if (!editor) return;
      const lineCount = editor.document.lineCount;
      const line = Math.round(msg.ratio * (lineCount - 1));
      const pos  = new vscode.Position(line, 0);
      scrollLock = true;
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.AtTop
      );
      setTimeout(() => { scrollLock = false; }, 150);
    } else if (msg.type === 'themeChanged') {
      context.globalState.update('nordMarkdownTheme', msg.theme);
    } else if (msg.type === 'colorsChanged') {
      context.globalState.update('nordMarkdownColors', msg.colors);
    } else if (msg.type === 'exportHtml' || msg.type === 'exportPdf') {
      const fs  = require('fs');
      const isPdf = msg.type === 'exportPdf';
      const baseName = activeMarkdownPath
        ? path.basename(activeMarkdownPath, path.extname(activeMarkdownPath))
        : 'preview';

      // Read markdown.css so we can inline it into the exported file
      const cssPath = path.join(context.extensionPath, 'markdown.css');
      let cssContent = '';
      try { cssContent = fs.readFileSync(cssPath, 'utf8'); } catch (_) {}

      // Build a clean standalone HTML document from the webview content
      let html = msg.html || '';
      // Remove the toolbar, hover-zone, and settings overlay from the exported HTML.
      // Everything between <body> and <div class="vscode-body"> is toolbar UI.
      html = html.replace(/<body[^>]*>[\s\S]*?<div class="vscode-body">/g, '<body>\n<div class="vscode-body">');
      // Fallback: explicitly remove toolbar elements if the above regex didn't catch them
      html = html.replace(/<div class="nm-toolbar-hover-zone"><\/div>/gi, '');
      html = html.replace(/<div class="nm-toolbar">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
      html = html.replace(/<div class="nm-settings-overlay"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
      // Remove dynamically injected scrollbar-override styles
      html = html.replace(/<style[^>]*nm-scrollbar-override[^>]*>[\s\S]*?<\/style>/gi, '');
      // Remove webview-only scripts (everything inside <script> tags)
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
      // Remove video maximize buttons
      html = html.replace(/<div class="video-controls">[\s\S]*?<\/div>/gi, '');
      // Remove copy buttons from code blocks
      html = html.replace(/<button class="nm-copy-btn"[\s\S]*?<\/button>/gi, '');
      // Restore YouTube/Vimeo embed URLs from local server proxy
      html = html.replace(/http:\/\/127\.0\.0\.1:\d+\/yt\/([a-zA-Z0-9_-]+)/g,
        'https://www.youtube.com/embed/$1');
      html = html.replace(/http:\/\/127\.0\.0\.1:\d+\/vimeo\/(\d+)/g,
        'https://player.vimeo.com/video/$1');
      // Remove the CSP meta tag (not needed for standalone files)
      html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, '');
      if (isPdf) {
        // PDF: remove markdown.css entirely — print styles handle everything
        html = html.replace(/<link rel="stylesheet" href="[^"]*markdown\.css[^"]*">/g, '');
      } else {
        // HTML: inline markdown.css for full theme support
        html = html.replace(/<link rel="stylesheet" href="[^"]*markdown\.css[^"]*">/g,
          cssContent ? `<style>\n${cssContent}\n</style>` : '');
        // Hide toolbar/settings in exported HTML (in case any remnants survived)
        html = html.replace('</head>',
          '<style>.nm-toolbar,.nm-toolbar-hover-zone,.nm-settings-overlay{display:none!important}</style>\n</head>');
        // Inject copy button script for exported HTML
        const copyBtnScript = `<script>
(function(){
  var svgCopy='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var svgCheck='<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  document.querySelectorAll('pre').forEach(function(pre){
    if(pre.querySelector('.nm-copy-btn')) return;
    var btn=document.createElement('button');
    btn.className='nm-copy-btn';
    btn.title='Copy';
    btn.innerHTML=svgCopy;
    btn.addEventListener('click',function(){
      var code=pre.querySelector('code');
      var text=code?code.innerText:pre.innerText;
      navigator.clipboard.writeText(text).then(function(){
        btn.innerHTML=svgCheck;
        btn.title='Copied!';
        btn.classList.add('nm-copied');
        setTimeout(function(){btn.innerHTML=svgCopy;btn.title='Copy';btn.classList.remove('nm-copied');},2000);
      });
    });
    pre.appendChild(btn);
  });
  document.querySelectorAll('.nm-copy-btn').forEach(function(btn){
    if(btn.dataset.wired) return;
    btn.dataset.wired='1';
    btn.addEventListener('click',function(){
      var pre=btn.closest('pre');
      if(!pre) return;
      var code=pre.querySelector('code');
      var text=code?code.innerText:pre.innerText;
      navigator.clipboard.writeText(text).then(function(){
        btn.innerHTML=svgCheck;
        btn.title='Copied!';
        btn.classList.add('nm-copied');
        setTimeout(function(){btn.innerHTML=svgCopy;btn.title='Copy';btn.classList.remove('nm-copied');},2000);
      });
    });
  });
})();
</script>`;
        html = html.replace('</body>', copyBtnScript + '\n</body>');
      }
      // Restore clickable links: external URLs (shared by both formats)
      html = html.replace(/<a\b([^>]*)\bdata-md-url="([^"]*)"([^>]*)>/gi,
        (match, before, url, after) => {
          let attrs = before + after;
          attrs = attrs.replace(/\bhref=(["'])[^"']*\1/i, `href="${url}"`);
          return `<a${attrs} target="_blank">`;
        });

      // Restore local file/md links — needs save location for relative paths (HTML)
      // so we define a helper and call it at the right time per format.
      function restoreLocalLinks(h, saveDir) {
        // data-file-path → href
        h = h.replace(/<a\b([^>]*)\bdata-file-path="([^"]*)"([^>]*)>/gi,
          (match, before, fsPath, after) => {
            let href;
            if (saveDir) {
              href = path.relative(saveDir, fsPath).replace(/\\/g, '/');
            } else {
              href = 'file:///' + fsPath.replace(/\\/g, '/').replace(/ /g, '%20');
            }
            let attrs = before + after;
            attrs = attrs.replace(/\bhref=(["'])[^"']*\1/i, `href="${href}"`);
            return `<a${attrs}>`;
          });
        // data-md-path → href
        h = h.replace(/<a\b([^>]*)\bdata-md-path="([^"]*)"([^>]*)>/gi,
          (match, before, fsPath, after) => {
            let href;
            if (saveDir) {
              href = path.relative(saveDir, fsPath).replace(/\\/g, '/');
            } else {
              href = 'file:///' + fsPath.replace(/\\/g, '/').replace(/ /g, '%20');
            }
            let attrs = before + after;
            attrs = attrs.replace(/\bhref=(["'])[^"']*\1/i, `href="${href}"`);
            return `<a${attrs}>`;
          });
        return h;
      }

      // Rewrite vscode webview resource URLs back to local paths
      // Pattern: https://file+.vscode-resource.vscode-cdn.net/<encoded-path>
      //      or: https://<id>.vscode-webview-resource.vscode-cdn.net/<encoded-path>
      function rewriteResourceUrls(h, saveDir) {
        return h.replace(
          /https?:\/\/[^"'\s]*?vscode-(?:resource|webview-resource)[^"'\s]*?\.(?:vscode-cdn\.net|vscode-cdn\.net)\/([^"'\s]+)/gi,
          (match, encodedPath) => {
            try {
              // Decode the path: %3A → :, %20 → space, etc.
              let fsPath = decodeURIComponent(encodedPath);
              // The path often starts with /d%3A/ or /d:/ — normalise drive letter
              if (/^\/[a-zA-Z]:/.test(fsPath)) {
                fsPath = fsPath.slice(1); // remove leading /
              }
              if (saveDir) {
                return path.relative(saveDir, fsPath).replace(/\\/g, '/');
              }
              return 'file:///' + fsPath.replace(/\\/g, '/').replace(/ /g, '%20');
            } catch { return match; }
          }
        );
      }

      // Wrap in proper doctype if missing
      if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }

      if (isPdf) {
        // Force light theme for PDF: add nm-light class to <body>
        html = html.replace(/<body[^>]*>/, '<body class="nm-light">');

        // Inject print-friendly styles (light bg, no front-matter, clean layout)
        const printStyles = `<style>
  @page { margin: 15mm 10mm; }
  .nm-toolbar, .nm-toolbar-hover-zone, .nm-settings-overlay { display: none !important; }
  html, body, body.nm-light { background: #ffffff !important; color: #000000 !important; }
  .fm-block { display: none !important; }
  body.nm-light .vscode-body { max-width: none !important; padding: 10px 0 !important; background: #ffffff !important; color: #000000 !important; }
  /* Force all text to black — except mermaid, admonition titles, and md-buttons */
  body.nm-light .vscode-body *:not(.mermaid *):not(.admonition-title):not(.admonition-title *):not(.md-button):not(.md-button *),
  body.nm-light .vscode-body *:not(.mermaid *):not(.admonition-title):not(.admonition-title *):not(.md-button):not(.md-button *)::before,
  body.nm-light .vscode-body *:not(.mermaid *):not(.admonition-title):not(.admonition-title *):not(.md-button):not(.md-button *)::after { color: #000000 !important; }
  body.nm-light .vscode-body a.md-button.md-button--primary { color: #eceff4 !important; }
  body.nm-light .vscode-body a.md-button:not(.md-button--primary) { color: #88c0d0 !important; }
  /* Clickable links — blue + underline */
  body.nm-light .vscode-body a[href^="http"],
  body.nm-light .vscode-body a[href^="file:"] {
    color: #1a0dab !important; text-decoration: underline !important;
    pointer-events: auto !important; cursor: pointer !important;
  }
  /* Neutral backgrounds */
  body.nm-light .vscode-body code,
  body.nm-light .vscode-body pre,
  body.nm-light .vscode-body pre.hljs,
  body.nm-light .vscode-body pre.hljs code { background-color: #f5f5f5 !important; }
  body.nm-light .vscode-body table thead tr { background-color: #e8e8e8 !important; }
  body.nm-light .vscode-body table tbody tr { background-color: #ffffff !important; }
  body.nm-light .vscode-body table tbody tr:nth-child(even) { background-color: #f5f5f5 !important; }
  body.nm-light .vscode-body table th,
  body.nm-light .vscode-body table td { border-color: #ccc !important; }
  body.nm-light .vscode-body mark,
  body.nm-light .vscode-body mark * { background-color: #ff0 !important; }
  .admonition, details.admonition { margin-top: 20px !important; break-inside: avoid !important; border-radius: 4px !important; overflow: hidden !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .admonition-title, details.admonition > summary.admonition-title { break-after: avoid !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .admonition-body { background: transparent !important; }
  /* Per-type admonition borders (markdown.css is removed for PDF, so re-declare here) */
  .admonition-note                              { border: 2px solid #448aff !important; }
  .admonition-note .admonition-title            { background: rgba(68,138,255,0.15) !important; color: #448aff !important; border-bottom: 2px solid #448aff !important; }
  .admonition-abstract,.admonition-summary,.admonition-tldr { border: 2px solid #00b0ff !important; }
  .admonition-abstract .admonition-title,
  .admonition-summary  .admonition-title,
  .admonition-tldr     .admonition-title        { background: rgba(0,176,255,0.15) !important; color: #00b0ff !important; border-bottom: 2px solid #00b0ff !important; }
  .admonition-info,.admonition-todo             { border: 2px solid #00b8d4 !important; }
  .admonition-info .admonition-title,
  .admonition-todo .admonition-title            { background: rgba(0,184,212,0.15) !important; color: #00b8d4 !important; border-bottom: 2px solid #00b8d4 !important; }
  .admonition-tip,.admonition-hint,.admonition-important { border: 2px solid #00bfa5 !important; }
  .admonition-tip       .admonition-title,
  .admonition-hint      .admonition-title,
  .admonition-important .admonition-title       { background: rgba(0,191,165,0.15) !important; color: #00bfa5 !important; border-bottom: 2px solid #00bfa5 !important; }
  .admonition-success,.admonition-check,.admonition-done { border: 2px solid #00c853 !important; }
  .admonition-success .admonition-title,
  .admonition-check   .admonition-title,
  .admonition-done    .admonition-title         { background: rgba(0,200,83,0.15) !important; color: #00c853 !important; border-bottom: 2px solid #00c853 !important; }
  .admonition-question,.admonition-help,.admonition-faq { border: 2px solid #64dd17 !important; }
  .admonition-question .admonition-title,
  .admonition-help     .admonition-title,
  .admonition-faq      .admonition-title        { background: rgba(100,221,23,0.15) !important; color: #64dd17 !important; border-bottom: 2px solid #64dd17 !important; }
  .admonition-warning,.admonition-caution,.admonition-attention { border: 2px solid #ff9100 !important; }
  .admonition-warning   .admonition-title,
  .admonition-caution   .admonition-title,
  .admonition-attention .admonition-title       { background: rgba(255,145,0,0.15) !important; color: #ff9100 !important; border-bottom: 2px solid #ff9100 !important; }
  .admonition-failure,.admonition-fail,.admonition-missing { border: 2px solid #ff5252 !important; }
  .admonition-failure .admonition-title,
  .admonition-fail    .admonition-title,
  .admonition-missing .admonition-title         { background: rgba(255,82,82,0.15) !important; color: #ff5252 !important; border-bottom: 2px solid #ff5252 !important; }
  .admonition-danger,.admonition-error          { border: 2px solid #ff1744 !important; }
  .admonition-danger .admonition-title,
  .admonition-error  .admonition-title          { background: rgba(255,23,68,0.15) !important; color: #ff1744 !important; border-bottom: 2px solid #ff1744 !important; }
  .admonition-bug                               { border: 2px solid #f50057 !important; }
  .admonition-bug .admonition-title             { background: rgba(245,0,87,0.15) !important; color: #f50057 !important; border-bottom: 2px solid #f50057 !important; }
  .admonition-example                           { border: 2px solid #7c4dff !important; }
  .admonition-example .admonition-title         { background: rgba(124,77,255,0.15) !important; color: #7c4dff !important; border-bottom: 2px solid #7c4dff !important; }
  .admonition-quote,.admonition-cite            { border: 2px solid #9e9e9e !important; }
  .admonition-quote .admonition-title,
  .admonition-cite  .admonition-title           { background: rgba(158,158,158,0.15) !important; color: #9e9e9e !important; border-bottom: 2px solid #9e9e9e !important; }
</style>`;
        html = html.replace('</head>', printStyles + '\n</head>');

        // Inject mermaid re-render script with light theme vars for PDF
        const pdfMermaidScript = `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
var lightVars = {
  background:'#ffffff', primaryColor:'#6b91f6', primaryTextColor:'#2e3440',
  primaryBorderColor:'#3d6ee8', lineColor:'#5281ac', secondaryColor:'#9c5bcc',
  tertiaryColor:'#2d9e74', edgeLabelBackground:'#f0f4ff', nodeBorder:'#3d6ee8',
  clusterBkg:'#eef2ff', clusterBorder:'#a0b4f4', titleColor:'#2e3440', edgeColor:'#5281ac',
  cScale0:'#6b91f6',cScale1:'#9c5bcc',cScale2:'#2d9e74',cScale3:'#e8883c',
  cScale4:'#e04848',cScale5:'#3cace8',cScale6:'#c8a820',cScale7:'#cc3d6e',
  cScale8:'#5c9ee8',cScale9:'#5a9e58',cScale10:'#c8622c',cScale11:'#3d8c8c'
};
mermaid.initialize({ startOnLoad:false, theme:'base', themeVariables: lightVars });
var els = document.querySelectorAll('.mermaid');
for (var el of els) {
  var src = el.getAttribute('data-mermaid-src') || el.textContent;
  el.setAttribute('data-mermaid-src', src);
  el.removeAttribute('data-processed');
  el.textContent = src;
}
if (els.length) await mermaid.run({ nodes: Array.from(els) });
<\/script>`;
        html = html.replace('</body>', pdfMermaidScript + '\n</body>');

        // Restore local links with absolute file:/// URLs for PDF
        html = restoreLocalLinks(html, null);
        html = rewriteResourceUrls(html, null);

        // Show save dialog for the real PDF file
        const pdfDefaultUri = activeMarkdownPath
          ? vscode.Uri.file(path.join(path.dirname(activeMarkdownPath), baseName + '.pdf'))
          : undefined;
        vscode.window.showSaveDialog({
          defaultUri: pdfDefaultUri,
          filters: { 'PDF Files': ['pdf'] },
        }).then(uri => {
          if (!uri) return;
          generatePdf(html, uri.fsPath);
        });
      } else {
        // Inject a floating theme toggle button and script for standalone HTML
        const themeToggleStyle = `<style>
  .nm-theme-toggle {
    position: fixed; top: 16px; right: 16px; z-index: 1000;
    width: 36px; height: 36px; border-radius: 50%; border: 1px solid #3b4252;
    background: #2e3440; color: #a8cbaf; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.3); transition: background .2s, color .2s, border-color .2s;
  }
  .nm-theme-toggle:hover { background: #3b4252; }
  .nm-theme-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  body.nm-light .nm-theme-toggle {
    background: #e8eaf0; color: #2e3440; border-color: #c8cdd8;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  body.nm-light .nm-theme-toggle:hover { background: #dde0e8; }
  @media print { .nm-theme-toggle { display: none !important; } }
  /* Re-enable all links in exported HTML */
  .vscode-body a:not([href="#"]) {
    pointer-events: auto !important; cursor: pointer !important;
    text-decoration: underline !important;
  }
</style>`;
        const themeToggleHtml = `<button class="nm-theme-toggle" id="nmThemeToggle" title="Toggle light/dark theme"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>`;
        const exportScripts = `<script type="module">
// ── Mermaid rendering with theme support ──
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
var darkVars = {
  background:'#1e2128', primaryColor:'#5482ec', primaryTextColor:'#eceff4',
  primaryBorderColor:'#7c9ef7', lineColor:'#88c0d0', secondaryColor:'#b48ead',
  tertiaryColor:'#a3be8c', edgeLabelBackground:'#2e3440', nodeBorder:'#4c566a',
  clusterBkg:'#2e3440', clusterBorder:'#4c566a', titleColor:'#eceff4', edgeColor:'#88c0d0',
  cScale0:'#7b9cf7',cScale1:'#bf6ade',cScale2:'#3dba8a',cScale3:'#f4a45e',
  cScale4:'#f4605e',cScale5:'#5ec8f4',cScale6:'#ebcb8b',cScale7:'#e05e8b',
  cScale8:'#7cb8f4',cScale9:'#a3be8c',cScale10:'#d08770',cScale11:'#8fbcbb'
};
var lightVars = {
  background:'#ffffff', primaryColor:'#6b91f6', primaryTextColor:'#2e3440',
  primaryBorderColor:'#3d6ee8', lineColor:'#5281ac', secondaryColor:'#9c5bcc',
  tertiaryColor:'#2d9e74', edgeLabelBackground:'#f0f4ff', nodeBorder:'#3d6ee8',
  clusterBkg:'#eef2ff', clusterBorder:'#a0b4f4', titleColor:'#2e3440', edgeColor:'#5281ac',
  cScale0:'#6b91f6',cScale1:'#9c5bcc',cScale2:'#2d9e74',cScale3:'#e8883c',
  cScale4:'#e04848',cScale5:'#3cace8',cScale6:'#c8a820',cScale7:'#cc3d6e',
  cScale8:'#5c9ee8',cScale9:'#5a9e58',cScale10:'#c8622c',cScale11:'#3d8c8c'
};
function isDark() { return !document.body.classList.contains('nm-light'); }
async function renderMermaid() {
  var els = document.querySelectorAll('.mermaid');
  if (!els.length) return;
  mermaid.initialize({ startOnLoad:false, theme:'base', themeVariables: isDark() ? darkVars : lightVars });
  for (var el of els) {
    var src = el.getAttribute('data-mermaid-src') || el.textContent;
    el.setAttribute('data-mermaid-src', src);
    el.removeAttribute('data-processed');
    el.textContent = src;
  }
  await mermaid.run({ nodes: Array.from(els) });
}
window.__renderMermaid = renderMermaid;
renderMermaid();

// ── Theme toggle ──
var themeBtn = document.getElementById('nmThemeToggle');
var saved = localStorage.getItem('nm-theme');
if (saved === 'light') document.body.classList.add('nm-light');
else if (saved === 'dark') document.body.classList.remove('nm-light');
if (saved) renderMermaid();
themeBtn.addEventListener('click', async function(){
  var scrollY = window.scrollY;
  document.body.classList.toggle('nm-light');
  localStorage.setItem('nm-theme', document.body.classList.contains('nm-light') ? 'light' : 'dark');
  await renderMermaid();
  window.scrollTo(0, scrollY);
});

// ── Tab switching ──
function activateTab(btn) {
  var bar = btn.closest('.tab-bar');
  var group = btn.closest('.tab-group');
  if (!bar || !group) return;
  bar.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  var targetId = btn.getAttribute('data-tab');
  group.querySelectorAll('.tab-panel').forEach(function(p){ p.hidden = (p.id !== targetId); });
}
document.querySelectorAll('.tab-group').forEach(function(group){
  var firstBtn = group.querySelector('.tab-btn');
  if (firstBtn) activateTab(firstBtn);
});
document.addEventListener('click', function(e){
  var btn = e.target.closest('.tab-btn');
  if (btn) activateTab(btn);
});
<\/script>`;
        html = html.replace('</head>', themeToggleStyle + '\n</head>');
        html = html.replace(/<body>/, '<body>\n' + themeToggleHtml);
        html = html.replace('</body>', exportScripts + '\n</body>');

        const defaultUri = activeMarkdownPath
          ? vscode.Uri.file(path.join(path.dirname(activeMarkdownPath), baseName + '.html'))
          : undefined;
        vscode.window.showSaveDialog({
          defaultUri,
          filters: { 'HTML Files': ['html', 'htm'] },
        }).then(uri => {
          if (!uri) return;
          // Restore local links and media src with relative paths from the saved file's directory
          const saveDir = path.dirname(uri.fsPath);
          let finalHtml = restoreLocalLinks(html, saveDir);
          finalHtml = rewriteResourceUrls(finalHtml, saveDir);
          fs.writeFileSync(uri.fsPath, finalHtml, 'utf8');
          vscode.window.showInformationMessage('Exported HTML: ' + path.basename(uri.fsPath));
        });
      }
    }
  });

  previewPanel.onDidDispose(() => {
    previewPanel       = null;
    activeMarkdownPath = null;
    navHistory         = [];
    navIndex           = -1;
    scrollLock         = false;
  });

  attachEditorListeners(context);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lifecycle
// ─────────────────────────────────────────────────────────────────────────────
function activate(context) {
  // Start the local video proxy server so YouTube/Vimeo embeds can play inline
  startVideoServer().catch(err => console.warn('Nord Markdown: video server failed to start:', err));

  context.subscriptions.push(
    vscode.commands.registerCommand('nordMarkdown.openPreview', () => openSplitPreview(context))
  );
}

function deactivate() { stopVideoServer(); }
module.exports = { activate, deactivate };
