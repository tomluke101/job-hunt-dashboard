"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";
import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserProfile {
  full_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  location?: string;
  headline?: string;
  sign_off?: string;
  tone?: "formal" | "balanced" | "conversational";
}

export interface UserCV {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
}

export interface UserSkill {
  id: string;
  raw_text: string;
  polished_text?: string;
  created_at: string;
  employer_ids?: string[];
}

export interface UserEmployer {
  id: string;
  company_name: string;
  role_title: string;
  start_date: string;
  end_date?: string | null;
  is_current: boolean;
  location?: string | null;
  employment_type?: string | null;
  summary?: string | null;
  salary?: string | null;
  display_order: number;
  created_at: string;
}

export interface UserEmployerInput {
  company_name: string;
  role_title: string;
  start_date: string;
  end_date?: string | null;
  is_current: boolean;
  location?: string | null;
  employment_type?: string | null;
  summary?: string | null;
  salary?: string | null;
}

export interface WritingExample {
  id: string;
  label?: string;
  content: string;
  created_at: string;
}

// ── Profile constants ─────────────────────────────────────────────────────────

export async function getProfile(): Promise<UserProfile> {
  const { userId } = await auth();
  if (!userId) return {};

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_profile")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data ?? {};
}

export async function saveProfile(input: UserProfile): Promise<{ error?: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = createServerSupabaseClient();
  const { error } = await supabase
    .from("user_profile")
    .upsert({ ...input, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  revalidatePath("/profile");
  if (error) return { error: error.message };
  return {};
}

// ── CVs ───────────────────────────────────────────────────────────────────────

export async function getCVs(): Promise<UserCV[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_cvs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

export async function saveCV(name: string, content: string, setAsDefault: boolean) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();

  if (setAsDefault) {
    await supabase.from("user_cvs").update({ is_default: false }).eq("user_id", userId);
  }

  await supabase.from("user_cvs").insert({ user_id: userId, name, content, is_default: setAsDefault });
  revalidatePath("/profile");
}

export async function setDefaultCV(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_cvs").update({ is_default: false }).eq("user_id", userId);
  await supabase.from("user_cvs").update({ is_default: true }).eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

export async function deleteCV(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_cvs").delete().eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

// ── Skills & experience ───────────────────────────────────────────────────────

export async function getSkills(): Promise<UserSkill[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const [skillsResult, linksResult] = await Promise.all([
    supabase.from("user_skills").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
    supabase.from("user_skill_employers").select("skill_id, employer_id"),
  ]);

  const skills = skillsResult.data ?? [];
  const links = linksResult.data ?? [];

  const linksBySkill = new Map<string, string[]>();
  for (const link of links) {
    const list = linksBySkill.get(link.skill_id) ?? [];
    list.push(link.employer_id);
    linksBySkill.set(link.skill_id, list);
  }

  return skills.map((s) => ({ ...s, employer_ids: linksBySkill.get(s.id) ?? [] }));
}

export async function addSkill(rawText: string, polishedText?: string, employerIds?: string[]) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_skills")
    .insert({ user_id: userId, raw_text: rawText, polished_text: polishedText })
    .select("id")
    .single();

  if (data?.id && employerIds && employerIds.length > 0) {
    await supabase.from("user_skill_employers").insert(
      employerIds.map((employer_id) => ({ skill_id: data.id, employer_id }))
    );
  }

  revalidatePath("/profile");
}

export async function updateSkill(id: string, rawText: string, polishedText?: string | null, employerIds?: string[]) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const normalisedPolished = polishedText && polishedText.trim() ? polishedText.trim() : null;

  const supabase = await createServerSupabaseClient();
  await supabase
    .from("user_skills")
    .update({ raw_text: rawText, polished_text: normalisedPolished })
    .eq("id", id)
    .eq("user_id", userId);

  if (employerIds !== undefined) {
    await supabase.from("user_skill_employers").delete().eq("skill_id", id);
    if (employerIds.length > 0) {
      await supabase.from("user_skill_employers").insert(
        employerIds.map((employer_id) => ({ skill_id: id, employer_id }))
      );
    }
  }

  revalidatePath("/profile");
}

export async function deleteSkill(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_skills").delete().eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

// ── Work history (employers) ──────────────────────────────────────────────────

// Normalise a month-precision date string (YYYY-MM) to a Postgres-acceptable
// full date (YYYY-MM-01). Pass through valid YYYY-MM-DD strings as-is. Returns
// null for empty / invalid input so we never write garbage.
function normaliseMonthDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  return null;
}

export async function getEmployers(): Promise<UserEmployer[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_employers")
    .select("*")
    .eq("user_id", userId)
    .order("is_current", { ascending: false })
    .order("end_date", { ascending: false, nullsFirst: true })
    .order("start_date", { ascending: false });

  return data ?? [];
}

export async function addEmployer(input: UserEmployerInput): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!input.company_name?.trim() || !input.role_title?.trim() || !input.start_date) {
      return { error: "Company, role, and start date are required" };
    }

    const startDate = normaliseMonthDate(input.start_date);
    if (!startDate) return { error: "Start date must be a valid month." };
    const endDate = input.is_current ? null : normaliseMonthDate(input.end_date);

    const supabase = await createServerSupabaseClient();
    const payload = {
      user_id: userId,
      company_name: input.company_name.trim(),
      role_title: input.role_title.trim(),
      start_date: startDate,
      end_date: endDate,
      is_current: !!input.is_current,
      location: input.location?.trim() || null,
      employment_type: input.employment_type || null,
      summary: input.summary?.trim() || null,
      salary: input.salary?.trim() || null,
    };

    const { data, error } = await supabase
      .from("user_employers")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.error("[addEmployer] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    return { id: data?.id };
  } catch (e) {
    console.error("[addEmployer] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to add" };
  }
}

