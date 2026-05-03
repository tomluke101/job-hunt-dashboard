"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase-server";
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
        .limit(15),
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
