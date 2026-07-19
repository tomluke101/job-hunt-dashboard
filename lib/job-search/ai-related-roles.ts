// LLM fallback for "related roles" suggestions in the search editor.
//
// The static taxonomy (title-suggestions.ts) is fast and free and drives live
// autocomplete, but it only knows the roles it was seeded with — a niche title
// ("Actuarial Analyst", "Clinical Coder", "Rolling Stock Engineer") produces no
// related-role chips at all. This fills that gap: an explicit, button-driven
// call that asks the model for closely-related UK job titles.
//
// SERVER KEY, cheap model. Runs on OUR ANTHROPIC_API_KEY (core product, same as
// ai-parse.ts) but on Haiku — listing adjacent job titles is a simple task and
// this is opt-in, low-stakes UI sugar, so it must be cheap. Best-effort by
// contract: null/[] on any failure; the editor just shows nothing extra.
//
// Honesty: the returned titles are SUGGESTIONS the user clicks to accept. Nothing
// is auto-applied, and the model is told to return real, closely-related titles
// only — never to pad the list or drift to an unrelated field.

import Anthropic from "@anthropic-ai/sdk";

// Haiku 4.5: adjacent-title listing needs no deep reasoning, and this is opt-in
// sugar — Sonnet would be 10x the cost for no user-visible gain.
const RELATED_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You suggest closely-related UK job titles that a job seeker might also want to search for, given the role title(s) they have already chosen.

Return ONLY a single JSON array of strings — up to 8 additional UK job titles in canonical Title Case. No preamble, no commentary, no code fences.

RULES:
- Real, common UK job titles only. Never invent titles or output hyper-specific/niche variants nobody searches for.
- Each must be CLOSELY related to the input role(s): same field, an adjacent function, or an adjacent seniority. Do NOT drift into an unrelated field.
- Do NOT repeat any title the user already listed (case-insensitive).
- No near-duplicates and no seniority spam: don't list "Junior X"/"Senior X"/"Lead X" for the same X unless they are genuinely distinct roles a person would search separately.
- If you cannot think of any genuinely related titles, return an empty array [] rather than padding with weak guesses.
- Output ONLY the JSON array, e.g. ["Reserving Analyst","Pricing Analyst","Actuary"].`;

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

/** True when the server-side call can run at all. */
export function relatedRolesConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface RelatedRolesInput {
  titles: string[];
  keywords?: string | null;
  description?: string | null;
}

// Ask the model for closely-related UK job titles. Returns [] on any failure or
// when nothing sensible comes back — never throws to the caller.
export async function suggestRelatedRolesServerSide(input: RelatedRolesInput): Promise<string[]> {
  const titles = input.titles.map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) return [];
  const anthropic = getClient();
  if (!anthropic) {
    console.warn("[ai-related-roles] ANTHROPIC_API_KEY not set — related-role fallback unavailable");
    return [];
  }

  const parts = [`Roles chosen so far: ${titles.join(", ")}`];
  const kw = input.keywords?.trim();
  if (kw) parts.push(`Keywords: ${kw.slice(0, 200)}`);
  const desc = input.description?.trim();
  if (desc) parts.push(`What they're looking for: ${desc.slice(0, 600)}`);

  try {
    const res = await anthropic.messages.create({
      model: RELATED_MODEL,
      max_tokens: 400,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: parts.join("\n") }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = extractJsonArray(text);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set(titles.map((t) => t.toLowerCase()));
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (!t || t.length > 60) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 8) break;
    }
    return out;
  } catch (e) {
    console.error("[suggestRelatedRolesServerSide] failed", e);
    return [];
  }
}
