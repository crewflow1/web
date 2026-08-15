import type { ReactNode } from "react";
import Link from "next/link";

/**
 * A minimal, XSS-safe Markdown renderer for help-article bodies.
 *
 * WHY A BESPOKE RENDERER
 * ----------------------
 * The repo ships no Markdown library, and help bodies only need a small,
 * predictable subset (headings, paragraphs, lists, links, emphasis, code,
 * blockquotes, rules). Rather than pull in react-markdown + rehype-sanitize we
 * parse that subset into REACT ELEMENTS directly.
 *
 * SAFETY MODEL — no HTML injection, ever
 * --------------------------------------
 * This renderer NEVER uses `dangerouslySetInnerHTML`. Output is React elements
 * whose text children are escaped by React itself, so any raw HTML in the source
 * (`<script>`, `<img onerror=…>`, `<iframe>`) renders as literal, inert text.
 * The only attribute we ever set from source content is a link `href`, and that
 * is passed through {@link safeHref}, which permits only http/https/mailto and
 * in-app (`/…`) targets — a `javascript:` or `data:` URL is dropped, rendering
 * the link as plain text. There is therefore no path from article content to
 * executable markup or a dangerous navigation.
 */

/** Allow only safe link targets; anything else returns null (render as text). */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href.length === 0) return null;
  // In-app absolute path or fragment/anchor — always safe.
  if (href.startsWith("/") || href.startsWith("#")) return href;
  // Reject whitespace / control characters that could obfuscate a scheme
  // (e.g. a tab inside "java<tab>script:"). \p{Cc} is the control-char class
  // (see lib/search/sanitize.ts) — avoids ESLint's no-control-regex rule.
  if (/\s/.test(href) || /\p{Cc}/u.test(href)) return null;
  const lower = href.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return href;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing: bold, italic, inline code, links. Order matters — code spans
// are extracted first so their contents are treated literally.
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let i = 0;

  // Pattern union; the first matching group decides how to render the token.
  //  1: `code`   2: **bold**   3: *italic* or _italic_   4: [label](href)
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/;

  while (remaining.length > 0) {
    const m = pattern.exec(remaining);
    if (!m || m.index === undefined) {
      nodes.push(remaining);
      break;
    }
    if (m.index > 0) nodes.push(remaining.slice(0, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;

    if (m[1]) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-slate-100 px-1 py-0.5 text-[0.85em] font-mono text-slate-800"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (m[3]) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (m[4]) {
      const split = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = split?.[1] ?? token;
      const href = split?.[2] ? safeHref(split[2]) : null;
      if (href === null) {
        // Unsafe or malformed link → render the label as plain text.
        nodes.push(label);
      } else if (href.startsWith("/") || href.startsWith("#")) {
        nodes.push(
          <Link
            key={key}
            href={href}
            className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
          >
            {label}
          </Link>,
        );
      } else {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
          >
            {label}
          </a>,
        );
      }
    }
    remaining = remaining.slice(m.index + token.length);
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing: split the body into headings, lists, code fences, quotes,
// rules, and paragraphs, then render each block.
// ---------------------------------------------------------------------------

const RE_FENCE = /^```/;
const RE_HEADING = /^(#{1,3})\s+(.*)$/;
const RE_RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const RE_QUOTE = /^>\s?/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+\.\s+/;

/** Render Markdown text to a safe React tree (no dangerouslySetInnerHTML). */
export function renderMarkdown(markdown: string): ReactNode {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;
  const at = (n: number): string => lines[n] ?? "";

  while (i < lines.length) {
    const line = at(i);

    // Blank line — skip.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block ```
    if (RE_FENCE.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(at(i).trim())) {
        buf.push(at(i));
        i++;
      }
      i++; // consume closing fence (or run off the end)
      blocks.push(
        <pre
          key={`b${key++}`}
          className="my-3 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading (# .. ###)
    const heading = RE_HEADING.exec(line);
    if (heading) {
      const depth = (heading[1] ?? "").length;
      const content = renderInline((heading[2] ?? "").trim(), `h${key}`);
      if (depth === 1) {
        blocks.push(
          <h2 key={`b${key++}`} className="mt-6 mb-2 text-xl font-bold text-slate-900">
            {content}
          </h2>,
        );
      } else if (depth === 2) {
        blocks.push(
          <h3 key={`b${key++}`} className="mt-5 mb-2 text-lg font-semibold text-slate-900">
            {content}
          </h3>,
        );
      } else {
        blocks.push(
          <h4 key={`b${key++}`} className="mt-4 mb-1 text-base font-semibold text-slate-900">
            {content}
          </h4>,
        );
      }
      i++;
      continue;
    }

    // Horizontal rule
    if (RE_RULE.test(line.trim())) {
      blocks.push(<hr key={`b${key++}`} className="my-5 border-slate-200" />);
      i++;
      continue;
    }

    // Blockquote (one or more consecutive `>` lines)
    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(at(i))) {
        buf.push(at(i).replace(RE_QUOTE, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          className="my-3 border-l-4 border-slate-300 pl-4 text-slate-600 italic"
        >
          {renderInline(buf.join(" "), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list (-, *, +)
    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(at(i))) {
        items.push(at(i).replace(RE_UL, ""));
        i++;
      }
      blocks.push(
        <ul key={`b${key++}`} className="my-3 list-disc space-y-1 pl-6 text-slate-700">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `ul${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list (1. 2. …)
    if (RE_OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_OL.test(at(i))) {
        items.push(at(i).replace(RE_OL, ""));
        i++;
      }
      blocks.push(
        <ol key={`b${key++}`} className="my-3 list-decimal space-y-1 pl-6 text-slate-700">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `ol${key}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = at(i);
      if (
        cur.trim() === "" ||
        RE_FENCE.test(cur.trim()) ||
        RE_HEADING.test(cur) ||
        RE_UL.test(cur) ||
        RE_OL.test(cur) ||
        RE_QUOTE.test(cur) ||
        RE_RULE.test(cur.trim())
      ) {
        break;
      }
      para.push(cur.trim());
      i++;
    }
    blocks.push(
      <p key={`b${key++}`} className="my-3 leading-relaxed text-slate-700">
        {renderInline(para.join(" "), `p${key}`)}
      </p>,
    );
  }

  return blocks;
}