export async function updateEmployer(id: string, input: UserEmployerInput): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    if (!input.company_name?.trim() || !input.role_title?.trim() || !input.start_date) {
      return { error: "Company, role, and start date are required" };
    }

    const startDate = normaliseMonthDate(input.start_date);
    if (!startDate) return { error: "Start date must be a valid month." };
    const endDate = input.is_current ? null : normaliseMonthDate(input.end_date);

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from("user_employers")
      .update({
        company_name: input.company_name.trim(),
        role_title: input.role_title.trim(),
        start_date: startDate,
        end_date: endDate,
        is_current: !!input.is_current,
        location: input.location?.trim() || null,
        employment_type: input.employment_type || null,
        summary: input.summary?.trim() || null,
        salary: input.salary?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      console.error("[updateEmployer] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    return {};
  } catch (e) {
    console.error("[updateEmployer] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to update" };
  }
}

export async function deleteEmployer(id: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_employers").delete().eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

export async function extractEmployersFromCV(cvId?: string): Promise<{ employers?: UserEmployerInput[]; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    const keys = await getApiKeyValues();
    if (Object.keys(keys).length === 0) {
      return { error: "No AI provider connected. Add an API key in Settings first." };
    }

    const supabase = await createServerSupabaseClient();
    const { data: cvs } = await supabase
      .from("user_cvs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    const cv = cvId ? (cvs ?? []).find((c) => c.id === cvId) : (cvs ?? []).find((c) => c.is_default) ?? (cvs ?? [])[0];
    if (!cv) return { error: "No CV found. Upload your CV first." };

    const result = await callAI({
      task: "cover-letter",
      connectedProviders: keys,
      systemPrompt:
        "You extract structured work history from CVs. Return ONLY a valid JSON object — no preamble, no commentary, no markdown fences. The schema is exactly: " +
        '{"employers":[{"company_name":string,"role_title":string,"start_date":"YYYY-MM","end_date":"YYYY-MM"|null,"is_current":boolean,"location":string|null,"employment_type":"full-time"|"part-time"|"contract"|"internship"|"freelance"|null,"summary":string|null}]}. ' +
        "Rules: " +
        "(1) Extract only paid employment, internships, contracts. Skip volunteering, education, courses, certifications, hobbies. " +
        "(2) Order from most recent first. " +
        "(3) If end date is 'Present' / 'Current' / 'Now' / similar, set is_current=true and end_date=null. " +
        "(4) Dates must be YYYY-MM format. If only a year is given, use YYYY-01 for start and YYYY-12 for end. Be conservative — never invent dates. " +
        "(5) summary: one short sentence (max 15 words) on the role's main responsibility. If the CV doesn't make it clear, set null. " +
        "(6) Never include salary or pay information. " +
        "(7) Return ONLY the JSON object.",
      prompt: `Extract the work history from this CV:\n\n${cv.content.slice(0, 10000)}`,
    });

    const text = result.text.trim();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      return { error: "Could not parse the CV. Try adding entries manually." };
    }

    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { employers?: UserEmployerInput[] };
    const list = Array.isArray(parsed.employers) ? parsed.employers : [];

    const cleaned: UserEmployerInput[] = list
      .filter((e) => e && e.company_name && e.role_title && e.start_date)
      .map((e) => ({
        company_name: String(e.company_name).trim(),
        role_title: String(e.role_title).trim(),
        start_date: String(e.start_date).trim(),
        end_date: e.is_current ? null : (e.end_date ? String(e.end_date).trim() : null),
        is_current: !!e.is_current,
        location: e.location ? String(e.location).trim() : null,
        employment_type: e.employment_type ?? "full-time",
        summary: e.summary ? String(e.summary).trim() : null,
        salary: null,
      }));

    return { employers: cleaned };
  } catch (e) {
    console.error("[extractEmployersFromCV] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Extraction failed. Try adding entries manually." };
  }
}

export async function polishSkillText(rawText: string): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  if (!rawText || !rawText.trim()) {
    throw new Error("Cannot polish empty text.");
  }

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    throw new Error("No AI provider connected. Add an API key in Settings.");
  }

  try {
    const result = await callAI({
      task: "cover-letter",
      connectedProviders: keys,
      systemPrompt:
        "You are an expert career coach helping job seekers articulate their achievements. " +
        "Rewrite the text in clear, professional language using strong action verbs. " +
        "Keep it to 1-2 punchy sentences. Preserve every fact exactly — do not invent or embellish anything. " +
        "CRITICAL: preserve every mention of collaborators (manager, director, team, colleague, partner) exactly as stated in the source. " +
        "Do not drop, minimise, or obscure other people's contributions. If the source says 'with my director' or 'alongside my manager' or 'as part of the team', the rewrite must keep that. " +
        "Do not upgrade neutral verbs into solo-claim verbs: 'built' must not become 'designed and built from scratch'; 'helped set up' must not become 'led the setup of'. " +
        "If the source does not explicitly state solo ownership, use neutral verbs ('worked on', 'helped build', 'contributed to') rather than strong solo verbs ('I built', 'I led', 'I created'). " +
        "Return ONLY the rewritten text with no explanation or preamble.",
      prompt: `Rewrite this in professional, achievement-focused language:\n\n"${rawText}"`,
    });

    const cleaned = result.text.trim().replace(/^["']|["']$/g, "");
    if (!cleaned) throw new Error("AI returned an empty response.");
    return cleaned;
  } catch (e) {
    console.error("[polishSkillText] AI call failed:", e);
    throw new Error(e instanceof Error ? e.message : "Polish failed. Check your API key and try again.");
  }
}

// ── Writing examples ──────────────────────────────────────────────────────────

export async function getWritingExamples(): Promise<WritingExample[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_writing_examples")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return data ?? [];
}

export async function addWritingExample(content: string, label?: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_writing_examples").insert({ user_id: userId, content, label });
  revalidatePath("/profile");
}

export async function deleteWritingExample(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_writing_examples").delete().eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

// ── Cover letter preferences ──────────────────────────────────────────────────

export interface CoverLetterPrefs {
  salutation?: string;
  include_header?: boolean;
  always_mention?: string;
  never_do?: string;
  extra_tone_notes?: string;
  enable_skill_discovery?: boolean;
}

export async function getCoverLetterPrefs(): Promise<CoverLetterPrefs> {
  const { userId } = await auth();
  if (!userId) return {};

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("cover_letter_prefs")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data ?? {};
}

export async function saveCoverLetterPrefs(prefs: CoverLetterPrefs) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase
    .from("cover_letter_prefs")
    .upsert({ user_id: userId, ...prefs }, { onConflict: "user_id" });

  revalidatePath("/profile");
}

// ── Profile completeness (for progress indicator) ─────────────────────────────

export interface ProfileCompleteness {
  hasCV: boolean;
  hasSkills: boolean;
  hasConstants: boolean;
  hasWritingExamples: boolean;
  score: number; // 0-4
}

export async function getProfileCompleteness(): Promise<ProfileCompleteness> {
  const { userId } = await auth();
  if (!userId) return { hasCV: false, hasSkills: false, hasConstants: false, hasWritingExamples: false, score: 0 };

  const supabase = await createServerSupabaseClient();

  const [cvs, skills, profile, examples] = await Promise.all([
    supabase.from("user_cvs").select("id").eq("user_id", userId).limit(1),
    supabase.from("user_skills").select("id").eq("user_id", userId).limit(1),
    supabase.from("user_profile").select("full_name, email").eq("user_id", userId).maybeSingle(),
    supabase.from("user_writing_examples").select("id").eq("user_id", userId).limit(1),
  ]);

  const hasCV = (cvs.data?.length ?? 0) > 0;
  const hasSkills = (skills.data?.length ?? 0) > 0;
  const hasConstants = !!(profile.data?.full_name && profile.data?.email);
  const hasWritingExamples = (examples.data?.length ?? 0) > 0;

  return {
    hasCV,
    hasSkills,
    hasConstants,
    hasWritingExamples,
    score: [hasCV, hasSkills, hasConstants, hasWritingExamples].filter(Boolean).length,
  };
}
