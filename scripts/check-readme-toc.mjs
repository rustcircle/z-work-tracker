// Checks the table of contents of README.md (or the Markdown file named as the first argument). The table is the list
// under the "Contents" heading. Every link in it must lead to a heading, and every top-level (#) and second-level (##)
// heading must be linked from it, apart from the Contents heading itself. Anchors are worked out as GitHub does:
// lowercase, punctuation removed except hyphens, underscores and spaces, spaces turned into hyphens, and a repeated
// anchor numbered -1, -2 and so on in document order, counting headings of every level. Lines inside fenced code blocks
// are not headings. Exits 1 and names each problem when the table and the headings disagree.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOC_TITLE = 'Contents';

/** The visible text of a heading: link targets, inline HTML and emphasis marks are not part of it. */
function headingText(raw) {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

/** GitHub's anchor for a heading's text, before a repeat is numbered. */
export function slugOf(text) {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Every ATX heading outside fenced code: { level, text, slug, line }, with repeats numbered as GitHub numbers them. */
export function headingsOf(markdown) {
  const seen = new Map();
  const out = [];
  let fence = null;
  markdown.split(/\r?\n/).forEach((line, i) => {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      const mark = opener[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
    if (!m) return;
    const text = headingText(m[2]);
    const base = slugOf(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({ level: m[1].length, text, slug: count === 0 ? base : `${base}-${count}`, line: i + 1 });
  });
  return out;
}

/** The in-page links of the Contents section: { text, anchor, line }. Empty when there is no such section. */
export function tocLinksOf(markdown, headings = headingsOf(markdown)) {
  const toc = headings.find((h) => h.text === TOC_TITLE);
  if (!toc) return [];
  const next = headings.find((h) => h.line > toc.line);
  const lines = markdown.split(/\r?\n/).slice(toc.line, next ? next.line - 1 : undefined);
  const links = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\[([^\]]+)\]\(#([^)\s]*)\)/g)) links.push({ text: m[1], anchor: m[2], line: toc.line + i + 1 });
  });
  return links;
}

/** What is wrong with the table of contents, one line each; empty when nothing is. */
export function problemsOf(markdown) {
  const headings = headingsOf(markdown);
  const toc = headings.find((h) => h.text === TOC_TITLE);
  if (!toc) return [`No "${TOC_TITLE}" heading, so there is no table of contents to check.`];
  const links = tocLinksOf(markdown, headings);
  if (links.length === 0) return [`The "${TOC_TITLE}" section (line ${toc.line}) has no links.`];
  const anchors = new Set(headings.map((h) => h.slug));
  const linked = new Set(links.map((l) => l.anchor));
  const problems = [];
  for (const l of links) {
    if (!anchors.has(l.anchor)) problems.push(`Line ${l.line}: the link "${l.text}" goes to #${l.anchor}, and no heading has that anchor.`);
  }
  for (const h of headings) {
    if (h.level > 2 || h === toc) continue;
    if (!linked.has(h.slug)) problems.push(`Line ${h.line}: the heading "${h.text}" (#${h.slug}) is missing from the table of contents.`);
  }
  return problems;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2] ?? resolve(here, '..', 'README.md'));
  const problems = problemsOf(readFileSync(file, 'utf8'));
  if (problems.length > 0) {
    console.error(`${file}: the table of contents doesn't match the headings.`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`${file}: the table of contents matches every # and ## heading.`);
}
