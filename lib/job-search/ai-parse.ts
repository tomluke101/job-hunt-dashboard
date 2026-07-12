// AI parse of a search description. Runs at save time. Extracts structured
// intent from plain-English descriptions so downstream ranking + filtering
// can use it. Falls back silently to null if no provider is connected or
// the parse fails — the pipeline still works via heuristic extraction in
// that case.

import type { Provider } from "@/lib/ai-providers";
import { callAI } from "@/lib/ai-router";

export interface AIParsedCriteria {
  // Concrete role titles to add to the shortlist filter.
  role_types: string[];
  // Seniority hint — used later by the Experience Level filter.
  seniority: "entry" | "graduate" | "junior" | "mid" | "senior" | "lead" | "director" | null;
  // Industries or company types the user explicitly wants to avoid.
  industries_avoid: string[];
  // Culture / role signals that boost ranking when found in a JD.
  must_haves: string[];
  // Signals that hard-drop a job if found in the JD.
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
  "must_haves": string[],           // culture/role signals the user wants (e.g. "career progression", "training programme", "mentorship"). Short phrases. Empty if none.
  "deal_breakers": string[],        // hard drops (e.g. "shift work", "on-call", "commission-only"). Empty if none.
  "working_model": string | null,   // one of: "remote", "hybrid", "office". null if not stated.
  "location_hint": string | null,   // city, region, or "UK-wide". null if not stated.
  "salary_floor": number | null,    // annual GBP if stated. null otherwise.
  "salary_target": number | null,   // annual GBP if stated. null otherwise.
  "summary": string                 // one-sentence read-back of what you understood, plain English.
}

RULES:
- If the user says "entry-junior level", pick "junior".
- Only put UK-recognised job titles in role_types. Use Title Case. If they say "analyst", output ["Analyst"]. If they say "data analyst", output ["Data Analyst"].
- Never invent details the user didn't state. Prefer null/[] over guessing.
- Industries in industries_avoid should be short lowercase words a substring search will match against JD text (e.g. "gambling" not "the gambling industry").
- If the description is vague ("a good job"), still return the object with everything null/empty and a summary describing the vagueness.`;

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
    deal_breakers: asStringArray(o.deal_breakers),
    working_model: asOneOf(o.working_model, ["remote", "hybrid", "office"] as const),
    location_hint: typeof o.location_hint === "string" && o.location_hint.trim() ? o.location_hint.trim() : null,
    salary_floor: asNumberOrNull(o.salary_floor),
    salary_target: asNumberOrNull(o.salary_target),
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
  };
}

export interface ParseInput {
  description: string;
  connectedProviders: Partial<Record<Provider, string>>;
  providerPreference?: Provider | "auto";
}

// Parse the description with the user's preferred provider. Returns null on
// any failure — caller falls back to heuristic. Uses the "job-match" task
// so it slots into the existing user preference model without adding a
// new task type; job-match's default order (Gemini → OpenAI → Anthropic)
// is exactly the cheap-model priority we want here.
export async function parseDescriptionWithAI(input: ParseInput): Promise<AIParsedCriteria | null> {
  const desc = input.description.trim();
  if (!desc || desc.length < 8) return null;
  if (Object.keys(input.connectedProviders).length === 0) return null;

  try {
    const result = await callAI({
      task: "job-match",
      prompt: `Description:\n"""${desc}"""`,
      systemPrompt: SYSTEM_PROMPT,
      userPreference: input.providerPreference,
      connectedProviders: input.connectedProviders,
    });
    const parsed = extractJson(result.text);
    return normaliseParsed(parsed);
  } catch (e) {
    console.error("[parseDescriptionWithAI] failed", e);
    return null;
  }
}
