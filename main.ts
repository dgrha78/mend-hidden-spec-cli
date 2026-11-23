// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old path, new path], for the `R` output lines of section 2. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its own line break, its lines, and whether it ends with a line break (section 3). */
interface FileLines {
  lines: string[];
  brk: string;
  end: boolean;
}

function parseFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], brk, end: false };
  const parts = text.split(brk);
  const end = text.endsWith(brk);
  if (end) parts.pop();
  return { lines: parts, brk, end };
}

function writeLines(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.brk) + (f.end ? f.brk : '');
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(tier: number, a: string, b: string): boolean {
  return tier === 0 ? a === b : tier === 1 ? stripTrail(a) === stripTrail(b) : stripBoth(a) === stripBoth(b);
}

/**
 * The occurrences of O in lines, at or after index `from`, at the first tier that has one (section 5).
 * With `eofOnly`, only occurrences that end at the file's last line count. Null when there are none.
 */
function findOcc(lines: string[], O: string[], strict: boolean, from: number, eofOnly = false): { tier: number; at: number[] } | null {
  if (O.length === 0) return null;
  for (let tier = 0; tier < (strict ? 1 : 3); tier += 1) {
    const at: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (eofOnly && i + O.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!lineEq(tier, lines[i + k]!, O[k]!)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: its text, and its index into O when it is a context line shared with O, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** The lines a match writes: context lines as the file's own lines, tier 2 re-indenting the rest (section 5). */
function renderN(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  return N.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx]!;
    if (tier === 2 && !onlyWs(e.text) && e.text.startsWith(P)) return F + e.text.slice(P.length);
    return e.text;
  });
}

/** Splits a hunk or chunk body into O and N, and whether a `\` line follows its last context or `+` line. */
function bodyON(body: { kind: string; text: string }[]): { O: string[]; N: NLine[]; noNl: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
  }
  let noNl = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      noNl = (body[k + 1]?.kind ?? '') === '\\';
      break;
    }
  }
  return { O, N, noNl };
}

// ---- unified diffs (section 6) ----

