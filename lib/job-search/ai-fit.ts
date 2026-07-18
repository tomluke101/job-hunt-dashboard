// On-demand "Why this fits" explainer for a single shortlisted job.
//
// SERVER KEY ONLY. Same contract as the description parse (lib/job-search/ai-parse.ts)
// and semantic embeddings (lib/embeddings.ts): this is core product, so it runs on
// OUR ANTHROPIC_API_KEY, never the user's connected provider. BYOK stays for CV /
// cover-letter tailoring; this does not. Never surface the model name in the UI.
//
// Best-effort by contract: if ANTHROPIC_API_KEY is unset or the call fails we return
// null and the caller shows an error the user can retry — a job card must never break
// because the explainer had a bad day.
//
// Output is plain LABELLED LINES ("Label: body"), one per line, so it persists as a
// single text column (jd_fit_summary) with no schema change and renders either as
// styled rows (JobCard parses the labels) or, for any legacy paragraph row, as prose.

import Anthropic from "@anthropic-ai/sdk";

// Sonnet 5 (the locked architecture): the same reasoning tier Block A uses. Haiku
// misses the honest-gap nuance ("you haven't done X, so lead with Y instead"); Opus
// is 4x the cost for a marginal gain on a short, grounded read.
const FIT_MODEL = "claude-sonnet-5";

// Bound the cost: a JD past this length adds tokens without changing the read. Same
// 6000-char cap the embedding path uses.
const MAX_JD_CHARS = 6000;

const SYSTEM_WITH_PROFILE = `You are a sharp, honest UK careers adviser. Given a candidate's professional profile and a specific job description, you write a short, candid read of how well THIS candidate fits THIS role.

Return ONLY these three lines, each on its own line, nothing else — no preamble, no closing, no markdown, no bullet characters:

Why you fit: <1-2 sentences on the strongest, most specific overlaps between the profile and the JD>
Your gap: <1 sentence naming the biggest thing the JD wants that the profile does NOT evidence — the honest weak spot>
Your angle: <1 sentence on how to position the application to win despite the gap — what to lead with>

RULES:
- Address the candidate directly as "you". UK English.
- Ground every claim in the profile. NEVER invent experience, skills, seniority, or qualifications the profile does not state. If the profile is thin, say so plainly in "Why you fit" and let "Your gap" carry the weight.
- Be specific, not generic. Name the actual overlap (a skill, a domain, a scope) — not "your background aligns well".
- "Your gap" must be real and honest. If there is genuinely no material gap, say the fit is strong and name the one thing that would make it stronger. Never flatter.
- Each line: 1-2 sentences max. No em-dashes. No corporate filler.`;

const SYSTEM_NO_PROFILE = `You are a sharp, honest UK careers adviser. The candidate has NOT set up a profile yet, so you cannot speak to their personal fit. Given only the job description, you write a short, candid read of what this role really wants and how a strong applicant stands out.

Return ONLY these two lines, each on its own line, nothing else — no preamble, no closing, no markdown, no bullet characters:

What this role needs: <1-2 sentences on the core skills, experience, and signals this JD is genuinely screening for — read past the boilerplate>
How to stand out: <1-2 sentences on what a strong application leads with for this specific role>

RULES:
- UK English. Be specific to THIS job, not generic advice.
- Do NOT invent or assume anything about the candidate — you have no profile. Speak about the role and the strong applicant, not "you".
- Each line: 1-2 sentences max. No em-dashes. No corporate filler.`;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

/** True when the server-side explainer can run at all. */
export function aiFitConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Keep only the labelled lines the model was asked for. Defends against a stray
// preamble / code fence / blank lines, and caps length so a runaway response can't
// bloat the stored column.
function tidyFitText(raw: string): string {
  const lines = raw
    .replace(/```[a-z]*\n?/gi, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // A real output line is "Label: body". Drop anything that isn't (preambles,
    // trailing notes) unless nothing matches, in which case fall back to the raw
    // trimmed text so the user still sees the model's answer.
    .filter((l) => /^[^:]{2,40}:\s*\S/.test(l));
  const text = lines.join("\n").trim();
  if (text) return text.slice(0, 1200);
  return raw.trim().slice(0, 1200);
}

export interface FitExplanation {
  text: string;
  hadProfile: boolean;
}

// Explain how a candidate fits a job. `profile` is the user's master-profile summary
// (null / empty when they haven't built one — JD-only mode + the caller nudges them).
// Returns null on any failure so the caller can surface a retry.
export async function explainFitServerSide(args: {
  profile: string | null;
  jdText: string;
  title: string;
  company: string;
}): Promise<FitExplanation | null> {
  const jd = (args.jdText ?? "").trim().slice(0, MAX_JD_CHARS);
  if (jd.length < 40) return null; // nothing meaningful to read
  const profile = (args.profile ?? "").trim();
  const hadProfile = profile.length > 0;

  const anthropic = getClient();
  if (!anthropic) {
    console.warn("[ai-fit] ANTHROPIC_API_KEY not set — 'why this fits' unavailable");
    return null;
  }

  const header = `Role: ${args.title || "(untitled)"}${args.company ? ` at ${args.company}` : ""}`;
  const userContent = hadProfile
    ? `${header}

=== CANDIDATE PROFILE ===
"""${profile}"""

=== JOB DESCRIPTION ===
"""${jd}"""`
    : `${header}

=== JOB DESCRIPTION ===
"""${jd}"""`;

  try {
    const res = await anthropic.messages.create({
      model: FIT_MODEL,
      max_tokens: 600,
      // A short grounded read — no extended thinking needed, and disabling it keeps
      // the per-card click fast and cheap (~£0.004).
      thinking: { type: "disabled" },
      system: hadProfile ? SYSTEM_WITH_PROFILE : SYSTEM_NO_PROFILE,
      messages: [{ role: "user", content: userContent }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const tidied = tidyFitText(text);
    if (!tidied) return null;
    return { text: tidied, hadProfile };
  } catch (e) {
    console.error("[explainFitServerSide] failed", e);
    return null;
  }
}
