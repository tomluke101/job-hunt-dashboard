// Lightweight word-level diff for the Profile Adapt UI.
//
// Splits both strings into word/whitespace tokens, computes the longest
// common subsequence, then walks both sequences to mark each token as
// "same" / "added" / "removed". Returns parallel arrays for left (original)
// and right (adapted) so the UI can render them side-by-side with
// highlighting.
//
// Optimised for short texts (CV Profile sentences). Not suitable for huge
// documents — the LCS table is O(n*m) memory.

export interface DiffToken {
  text: string;
  kind: "same" | "added" | "removed";
}

export interface WordDiff {
  left: DiffToken[];   // original — "same" + "removed" tokens
  right: DiffToken[];  // adapted — "same" + "added" tokens
  hasChanges: boolean;
}

// Tokenise into words AND whitespace runs (so we can rejoin without losing spacing).
function tokenise(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

function isWhitespaceToken(t: string): boolean {
  return /^\s+$/.test(t);
}

export function computeWordDiff(original: string, adapted: string): WordDiff {
  const a = tokenise(original);
  const b = tokenise(adapted);
  const n = a.length;
  const m = b.length;

  // LCS table — dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Walk back to build diffs for both sides.
  const left: DiffToken[] = [];
  const right: DiffToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      left.unshift({ text: a[i - 1], kind: "same" });
      right.unshift({ text: b[j - 1], kind: "same" });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      left.unshift({ text: a[i - 1], kind: "removed" });
      i -= 1;
    } else {
      right.unshift({ text: b[j - 1], kind: "added" });
      j -= 1;
    }
  }
  while (i > 0) {
    left.unshift({ text: a[i - 1], kind: "removed" });
    i -= 1;
  }
  while (j > 0) {
    right.unshift({ text: b[j - 1], kind: "added" });
    j -= 1;
  }

  // Whitespace tokens that are "same" should stay neutral on both sides.
  // Whitespace tokens that are "added" or "removed" are not visually meaningful
  // by themselves — promote them to "same" if they're trivial spacing changes.
  // Cleaner UX, less visual noise.
  for (const tok of left) {
    if (tok.kind !== "same" && isWhitespaceToken(tok.text)) tok.kind = "same";
  }
  for (const tok of right) {
    if (tok.kind !== "same" && isWhitespaceToken(tok.text)) tok.kind = "same";
  }

  const hasChanges =
    left.some((t) => t.kind === "removed") || right.some((t) => t.kind === "added");

  return { left, right, hasChanges };
}
