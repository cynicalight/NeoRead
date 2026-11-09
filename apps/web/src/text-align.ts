/**
 * For each item of `a`, the index in `b` it pairs with in a longest common
 * subsequence, or undefined.
 */
export function lcsMatches(a: ArrayLike<string>, b: ArrayLike<string>) {
  const n = a.length,
    m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: (number | undefined)[] = new Array(n);
  for (let i = 0, j = 0; i < n && j < m;)
    if (a[i] === b[j]) out[i++] = j++;
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  return out;
}

/**
 * The span of `text` that `needle` stands for when the two order a few
 * characters differently (PDF subscripts): the span holds the same
 * characters as the needle, and each end sits on aligned characters.
 */
export function alignedSpan(
  text: string,
  needle: string,
): { start: number; end: number } | undefined {
  if (needle.length < 8) return;
  const at = lcsMatches(needle, text);
  if (at.filter((j) => j !== undefined).length < needle.length * 0.8) return;
  const run = (i: number, step: number) =>
    [0, 1, 2].every((k) => {
      const j = at[i + step * k];
      return j !== undefined && j === at[i]! + step * k;
    });
  // Anchor each end on three characters aligned in a row, then extend
  // outward character by character, skipping up to three moved ones.
  let first = -1,
    last = -1;
  for (let i = 0; i + 2 < at.length && first < 0; i++) if (run(i, 1)) first = i;
  for (let i = at.length - 1; i >= 2 && last < 0; i--) if (run(i, -1)) last = i;
  if (first < 0 || last < 0) return;
  let start = at[first]!,
    end = at[last]! + 1;
  // A needle character missing nearby (moved elsewhere) is skipped, up to
  // two in a row.
  for (let i = first - 1, missed = 0; i >= 0 && missed <= 2; i--) {
    let k = 1;
    while (k <= 4 && text[start - k] !== needle[i]) k++;
    if (k > 4 || start - k < 0) missed++;
    else {
      start -= k;
      missed = 0;
    }
  }
  for (let i = last + 1, missed = 0; i < needle.length && missed <= 2; i++) {
    let k = 0;
    while (k < 4 && text[end + k] !== needle[i]) k++;
    if (k === 4 || end + k >= text.length) missed++;
    else {
      end += k + 1;
      missed = 0;
    }
  }
  // Only reordering is tolerated: the span holds exactly the needle's
  // characters, so different words or variables never match.
  if (end <= start || sorted(text.slice(start, end)) !== sorted(needle)) return;
  return { start, end };
}

const sorted = (text: string) => Array.from(text).sort().join("");
