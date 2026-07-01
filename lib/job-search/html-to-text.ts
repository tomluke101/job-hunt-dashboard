// Convert HTML JD → readable plaintext with paragraph structure preserved.
// Reed / Adzuna / Greenhouse all return HTML-ish JDs; naive strip loses
// structure and leaves numeric entities like &#163;30,000 rendering raw.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢",
  bull: "•",
  middot: "·",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (whole, name) => NAMED_ENTITIES[name] ?? whole);
}

// Convert HTML → plaintext preserving paragraph + list structure.
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = html;

  // Normalise: drop scripts/styles entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");

  // Block-boundary tags -> double newline.
  s = s.replace(/<\/(p|div|section|article|header|footer|h[1-6]|blockquote|ul|ol|table|tr|thead|tbody)>/gi, "\n\n");
  s = s.replace(/<(p|div|section|article|header|footer|h[1-6]|blockquote|hr)\b[^>]*>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // List items -> bullet on new line.
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");

  // Table cells -> tab; rows -> newline (already newline from </tr>).
  s = s.replace(/<t[dh]\b[^>]*>/gi, " ");
  s = s.replace(/<\/t[dh]>/gi, "\t");

  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");

  // Decode entities.
  s = decodeEntities(s);

  // Whitespace normalisation:
  //   collapse runs of spaces/tabs, keep newline structure, collapse 3+ newlines to 2.
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}

// Fallback for text that's already partly plain — decode entities + normalise
// whitespace without touching structure.
export function tidyText(text: string | null | undefined): string {
  if (!text) return "";
  return decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
