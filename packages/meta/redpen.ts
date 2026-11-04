import { cleanText, layoutText, textWidth } from "../renderers/polish.ts";
import type { Campaign } from "../campaign/index.ts";

/**
 * Red Pen: where on the real artifacts a preflight issue lives.
 *
 * Reel boxes are derived from the SAME layout maths the renderers use
 * (`layoutText` for the cutout look, the fixed text stack in reel.ts for the
 * baseline look), expressed in normalised 0..1 coordinates of the 1080x1920
 * frame. Glyph widths come from the renderer's own `textWidth` estimate (it is
 * an approximation of Arial, not a font measurement), so horizontal extents of
 * a sub-string are estimates; the line (vertical position) is exact layout.
 * When a position cannot be derived honestly the answer is `null`.
 */
export const FRAME_W = 1080;
export const FRAME_H = 1920;

export type ReelBox = { shot: number; box: [number, number, number, number] };
export type Locate = { text: string; reel: ReelBox | null };
export type Fix = { kind: "regenerate"; label: string };

/** Same chunking as reel.ts `wrap` (38 characters per baseline line). */
export const baselineWrap = (text: string) => {
  const chars = Array.from(text),
    lines: string[] = [];
  for (let i = 0; i < chars.length; i += 38)
    lines.push(chars.slice(i, i + 38).join(""));
  return lines;
};

type Rect = [number, number, number, number]; // x, y, w, h in frame px

/** Clip to the frame and normalise; null when nothing visible remains. */
export function normaliseRect([x, y, w, h]: Rect): Rect | null {
  const x0 = Math.max(0, x),
    y0 = Math.max(0, y);
  const x1 = Math.min(FRAME_W, x + w),
    y1 = Math.min(FRAME_H, y + h);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return [
    r(x0 / FRAME_W),
    r(y0 / FRAME_H),
    r((x1 - x0) / FRAME_W),
    r((y1 - y0) / FRAME_H),
  ];
}

/**
 * Find `needle` inside lines that were produced by wrapping one string at
 * spaces (`joiner` between lines). Returns, per touched line, the character
 * range of the match. Null if absent or not representable.
 */
function findInLines(lines: string[], needle: string, joiner: string) {
  const n = needle.trim();
  if (!n) return null;
  const starts: number[] = [];
  let joined = "";
  lines.forEach((l, i) => {
    if (i) joined += joiner;
    starts.push(joined.length);
    joined += l;
  });
  const at = joined.indexOf(n);
  if (at < 0) return null;
  const end = at + n.length;
  const parts: { line: number; from: number; to: number }[] = [];
  lines.forEach((l, i) => {
    const s = starts[i],
      e = s + l.length;
    const from = Math.max(at, s),
      to = Math.min(end, e);
    if (to > from) parts.push({ line: i, from: from - s, to: to - s });
  });
  return parts.length ? parts : null;
}

const union = (rects: Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r[0])),
    y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2])),
    y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
};

/**
 * Frame-pixel rectangle of `needle` in one reel shot, or null.
 * `cutout` selects the cutout look (centred, `layoutText`) over the baseline
 * look (left aligned, 36px lines from y=1130 in 52px steps, as in reel.ts).
 */
export function reelRect(
  c: Campaign,
  shotIndex: number,
  needle: string,
  cutout: boolean,
): Rect | null {
  const reel = c.reel;
  const shot = reel?.shots[shotIndex];
  if (!reel || !shot || !needle.trim()) return null;
  if (!cutout) {
    // Each source line is chunked at 38 characters; chunks of all source
    // lines are drawn top to bottom, one 52px step apart.
    const sources = [reel.facts.business, ...shot.text.split("\n")];
    let j0 = 0;
    for (const src of sources) {
      const chunks = baselineWrap(src);
      const parts = findInLines(chunks, needle, "");
      if (parts)
        return union(
          parts.map((p) => {
            const j = j0 + p.line;
            const bold = j === 1; // reel.ts: only the second drawn line is bold
            const x = 90 + textWidth(chunks[p.line].slice(0, p.from), 36, bold);
            const w = textWidth(chunks[p.line].slice(p.from, p.to), 36, bold);
            return [x, 1130 + j * 52 - 29, w, 36] as Rect;
          }),
        );
      j0 += chunks.length;
    }
    return null;
  }
  const [name = "", priceText = "", ...rest] = cleanText(shot.text).split(
    /\r?\n/,
  );
  const block = layoutText(
    cleanText(reel.facts.business),
    name,
    priceText,
    rest.join(" · "),
  );
  const n = needle.trim();
  // Price pill (only drawn when there is price text).
  if (block.price.text.trim() && block.price.text.includes(n)) {
    const p = block.price;
    return [(FRAME_W - p.width) / 2, p.y, p.width, p.height];
  }
  const centred = (
    lines: string[],
    size: number,
    bold: boolean,
    top: number,
    lineHeight: number,
    joiner: string,
  ): Rect | null => {
    const parts = findInLines(lines, n, joiner);
    if (!parts) return null;
    return union(
      parts.map((p) => {
        const full = textWidth(lines[p.line], size, bold);
        const pre = textWidth(lines[p.line].slice(0, p.from), size, bold);
        const w = textWidth(lines[p.line].slice(p.from, p.to), size, bold);
        return [
          (FRAME_W - full) / 2 + pre,
          top + p.line * lineHeight,
          w,
          lineHeight,
        ] as Rect;
      }),
    );
  };
  const b = block.business;
  if (b.text.toUpperCase().includes(n.toUpperCase())) {
    const up = b.text.toUpperCase();
    const spaced = (s: string) => textWidth(s, b.size, true) + 7 * s.length;
    const at = up.indexOf(n.toUpperCase());
    const full = spaced(up);
    return [
      (FRAME_W - full) / 2 + spaced(up.slice(0, at)),
      b.y,
      spaced(up.slice(at, at + n.length)),
      b.size + 16,
    ];
  }
  return (
    centred(
      block.name.lines,
      block.name.size,
      true,
      block.name.y,
      block.name.lineHeight,
      " ",
    ) ??
    centred(
      block.details.lines,
      block.details.size,
      false,
      block.details.y,
      block.details.lineHeight,
      " ",
    )
  );
}

