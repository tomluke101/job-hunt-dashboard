"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { callAI } from "@/lib/ai-router";
import { extractFactBase, ExtractFactBaseOptions, ExtractFactBaseResult } from "@/lib/cv/extract";
import {
  tailorCV as tailorCVImpl,
  refineTailoredCV as refineTailoredCVImpl,
  TailorInput,
  RefineInput,
  TailorResult,
} from "@/lib/cv/tailor";
import {
  generateMasterProfileFromFactBase,
  tailorMasterToJD,
} from "@/lib/cv/master-profile";
import { getApiKeyValues } from "@/app/actions/api-keys";
import type { TailoredCV } from "@/lib/cv/tailored-cv";

export async function getFactBase(
  options: ExtractFactBaseOptions = {}
): Promise<ExtractFactBaseResult> {
  return extractFactBase(options);
}

export async function tailorCV(input: TailorInput): Promise<TailorResult> {
  return tailorCVImpl(input);
}

export async function refineTailoredCV(input: RefineInput): Promise<TailorResult> {
  return refineTailoredCVImpl(input);
}

// ── Master Profile ───────────────────────────────────────────────────────────
//
// The user's canonical Profile. Generated once with system help, edited freely,
// saved permanently. Every CV generation tailors this to the specific JD.

export interface MasterProfile {
  user_id: string;
  summary: string;
  source: "manual" | "generated" | "edited";
  factbase_hash: string | null;
  updated_at: string;
}

export async function getMasterProfile(): Promise<MasterProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[getMasterProfile] error:", error);
    return null;
  }
  return data as MasterProfile | null;
}

export async function saveMasterProfile(input: {
  summary: string;
  source?: "manual" | "generated" | "edited";
}): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!input.summary || !input.summary.trim()) return { error: "Profile is empty" };

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from("user_master_profile")
      .upsert(
        {
          user_id: userId,
          summary: input.summary.trim(),
          source: input.source ?? "manual",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );
    if (error) {
      console.error("[saveMasterProfile] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[saveMasterProfile] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function deleteMasterProfile(): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) return { error: "Not signed in" };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("user_master_profile")
    .delete()
    .eq("user_id", userId);
  if (error) {
    console.error("[deleteMasterProfile] error:", error);
    return { error: error.message };
  }
  revalidatePath("/profile");
  revalidatePath("/cv");
  return {};
}

export async function generateMasterProfile(input: {
  cvId?: string;
}): Promise<{ summary?: string; warnings: string[]; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { warnings: [], error: "No AI provider connected. Add an API key in Settings." };
  }
  return generateMasterProfileFromFactBase({
    cvId: input.cvId,
    connectedProviders: keys,
  });
}

export async function tailorMasterProfile(input: {
  master: string;
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
}): Promise<{ tailored?: string; warnings: string[]; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { warnings: [], error: "No AI provider connected. Add an API key in Settings." };
  }
  return tailorMasterToJD({
    master: input.master,
    jdText: input.jdText,
    cvId: input.cvId,
    companyName: input.companyName,
    roleName: input.roleName,
    connectedProviders: keys,
  });
}

// ── Profile Builder prefill — wizard reads this to populate fields/suggestions ──
export interface ProfileBuilderPrefill {
  currentJobTitle: string | null;
  currentCompany: string | null;
  currentSector: string | null;
  recentEmployers: Array<{ company: string; title: string; isCurrent: boolean }>;
  existingSkills: Array<{ id: string; text: string }>;
  educationSummary: string | null;
  distinctiveCandidates: string[]; // Skills containing sole/founding/only language
  fullName: string | null;
  headline: string | null;
}