interface BodyLine {
  kind: string;
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  oldHas: boolean;
  oldPath: string | null;
  newHas: boolean;
  newPath: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line; any other form is a parse error at its line. */
function gitPaths(line: string, num: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const idx = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (idx <= 2 || idx + 3 >= rest.length) throw new Exit2(`error: parse ${num}`);
  return [rest.slice(2, idx), rest.slice(idx + 3)];
}

/** Applies a section's hunks, in order, to a file's text; failures name the file the lines were sought in. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N, noNl } = bodyON(h.body);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...N.map((e) => e.text));
      if (atEnd) f.end = !noNl;
      d += N.length;
      continue;
    }
    const found = findOcc(f.lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const rep = renderN(N, O, f.lines, pos, found.tier);
    const atEnd = pos + O.length === f.lines.length;
    f.lines.splice(pos, O.length, ...rep);
    if (atEnd) f.end = !noNl;
    d += N.length - O.length;
  }
  return writeLines(f);
}

/** Turns one parsed section into its edit (section 6, "The section's edit"). */
function sectionEdit(s: Section, strict: boolean): Edit {
  let oPath: string | null | undefined;
  let nPath: string | null | undefined;
  if (s.oldHas && s.newHas) {
    oPath = s.oldPath;
    nPath = s.newPath;
  } else if (s.renOld !== null && s.renNew !== null) {
    oPath = s.renOld;
    nPath = s.renNew;
  } else {
    oPath = s.oldHas ? s.oldPath : s.renOld !== null ? s.renOld : s.gitOld ?? undefined;
    nPath = s.newHas ? s.newPath : s.renNew !== null ? s.renNew : s.gitNew ?? undefined;
  }
  const creation = oPath === null || s.newFile;
  const deletion = !creation && (nPath === null || s.delFile);
  if (creation) {
    const target = typeof nPath === 'string' ? nPath : null;
    return (tree) => {
      if (typeof oPath === 'string' && !safe(oPath)) throw new Fail('unsafe', oPath);
      if (target === null) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const ls: string[] = [];
      let lastPlusNoNl = false;
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === '+') {
            ls.push(b.text);
            lastPlusNoNl = (h.body[idx + 1]?.kind ?? '') === '\\';
          }
        });
      }
      tree.now.set(target, ls.length === 0 ? '' : ls.join('\n') + (lastPlusNoNl ? '' : '\n'));
    };
  }
  if (deletion) {
    const source = typeof oPath === 'string' ? oPath : null;
    return (tree) => {
      if (source !== null && !safe(source)) throw new Fail('unsafe', source);
      if (typeof nPath === 'string' && !safe(nPath)) throw new Fail('unsafe', nPath);
      if (source === null) return;
      if (tree.get(source) === null) throw new Fail('missing', source);
      tree.now.set(source, null);
    };
  }
  if (typeof oPath === 'string' && typeof nPath === 'string' && oPath !== nPath) {
    const o = oPath;
    const n = nPath;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const t = tree.get(o);
      if (t === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      tree.now.set(n, applyHunks(t, s.hunks, strict, o));
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    };
  }
  const p = typeof oPath === 'string' ? oPath : typeof nPath === 'string' ? nPath : null;
  return (tree) => {
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(t, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  /** Consumes one section's header lines and hunks from index i; returns where the section ended. */
  const consume = (start: number, s: Section): number => {
    let i = start;
    let inHunks = false;
    while (i < n) {
      const line = lines[i]!;
      if (line.startsWith('diff --git ')) break;
      if (inHunks && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (!inHunks) {
        if (line.startsWith('--- ')) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          s.oldHas = true;
          s.oldPath = headerPath(line);
          s.newHas = true;
          s.newPath = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        if (line.startsWith('+++ ')) {
          s.newHas = true;
          s.newPath = headerPath(line);
          i += 1;
          continue;
        }
        if (line.startsWith('rename from ')) {
          s.renOld = line.slice('rename from '.length).trim();
          i += 1;
          continue;
        }
        if (line.startsWith('rename to ')) {
          s.renNew = line.slice('rename to '.length).trim();
          i += 1;
          continue;
        }
        if (line.startsWith('new file mode')) {
          s.newFile = true;
          i += 1;
          continue;
        }
        if (line.startsWith('deleted file mode')) {
          s.delFile = true;
          i += 1;
          continue;
        }
        if (line.startsWith('@@')) {
          inHunks = true;
          continue;
        }
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(m[1]!, 10);
        i += 1;
        const body: BodyLine[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          const c = b[0] ?? '';
          if (c === ' ' || c === '-' || c === '+' || c === '\\') {
            body.push({ kind: c, text: b.slice(1), empty: false });
            i += 1;
          } else if (b === '') {
            body.push({ kind: ' ', text: '', empty: true });
            i += 1;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
        s.hunks.push({ a, body });
        continue;
      }
      break;
    }
    return i;
  };
  const newSection = (): Section => {
    const s: Section = {
      gitOld: null,
      gitNew: null,
      oldHas: false,
      oldPath: null,
      newHas: false,
      newPath: null,
      renOld: null,
      renNew: null,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      const s = newSection();
      s.gitOld = x;
      s.gitNew = y;
      i = consume(i + 1, s);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSection();
      s.oldHas = true;
      s.oldPath = headerPath(line);
      s.newHas = true;
      s.newPath = headerPath(lines[i + 1]!);
      i = consume(i + 2, s);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = parseFile(t);
    const found = findOcc(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const N: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
    f.lines.splice(pos, oldLines.length, ...renderN(N, oldLines, f.lines, pos, found.tier));
    tree.now.set(path, writeLines(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let bound = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= bound; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    bound = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: string; text: string }[];
}

interface VSection {
  kind: string;
  path: string;
  line: number;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  const path = s.path;
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const moveTo = s.moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(t);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (let tier = 0; tier < (strict ? 1 : 3) && at < 0; tier += 1) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineEq(tier, f.lines[k]!, ch.anchor)) {
              at = k;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = N.map((e) => e.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findOcc(f.lines, O, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.at[0]!;
      const rep = renderN(N, O, f.lines, pos, found.tier);
      f.lines.splice(pos, O.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = writeLines(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else tree.now.set(path, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const secStart = (l: string): string | null =>
    l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : l.startsWith('*** Update File:') ? 'update' : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    const s: VSection = { kind, path: line.slice(prefix.length).trim(), line: i + 1, moveTo: null, fileLines: [], chunks: [] };
    i += 1;
    const bodyStart = i;
    let j = i;
    while (j < last && secStart(lines[j]!) === null) j += 1;
    let bodyEnd = j;
    while (bodyEnd > bodyStart && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    const body = lines.slice(bodyStart, bodyEnd);
    if (kind === 'add') {
      body.forEach((b, idx) => {
        if (b.startsWith('+')) s.fileLines.push(b.slice(1));
        else if (b === '') s.fileLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + idx + 1}`);
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
    } else {
      let cur: VChunk | null = null;
      body.forEach((b, idx) => {
        const num = bodyStart + idx + 1;
        if (idx === 0 && b.startsWith('*** Move to:')) {
          s.moveTo = b.slice('*** Move to:'.length).trim();
          return;
        }
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          s.chunks.push(cur);
          return;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          cur = null;
          return;
        }
        const c = b[0] ?? '';
        if (c === ' ' || c === '-' || c === '+' || b === '') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            s.chunks.push(cur);
          }
          cur.body.push({ kind: b === '' ? ' ' : c, text: b === '' ? '' : b.slice(1) });
          return;
        }
        throw new Exit2(`error: parse ${num}`);
      });
      if (s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
    }
    sections.push(s);
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move whose old path is gone and whose new path is new prints one R line in place of
  // the pair's D and A lines, sorted among the other lines by the new path (section 2).
  const movedTo = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    const di = rows.findIndex((r) => r.key === o && r.text === `D ${o}`);
    const ai = rows.findIndex((r) => r.key === n && r.text === `A ${n}`);
    if (di >= 0 && ai >= 0 && !movedTo.has(n)) {
      movedTo.set(n, o);
      rows.splice(di, 1);
    }
  }
  for (const r of rows) if (movedTo.has(r.key)) r.text = `R ${movedTo.get(r.key)} -> ${r.key}`;
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
