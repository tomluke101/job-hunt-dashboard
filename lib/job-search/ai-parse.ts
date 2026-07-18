// AI parse of a search description. Turns the user's plain-English "what I'm
// looking for" into structured intent (a read-back summary, suggested titles,
// deal-breakers, must-haves, seniority / working-model / location / salary hints).
//
// SERVER KEY ONLY. Like semantic embeddings (lib/embeddings.ts), this is core
// product, so it runs on OUR ANTHROPIC_API_KEY, not the user's connected provider —
// the old BYOK path returned null for every normal user (nobody connects a key),
// which meant the parse was a no-op in production. Cover-letter / CV tailoring stay
// BYOK; this does not. Never surface the model name in the UI.
//
// Best-effort by contract: if ANTHROPIC_API_KEY is unset or the call fails we return
// null and the product degrades to heuristic extraction (title suggestions, keyword
// pull). A search must never break because the parse had a bad day.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

// Sonnet 5 (the locked architecture): Haiku misses "chance of a good future"-style
// nuance, Opus is 4x the cost for a marginal gain on a short extraction.
const PARSE_MODEL = "claude-sonnet-5";

export interface AIParsedCriteria {
  // Concrete role titles to suggest adding to the shortlist filter.
  role_types: string[];
  // Seniority hint — used later by the Experience Level filter.
  seniority: "entry" | "graduate" | "junior" | "mid" | "senior" | "lead" | "director" | null;
  // Industries or company types the user explicitly wants to avoid.
  industries_avoid: string[];
  // Culture / role signals that boost ranking when found in a JD.
  must_haves: string[];
  // Conditions the user wants to avoid (e.g. "shift work"). Surfaced as
  // suggested Avoid-list entries — never auto-enforced.
  deal_breakers: string[];
  // Working-model hint if clearly stated ("hybrid London or remote").
  working_model: "remote" | "hybrid" | "office" | null;
  // Location hint (city, region, or "UK-wide") if stated.
  location_hint: string | null;
  // Salary hint if stated (annual GBP).
  salary_floor: number | null;
  salary_target: number | null;
  // One-sentence natural language read-back so we can show the user
  // what we understood.
  summary: string;
}

const SYSTEM_PROMPT = `You extract structured job-search criteria from plain-English descriptions written by UK job seekers.

Return ONLY a single valid JSON object matching this schema. No preamble, no code fences, no commentary.

{
  "role_types": string[],           // concrete UK job titles inferred from the description, in canonical Title Case (e.g. "Data Analyst", "Junior Data Analyst"). Empty array if none inferred.
  "seniority": string | null,       // one of: "entry", "graduate", "junior", "mid", "senior", "lead", "director". null if not stated.
  "industries_avoid": string[],     // simple lowercase words/phrases the user wants to avoid ("gambling", "defence", "crypto"). Empty if none.
  "must_haves": string[],           // culture/role signals the user wants (e.g. "career progression", "training programme", "mentorship"). Short phrases a job description might literally contain. Empty if none.
  "deal_breakers": string[],        // conditions that rule a job out (e.g. "shift work", "on-call", "commission-only"). Short lowercase phrases a job description might literally contain. Empty if none.
  "working_model": string | null,   // one of: "remote", "hybrid", "office". null if not stated.
  "location_hint": string | null,   // city, region, or "UK-wide". null if not stated.
  "salary_floor": number | null,    // annual GBP if stated. null otherwise.
  "salary_target": number | null,   // annual GBP if stated. null otherwise.
  "summary": string                 // one warm, plain-English sentence reading back what you understood, addressed to the user ("You're after ..."). Never mention this schema or that you are an AI.
}

RULES:
- If the user says "entry-junior level", pick "junior".
- Only put UK-recognised job titles in role_types. Use Title Case. If they say "analyst", output ["Analyst"]. If they say "data analyst", output ["Data Analyst"].
- Never invent details the user didn't state. Prefer null/[] over guessing.
- industries_avoid, must_haves and deal_breakers are matched by a plain substring search against job-description text, so keep each entry short and literal (e.g. "gambling" not "the gambling industry"; "shift work" not "jobs that require shift work").
- If the description is vague ("a good job"), still return the object with everything null/empty and a summary that gently says you couldn't pin much down and invites more detail.`;

// Very defensive JSON extract — models sometimes wrap in code fences or
// prepend a sentence.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Strip code fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  // Find first { … } balanced block
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function asOneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== "string") return null;
  const lower = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(lower) ? (lower as T) : null;
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[£$,\s]/g, "");
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normaliseParsed(raw: unknown): AIParsedCriteria | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    role_types: asStringArray(o.role_types),
    seniority: asOneOf(o.seniority, ["entry", "graduate", "junior", "mid", "senior", "lead", "director"] as const),
    industries_avoid: asStringArray(o.industries_avoid).map((s) => s.toLowerCase()),
    must_haves: asStringArray(o.must_haves),
    deal_breakers: asStringArray(o.deal_breakers).map((s) => s.toLowerCase()),
    working_model: asOneOf(o.working_model, ["remote", "hybrid", "office"] as const),
    location_hint: typeof o.location_hint === "string" && o.location_hint.trim() ? o.location_hint.trim() : null,
    salary_floor: asNumberOrNull(o.salary_floor),
    salary_target: asNumberOrNull(o.salary_target),
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
  };
}

/** sha256 (truncated) of the description text — the cache key that lets the editor
 *  and the save path skip a re-parse when the description hasn't actually changed. */
export function descriptionHash(description: string): string {
  return createHash("sha256").update(description.trim()).digest("hex").slice(0, 32);
}

/** True when the server-side parse can run at all. False degrades to heuristics. */
export function aiParseConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

// Parse the description server-side with Sonnet 5. Returns null on any failure —
// the caller falls back to heuristic extraction, never an error.
export async function parseDescriptionServerSide(description: string): Promise<AIParsedCriteria | null> {
  const desc = description.trim();
  if (desc.length < 8) return null;
  const anthropic = getClient();
  if (!anthropic) {
    console.warn("[ai-parse] ANTHROPIC_API_KEY not set — description parse unavailable, falling back to heuristics");
    return null;
  }
  try {
    const res = await anthropic.messages.create({
      model: PARSE_MODEL,
      max_tokens: 1024,
      // A short structured extraction — no thinking needed, and disabling it keeps
      // the editor's live "understand" call fast and cheap.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Description:\n"""${desc}"""` }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return normaliseParsed(extractJson(text));
  } catch (e) {
    console.error("[parseDescriptionServerSide] failed", e);
    return null;
  }
}
