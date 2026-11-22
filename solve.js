// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build() returns for
// the same input: the output tree (path -> text), byte for byte. A clean-room
// reimplementation of its semantics, written for speed:
//
//   - Markdown renders in one pass, straight into an output array. Inline
//     spans are found by a regex scan for the next special character, so
//     plain prose is escaped in bulk instead of char by char; nested spans
//     render over ranges of the same string, never sliced copies.
//   - Templates are parsed once per case and rendered by a tight
//     interpreter over a flattened scope (one object, save/restore around
//     for-loops), with single- and two-segment lookups inlined.
//   - slugify takes an ASCII fast path and is memoised per case; front
//     matter is scanned without splitting the whole body; word counts are
//     counted by one scan without a regex match array.
//
// Nothing is cached from one case to the next: every run(input) builds its
// own memo tables and parses its own templates. No clock, no environment,
// no randomness, no I/O.

const hasOwn = Object.hasOwn;

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --------------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The combining-mark class the reference drops after NFKD. */
const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`, exactly as the reference's slugify: NFKD, combining
 * marks dropped, A-Z lowered, each run of characters other than a-z and 0-9
 * one "-", none at either end, at most 64 characters (a "-" left at the cut
 * dropped), "untitled" when nothing is left. Pure ASCII text is unchanged by
 * NFKD and holds no combining marks, so it takes the short loop.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A memoised slugify (per case). */
function memoSlug(memo, text) {
  let s = memo.get(text);
  if (s === undefined) { s = slugify(text); memo.set(text, s); }
  return s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The common case is ASCII whitespace; the rest is JavaScript's \s.
    const ws = c < 128
      ? c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
      : c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
        c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// --------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z or _
}

/**
 * A source's front matter and body: { data, body }, or { error }. The body
 * is the text after the closing line, without splitting the whole file.
 * The line grammar is the reference's /^([a-z_]+):(?: (.*))?$/: the key is
 * the run of a-z and _ up to the colon, and the value is what follows one
 * space after it (or nothing, when the line ends or the next character is
 * not a space — then the key has no value).
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line: a line exactly "---". Search for "\n---" followed by
  // end of text or "\n".
  let closeAt = -1;
  let searchFrom = 3;
  while (true) {
    const nl = text.indexOf('\n---', searchFrom);
    if (nl === -1) break;
    const after = nl + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { closeAt = nl; break; }
    searchFrom = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmEnd = closeAt; // the "\n" ending the last front-matter line
  let pos = 4; // after "---\n"
  let lineNo = 1; // counted from 1 at the opening "---"
  while (pos <= fmEnd) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1 || eol > fmEnd) eol = fmEnd;
    const line = text.slice(pos, eol);
    lineNo++;
    pos = eol + 1;
    if (line === '') continue;
    let onlyWs = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { onlyWs = false; break; }
    }
    if (onlyWs || line.charCodeAt(0) === 35) continue; // blank or comment (# first)
    let ki = 0;
    while (ki < line.length && isKeyChar(line.charCodeAt(ki))) ki++;
    if (ki === 0 || ki >= line.length || line.charCodeAt(ki) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, ki);
    const after = line.slice(ki + 1);
    let raw;
    if (after === '') raw = '';
    else if (after.charCodeAt(0) === 32) raw = after.slice(1);
    else raw = '';
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    raw = raw.slice(0, end);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = closeAt + 4 >= text.length ? text.length : closeAt + 5;
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------------ markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPECIAL_RE = /[\\`*[]/g;
const WS_RE = /\s/;
const CONTINUED_RE = /^ {2,}\S/;

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline, appended to `out`; `env.link(target)` is a
 * link's href. A range-based port of the reference's inline(): the next
 * special character is found by a regex scan, so plain runs are escaped in
 * bulk and nested spans recurse over ranges, never slices. Every path sets
 * SPECIAL_RE.lastIndex before the next scan, so the shared regex stays
 * correct across the recursion.
 */