// AI-assisted suggestion: takes the user's wizard answers + their existing
// Skills, and returns 3-5 specific "distinctive angles" they could claim.
// Used by Step 4 when users can't think of what's distinctive themselves.
export async function suggestDistinctiveAngles(input: {
  jobTitle?: string;
  companyOrSector?: string;
  achievement?: string;
  achievementScale?: string;
}): Promise<{ suggestions: string[]; error?: string }> {
  const { userId } = await auth();
  if (!userId) return { suggestions: [], error: "Not signed in" };

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { suggestions: [], error: "No AI provider connected. Add an API key in Settings." };
  }

  const supabase = await createServerSupabaseClient();
  const skillsRes = await supabase
    .from("user_skills")
    .select("raw_text, polished_text")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  const skills = (skillsRes.data ?? [])
    .map((s) => s.polished_text || s.raw_text)
    .filter(Boolean);

  const wizardContext = [
    input.jobTitle && `Current role: ${input.jobTitle}`,
    input.companyOrSector && `Company / sector: ${input.companyOrSector}`,
    input.achievement && `Headline achievement: ${input.achievement}`,
    input.achievementScale && `Scale: ${input.achievementScale}`,
  ]
    .filter(Boolean)
    .join("\n");

  const skillsContext = skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "(none)";

  const systemPrompt = `You help job-seekers identify what makes their situation distinctive — i.e. what would another candidate doing their same role NOT have. Read the user's role context and saved skills/achievements. Return 3-5 specific, evidence-grounded distinctive claims they could make.

These suggestions are pasted directly into the candidate's CV Profile. They must therefore follow ALL the same Profile rules:

EACH suggestion must:
- Be grounded in the user's actual data — never invent metrics, employers, sectors, scopes, or credentials. If the data doesn't say it, you don't say it.
- Be specific (not "you have lots of experience").
- Be distinctive — not "you do procurement", which every candidate at that role does.
- Be ONE short sentence, MAX 22 WORDS.
- Use IMPLIED FIRST PERSON. Start with the action or status — never "I", "I'm", "I've", "my", "me", and never a third-person verb at sentence start ("Manages…", "Holds…", "Leads…", "Owns…", "Builds…").
- Contain NO em-dashes. Use commas or full stops.
- Contain NO tricolons (no "X, Y, and Z" lists). Two items max.
- Contain NO banned vocabulary: spearhead, leverage, orchestrate, championed, drove, pioneered, synergise, utilise, streamline, robust, seamless, cutting-edge, results-driven, passionate, dynamic, proven, demonstrated, hands-on, forward-thinking, fast-paced, world-class, best-in-class, value-add.
- Contain NO opening adjective stack ("Dedicated, organised…").
- NOT name a current employer unless the FactBase shows it is brand-tier (FTSE 100, S&P 500, FAANG, MBB, Magic Circle, Big 4, household-name unicorn). If you're not sure, omit the employer name.

Examples of distinctive angles to look for:
- Sole / only person in their role
- Founder / first hire / founding-team member
- Reports unusually high (CEO / Founder / SLT)
- Built the function from scratch
- Cross-functional across multiple disciplines
- Unusually rapid promotion or scope expansion
- Distinctive credential (rare cert, top-tier school, named scholarship)
- Single-handedly handled a scope-stretch event (2x growth, crisis, transition)
- Sector cross-over (career-changer with rare combination)
- Demographic / pipeline distinctive (only graduate in senior team, etc.)

GOOD example: "Sole supply chain analyst at the business, reporting directly to the founder."
GOOD example: "First-class Economics from a Russell Group, top of the cohort."
GOOD example: "Built the function from scratch with no predecessor or playbook."
BAD example: "I'm spearheading a leverage-driven, cross-functional, cutting-edge transformation across procurement, finance, and operations." (banned vocab, tricolon, "I'm", em-dash)

Return ONLY a JSON object: { "suggestions": [string, string, string, string, string] }. 3-5 items. If you genuinely can't find 3 distinctive things in the user's data, return fewer. Never fabricate.`;

  const userPrompt = `=== USER'S ROLE CONTEXT ===
${wizardContext || "(not yet provided)"}

=== USER'S SAVED SKILLS / ACHIEVEMENTS ===
${skillsContext}

=== TASK ===
Identify 3-5 distinctive angles the user could claim. Return ONLY the JSON.`;

  try {
    const result = await callAI({
      task: "cv-tailor",
      connectedProviders: keys,
      systemPrompt,
      prompt: userPrompt,
    });
    const trimmed = result.text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return { suggestions: [] };
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { suggestions?: string[] };
    const cleaned = (parsed.suggestions ?? [])
      .filter((s): s is string => typeof s === "string" && !!s.trim())
      .map((s) => s.trim())
      .filter(passesProfileRulesSuggestion);
    return { suggestions: cleaned.slice(0, 5) };
  } catch (e) {
    console.error("[suggestDistinctiveAngles] error:", e);
    return { suggestions: [], error: e instanceof Error ? e.message : "AI call failed." };
  }
}