/** Normalised reel box for `needle`, searching `preferShot` first then the rest. */
export function reelLocate(
  c: Campaign,
  needle: string,
  cutoutProductIds: ReadonlySet<string>,
  preferShot?: number,
): ReelBox | null {
  const reel = c.reel;
  if (!reel) return null;
  const order = [
    ...(preferShot !== undefined ? [preferShot] : []),
    ...reel.shots.map((_, i) => i).filter((i) => i !== preferShot),
  ];
  for (const i of order) {
    const rect = reelRect(
      c,
      i,
      needle,
      cutoutProductIds.has(reel.shots[i]?.productId),
    );
    if (!rect) continue;
    const box = normaliseRect(rect);
    return box ? { shot: i, box } : null;
  }
  return null;
}

/* ---- text similarity (only used to pick the line that holds a wrong value) */
export function levenshtein(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}
export const similarity = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/\s+/g, " ").trim(),
    y = b.toLowerCase().replace(/\s+/g, " ").trim();
  const m = Math.max(x.length, y.length);
  return m ? 1 - levenshtein(x, y) / m : 1;
};

/**
 * The single surface line (or " · " segment) that most plausibly is the
 * mutated version of `expected`. Returns null unless one candidate is clearly
 * the best (similarity >= 0.6 and a margin over the runner-up).
 */
export function closestLine(
  lines: string[],
  expected: string,
  exclude: string[],
): string | null {
  const ex = new Set(exclude.map((e) => e.toLowerCase().trim()));
  const cands = new Set<string>();
  for (const l of lines)
    for (const part of [l, ...l.split(" · ")]) {
      const t = part.trim();
      if (t && !ex.has(t.toLowerCase())) cands.add(t);
    }
  const scored = [...cands]
    .map((t) => ({ t, s: similarity(t, expected) }))
    .sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s < 0.6) return null;
  if (scored[1] && scored[0].s - scored[1].s < 0.05) return null;
  return scored[0].t;
}

/* ---- template diff: which actual line replaced an expected one ------------ */
/**
 * Line alignment (LCS) between what the confirmed facts WOULD render and what
 * the surface actually says. Within each differing gap, expected-only and
 * actual-only lines are paired in order. Pure text diff, nothing guessed.
 */
export function diffPairs(expected: string[], actual: string[]) {
  const e = expected.map((x) => x.trim()),
    a = actual.map((x) => x.trim());
  const lcs: number[][] = Array.from({ length: e.length + 1 }, () =>
    new Array(a.length + 1).fill(0),
  );
  for (let i = e.length - 1; i >= 0; i--)
    for (let j = a.length - 1; j >= 0; j--)
      lcs[i][j] =
        e[i] === a[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs: { expected: string; actual: string }[] = [];
  let i = 0,
    j = 0,
    dels: string[] = [],
    ins: string[] = [];
  const flush = () => {
    for (let k = 0; k < Math.min(dels.length, ins.length); k++)
      pairs.push({ expected: dels[k], actual: ins[k] });
    dels = [];
    ins = [];
  };
  while (i < e.length || j < a.length) {
    if (i < e.length && j < a.length && e[i] === a[j]) {
      flush();
      i++;
      j++;
    } else if (
      j >= a.length ||
      (i < e.length && lcs[i + 1][j] >= lcs[i][j + 1])
    )
      dels.push(e[i++]);
    else ins.push(a[j++]);
  }
  flush();
  return pairs;
}

/**
 * Inside a differing line pair, the part of `actual` that replaced `value`
 * (found in `expected`, case-insensitive). Null if `value` is not in `expected`
 * or the replacement is empty.
 */
export function replacedFragment(
  expected: string,
  actual: string,
  value: string,
): string | null {
  const v = value.trim();
  const at = expected.toLowerCase().indexOf(v.toLowerCase());
  if (!v || at < 0) return null;
  let p = 0;
  while (p < expected.length && p < actual.length && expected[p] === actual[p])
    p++;
  let q = 0;
  while (
    q < expected.length - p &&
    q < actual.length - p &&
    expected[expected.length - 1 - q] === actual[actual.length - 1 - q]
  )
    q++;
  const start = Math.min(p, at);
  const tailE = expected.length - Math.max(expected.length - q, at + v.length);
  const frag = actual.slice(start, actual.length - tailE).trim();
  return frag || null;
}

/** The text on the surface that replaced `value`, via the template diff. */
export function replacementFor(
  expectedLines: string[],
  actualLines: string[],
  value: string,
): string | null {
  for (const pair of diffPairs(expectedLines, actualLines)) {
    if (!pair.expected.toLowerCase().includes(value.trim().toLowerCase()))
      continue;
    const frag = replacedFragment(pair.expected, pair.actual, value);
    if (frag) return frag;
  }
  return null;
}
