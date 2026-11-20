// Models write mathematics two ways: between dollar signs, and between
// `\(…\)` and `\[…\]`, as LaTeX itself does. The Markdown reader knows only the
// dollar signs, and takes `\(` for an escaped bracket. This rewrites the second
// way as the first, before the text is read.

// Fenced blocks, closed or still arriving, and code within a line.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[^\n]*?``|`[^`\n]*`)/;

// Not after a backslash: `\\[2pt]` is a line break with spacing, not an opening.
const INLINE = /(?<!\\)\\\(([^\n]*?(?:\n[^\n]+?)*?)(?<!\\)\\\)/g;
const DISPLAYED = /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g;

/**
 * The same text with `\(…\)` written as `$…$` and `\[…\]` as `$$…$$`. Code is
 * left as it is. Only a pair is rewritten, so text still arriving, with an
 * opening and no closing yet, is not touched. A delimiter is replaced where it
 * stands: one on a line of its own stays on a line of its own, which is what
 * makes a formula displayed.
 */
export const dollarMath = (text: string): string =>
  text
    .split(CODE)
    // The pieces between code are at the even places.
    .map((piece, i) =>
      i % 2 === 1 ? piece : piece.replace(DISPLAYED, (_all, inside: string) => `$$${inside}$$`).replace(INLINE, (_all, inside: string) => `$${inside}$`),
    )
    .join('');