// Deterministic post-filter: drops any suggestion that breaks the Profile rules
// (em-dash, tricolon, first-person, banned vocab, length). Cheap insurance
// against the model occasionally ignoring the system prompt.
function passesProfileRulesSuggestion(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return false;

  // Word count cap — 22 words.
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount > 24) return false;
  if (wordCount < 4) return false;

  // No em-dashes.
  if (/[—–]/.test(t)) return false;

  // No first-person pronouns.
  if (/\b(?:I|I'm|I've|I'll|my|me|mine)\b/i.test(t)) return false;

  // No tricolons (X, Y, and Z).
  if (/,[^,]+,[^,]+\band\b/i.test(t)) return false;

  // No banned vocabulary.
  const banned = [
    "spearhead",
    "leverage",
    "orchestrate",
    "championed",
    "championing",
    "drove",
    "pioneered",
    "synergise",
    "synergize",
    "utilise",
    "utilize",
    "streamline",
    "robust",
    "seamless",
    "cutting-edge",
    "results-driven",
    "passionate",
    "dynamic",
    "proven",
    "demonstrated",
    "hands-on",
    "forward-thinking",
    "fast-paced",
    "world-class",
    "best-in-class",
    "value-add",
  ];
  const lower = t.toLowerCase();
  for (const b of banned) {
    if (lower.includes(b)) return false;
  }

  // No opening adjective stack ("Dedicated, organised, ...").
  if (/^[A-Z][a-z]+,\s+[a-z]+,/.test(t)) return false;

  return true;
}

export async function getProfileBuilderPrefill(): Promise<ProfileBuilderPrefill> {
  const empty: ProfileBuilderPrefill = {
    currentJobTitle: null,
    currentCompany: null,
    currentSector: null,
    recentEmployers: [],
    existingSkills: [],
    educationSummary: null,
    distinctiveCandidates: [],
    fullName: null,
    headline: null,
  };

  try {
    const { userId } = await auth();
    if (!userId) return empty;

    const supabase = await createServerSupabaseClient();
    const [profileRes, employersRes, skillsRes] = await Promise.all([
      supabase.from("user_profile").select("full_name, headline").eq("user_id", userId).maybeSingle(),
      supabase
        .from("user_employers")
        .select("company_name, role_title, is_current, end_date, start_date")
        .eq("user_id", userId)
        .order("is_current", { ascending: false })
        .order("end_date", { ascending: false, nullsFirst: true })
        .order("start_date", { ascending: false })
        .limit(5),
      supabase
        .from("user_skills")
        .select("id, raw_text, polished_text")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const employers = employersRes.data ?? [];
    const skills = skillsRes.data ?? [];
    const profile = profileRes.data ?? null;

    const currentEmp = employers.find((e) => e.is_current) ?? null;
    const distinctiveRegex = /\b(?:sole|only|founding|first[- ]hire|first[- ]ever|single[- ]handed)\b/i;

    return {
      currentJobTitle: currentEmp?.role_title ?? null,
      currentCompany: currentEmp?.company_name ?? null,
      currentSector: null, // user can fill if not derivable
      recentEmployers: employers.map((e) => ({
        company: e.company_name,
        title: e.role_title,
        isCurrent: !!e.is_current,
      })),
      existingSkills: skills.map((s) => ({
        id: s.id,
        text: s.polished_text || s.raw_text,
      })),
      educationSummary: null,
      distinctiveCandidates: skills
        .map((s) => s.polished_text || s.raw_text)
        .filter((t) => distinctiveRegex.test(t))
        .slice(0, 3),
      fullName: profile?.full_name ?? null,
      headline: profile?.headline ?? null,
    };
  } catch (e) {
    console.error("[getProfileBuilderPrefill] error:", e);
    return empty;
  }
}

// ── Saved tailored CVs (linked to applications) ──────────────────────────────

export interface SavedTailoredCV {
  id: string;
  application_id: string | null;
  company: string | null;
  role: string | null;
  jd_text: string | null;
  tailored_data: TailoredCV | null;   // null for manually-pasted CVs
  content: string | null;             // plain text fallback (always populated)
  created_at: string;
}

export async function saveTailoredCV(input: {
  tailoredCV: TailoredCV;
  applicationId?: string;
  companyName?: string;
  roleName?: string;
  jdText?: string;
}): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    const supabase = await createServerSupabaseClient();
    const plain = serialiseTailoredCVPlain(input.tailoredCV);

    const { data, error } = await supabase
      .from("cv_versions")
      .insert({
        user_id: userId,
        application_id: input.applicationId ?? null,
        company: input.companyName ?? null,
        role: input.roleName ?? null,
        jd_text: input.jdText ?? null,
        tailored_data: input.tailoredCV,
        content: plain,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[saveTailoredCV] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/tracker");
    revalidatePath("/cv");
    return { id: data?.id };
  } catch (e) {
    console.error("[saveTailoredCV] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save tailored CV." };
  }
}

export async function getSavedTailoredCVs(
  applicationId?: string
): Promise<SavedTailoredCV[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const query = supabase
    .from("cv_versions")
    .select("id, application_id, company, role, jd_text, tailored_data, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (applicationId) {
    query.eq("application_id", applicationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[getSavedTailoredCVs] error:", error);
    return [];
  }
  return (data ?? []) as SavedTailoredCV[];
}

// Save a CV that was used externally (not generated by the SaaS) — paste-and-attach.
export async function saveManualCV(
  applicationId: string,
  content: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!content || !content.trim()) return { error: "CV content is empty" };

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("cv_versions")
      .insert({
        user_id: userId,
        application_id: applicationId,
        content: content.trim(),
        tailored_data: null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[saveManualCV] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/tracker");
    return { id: data?.id };
  } catch (e) {
    console.error("[saveManualCV] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save CV." };
  }
}

function serialiseTailoredCVPlain(cv: TailoredCV): string {
  const lines: string[] = [];
  lines.push(cv.contact.name);
  lines.push(
    [cv.contact.location, cv.contact.email, cv.contact.phone, cv.contact.linkedin]
      .filter(Boolean)
      .join("  ·  ")
  );
  if (cv.summary) {
    lines.push("", "PROFILE", cv.summary);
  }
  if (cv.skills.length > 0) {
    lines.push("", "KEY SKILLS");
    for (const g of cv.skills) lines.push(`${g.category}: ${g.items.join(", ")}`);
  }
  if (cv.roles.length > 0) {
    lines.push("", "EXPERIENCE");
    for (const r of cv.roles) {
      const dates = r.isCurrent ? `${r.startDate} – Present` : `${r.startDate} – ${r.endDate ?? ""}`;
      lines.push(`${r.title} — ${r.company}${r.location ? `, ${r.location}` : ""} (${dates.trim()})`);
      for (const b of r.bullets) lines.push(`• ${b}`);
    }
  }
  if (cv.education.length > 0) {
    lines.push("", "EDUCATION");
    for (const e of cv.education) {
      const years = [e.startYear, e.endYear].filter(Boolean).join(" – ");
      lines.push(`${e.qualification} — ${e.institution}${e.classification ? ` (${e.classification})` : ""}${years ? ` [${years}]` : ""}`);
      if (e.details) lines.push(`  ${e.details}`);
    }
  }
  if (cv.certifications.length > 0) {
    lines.push("", "CERTIFICATIONS");
    for (const c of cv.certifications) {
      const meta = [c.issuer, c.year].filter(Boolean).join(", ");
      lines.push(`• ${c.content}${meta ? ` (${meta})` : ""}`);
    }
  }
  if (cv.languages.length > 0) {
    lines.push("", "LANGUAGES", cv.languages.map((l) => `${l.language} (${l.proficiency})`).join(", "));
  }
  if (cv.interests.length > 0) {
    lines.push("", "INTERESTS", cv.interests.join(", "));
  }
  return lines.join("\n");
}
