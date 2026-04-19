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

export async function saveProfile(input: UserProfile) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase
    .from("user_profile")
    .upsert({ ...input, user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  revalidatePath("/profile");
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
  const { data } = await supabase
    .from("user_skills")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return data ?? [];
}

export async function addSkill(rawText: string, polishedText?: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_skills").insert({ user_id: userId, raw_text: rawText, polished_text: polishedText });
  revalidatePath("/profile");
}

export async function updateSkill(id: string, rawText: string, polishedText?: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase
    .from("user_skills")
    .update({ raw_text: rawText, polished_text: polishedText })
    .eq("id", id)
    .eq("user_id", userId);

  revalidatePath("/profile");
}

export async function deleteSkill(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  await supabase.from("user_skills").delete().eq("id", id).eq("user_id", userId);
  revalidatePath("/profile");
}

export async function polishSkillText(rawText: string): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    throw new Error("No AI provider connected. Add an API key in Settings.");
  }

  const result = await callAI({
    task: "cover-letter",
    connectedProviders: keys,
    systemPrompt:
      "You are an expert career coach helping job seekers articulate their achievements. " +
      "Rewrite the text in clear, professional language using strong action verbs. " +
      "Keep it to 1-2 punchy sentences. Preserve every fact exactly — do not invent or embellish anything. " +
      "Return ONLY the rewritten text with no explanation or preamble.",
    prompt: `Rewrite this in professional, achievement-focused language:\n\n"${rawText}"`,
  });

  return result.text.trim().replace(/^["']|["']$/g, "");
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