function inlineRange(s, a, b, out, env) {
  let i = a;
  let run = a;
  SPECIAL_RE.lastIndex = a;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null && m.index < b) {
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        if (j > run) out.push(escapeHtml(s.slice(run, j)));
        out.push(escapeHtml(s[j + 1]));
        i = j + 2;
        run = i;
        SPECIAL_RE.lastIndex = i;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > run) out.push(escapeHtml(s.slice(run, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        run = i;
        SPECIAL_RE.lastIndex = i;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          if (j > run) out.push(escapeHtml(s.slice(run, j)));
          out.push('<strong>');
          inlineRange(s, j + 2, k, out, env);
          out.push('</strong>');
          i = k + 2;
          run = i;
          SPECIAL_RE.lastIndex = i;
        } else {
          SPECIAL_RE.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k > j + 1) {
        if (j > run) out.push(escapeHtml(s.slice(run, j)));
        out.push('<em>');
        inlineRange(s, j + 1, k, out, env);
        out.push('</em>');
        i = k + 1;
        run = i;
        SPECIAL_RE.lastIndex = i;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    // '[': a link, or a literal '['.
    const k = findUnescaped(s, ']', j + 1, b);
    let r = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
      const q = s.indexOf(')', k + 2);
      if (q !== -1 && q < b) r = q;
    }
    const target = r === -1 ? '' : s.slice(k + 2, r);
    if (target !== '' && !WS_RE.test(target)) {
      if (j > run) out.push(escapeHtml(s.slice(run, j)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, j + 1, k, out, env);
      out.push('</a>');
      i = r + 1;
      run = i;
      SPECIAL_RE.lastIndex = i;
    } else {
      SPECIAL_RE.lastIndex = j + 1;
    }
  }
  if (b > run) out.push(escapeHtml(s.slice(run, b)));
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  // Only a blank, fence, heading or hr line ends a paragraph, and those all
  // open on a space, tab, '#', '`', '-' or '*'.
  if (c0 !== 32 && c0 !== 9 && c0 !== 35 && c0 !== 96 && c0 !== 45 && c0 !== 42) return false;
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** An ordered-list line's start number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '.' then ' '
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or ""). A single pass
 * over the lines, writing straight to the output array.
 */
function renderMarkdown(src, env, slugMemo) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
      // A non-blank indented line is paragraph text: no block opens on a space.
    } else if (c0 === 35) { // '#'
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(memoSlug(slugMemo, h.text), ids);
        if (h.depth === 2 || h.depth === 3) {
          const tmp = [];
          inlineRange(h.text, 0, h.text.length, tmp, env);
          const inner = tmp.join('');
          out.push(`<h${h.depth} id="${id}">`, inner, `</h${h.depth}>\n`);
          toc.push({ level: h.depth, id, html: inner });
        } else {
          out.push(`<h${h.depth} id="${id}">`);
          inlineRange(h.text, 0, h.text.length, out, env);
          out.push(`</h${h.depth}>\n`);
        }
        i++;
        continue;
      }
    } else if (c0 === 96) { // '`'
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code');
        if (lang !== '') out.push(' class="language-', escapeHtml(lang), '"');
        out.push('>');
        if (body.length > 0) out.push(escapeHtml(body.join('\n')), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m0 = l.charCodeAt(0);
          if ((m0 === 45 || m0 === 42) && l.charCodeAt(1) === 32) {
            items.push([trimLine(l.slice(2))]);
            i++;
            continue;
          }
          if (CONTINUED_RE.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        out.push('<ul>\n');
        for (let k = 0; k < items.length; k++) {
          const text = items[k].join('\n');
          out.push('<li>');
          inlineRange(text, 0, text.length, out, env);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(text, 0, text.length, out, env);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: maybe an ordered list
      const ord = orderedOf(line);
      if (ord !== null) {
        const start = ord.start;
        const items = [];
        while (i < n) {
          const l = lines[i];
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
            continue;
          }
          if (CONTINUED_RE.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        out.push(start !== 1 ? `<ol start="${start}">\n` : '<ol>\n');
        for (let k = 0; k < items.length; k++) {
          const text = items[k].join('\n');
          out.push('<li>');
          inlineRange(text, 0, text.length, out, env);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineRange(text, 0, text.length, tmp, env);
      excerpt = tmp.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, out, env);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ----------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isOnlyWs(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isOnlyWs(src, lineStart, open) && isOnlyWs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ------------------------------------------------------- template interpretation

/**
 * `nodes` rendered into `out` in the flattened scope `S` (one object; for
 * loops save and restore the names they bind, which is exactly the
 * reference's scope chain). `T` is the parsed templates, `D` the include
 * depth. Single- and two-segment lookups are inlined: a scope never holds
 * undefined, so reading S[name] directly is the reference's lookup for the
 * first name, and each next name is an own property or the path is
 * undefined. (Templates were compiled to JavaScript functions first; the
 * per-case compile cost — fresh functions plus their JIT work on the
 * compiler threads, which the CPU-time metric counts — outweighed the
 * interpreter dispatch it saved, so this build interprets.)
 */
function lookup(S, path) {
  if (!hasOwn(S, path[0])) return undefined;
  let v = S[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, S, out, T, D) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const p = n.path;
        let v;
        if (p.length === 1) v = S[p[0]];
        else if (p.length === 2) {
          const v0 = S[p[0]];
          v = v0 !== null && typeof v0 === 'object' && hasOwn(v0, p[1]) ? v0[p[1]] : undefined;
        } else v = lookup(S, p);
        out.push(escapeHtml(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case 'raw': {
        const p = n.path;
        let v;
        if (p.length === 1) v = S[p[0]];
        else if (p.length === 2) {
          const v0 = S[p[0]];
          v = v0 !== null && typeof v0 === 'object' && hasOwn(v0, p[1]) ? v0[p[1]] : undefined;
        } else v = lookup(S, p);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const p = n.path;
        let v;
        if (p.length === 1) v = S[p[0]];
        else if (p.length === 2) {
          const v0 = S[p[0]];
          v = v0 !== null && typeof v0 === 'object' && hasOwn(v0, p[1]) ? v0[p[1]] : undefined;
        } else v = lookup(S, p);
        const branch = truthy(v) !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, S, out, T, D);
        break;
      }
      case 'for': {
        const p = n.path;
        let xs;
        if (p.length === 1) xs = S[p[0]];
        else if (p.length === 2) {
          const v0 = S[p[0]];
          xs = v0 !== null && typeof v0 === 'object' && hasOwn(v0, p[1]) ? v0[p[1]] : undefined;
        } else xs = lookup(S, p);
        if (!Array.isArray(xs)) break;
        const hadName = hasOwn(S, n.name);
        const oldName = S[n.name];
        const hadLoop = hasOwn(S, 'loop');
        const oldLoop = S.loop;
        for (let k = 0; k < xs.length; k++) {
          S[n.name] = xs[k];
          S.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, S, out, T, D);
        }
        if (hadName) S[n.name] = oldName; else delete S[n.name];
        if (hadLoop) S.loop = oldLoop; else delete S.loop;
        break;
      }
      case 'include': {
        const t = T.get(n.name);
        if (t !== undefined && D < INCLUDE_DEPTH) renderNodes(t, S, out, T, D + 1);
        break;
      }
    }
  }
}

/** `src` parsed into its node tree (a TemplateError when it does not parse). */
function compileTemplate(name, src) {
  return parseTemplate(name, src);
}

// -------------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let acc = dir;
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (acc === '') return null;
        const cut = acc.lastIndexOf('/');
        acc = cut === -1 ? '' : acc.slice(0, cut);
      } else {
        acc = acc === '' ? seg : `${acc}/${seg}`;
      }
    }
    i = j + 1;
  }
  return acc;
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** Whether `target` has a URI scheme. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  const slugMemo = new Map();
  const templates = new Map();
  const report = [];
  const output = {};
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths.
  const files = input.files.sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in source order; the checks run in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? memoSlug(slugMemo, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || hasScheme(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = memoSlug(slugMemo, name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = memoSlug(slugMemo, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = memoSlug(slugMemo, name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { site, tags: allTags, recent, ...vars }, out, templates, 0);
    return out.join('');
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : cardOf(s)) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
