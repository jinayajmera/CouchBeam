/**
 * Dependency-free fuzzy search shared by the server (/api/catalog?q=) and the
 * client (instant, offline-friendly filtering).
 *
 * Per query token we take the best match against any text token:
 *   prefix match          1.00
 *   substring             0.80
 *   typo-tolerant (lev)   0.70 * similarity   (needs similarity >= 0.6)
 *   subsequence ("btbk")  0.40
 * The final score is the mean over query tokens; any token with no match at
 * all halves the score so "big xyz" cannot outrank "big buck".
 */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (q[i] === t[j]) i++;
  return i === q.length;
}

function tokenScore(q: string, t: string): number {
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 0.8;
  // Compare against a same-length prefix too, so "sintl" still finds "sintel".
  const cand = Math.min(t.length, q.length + 1);
  const dist = Math.min(levenshtein(q, t), levenshtein(q, t.slice(0, cand)));
  const sim = 1 - dist / Math.max(q.length, cand);
  if (q.length >= 3 && sim >= 0.6) return 0.7 * sim;
  if (q.length >= 3 && isSubsequence(q, t)) return 0.4;
  return 0;
}

export function fuzzyScore(query: string, text: string): number {
  const q = normalize(query);
  if (!q) return 1;
  const qTokens = q.split(' ');
  const tTokens = normalize(text).split(' ').filter(Boolean);
  if (!tTokens.length) return 0;

  let total = 0;
  let missed = false;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) best = Math.max(best, tokenScore(qt, tt));
    if (best === 0) missed = true;
    total += best;
  }
  const mean = total / qTokens.length;
  return missed ? mean * 0.5 : mean;
}

export function fuzzySearch<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  threshold = 0.3,
): T[] {
  if (!normalize(query)) return [...items];
  return items
    .map((item) => ({ item, score: fuzzyScore(query, textOf(item)) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}
