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
  scanExcludedPhrases,
} from "@/lib/cv/master-profile";
import { scanProfile, scanBannedPhrases } from "@/lib/cv/tailor";
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

// ── Master Profiles (multi-Master) ───────────────────────────────────────────
//
// Users can save multiple Masters (e.g. "Supply Chain Analyst", "Commercial
// Property Master") with one marked as default. CV tailoring uses the user's
// chosen Master per JD; if not specified, the default is used.

export interface MasterProfile {
  id: string;
  user_id: string;
  name: string;
  summary: string;
  source: "manual" | "generated" | "edited";
  factbase_hash: string | null;
  updated_at: string;
  created_at: string;
  is_default: boolean;
  // Per-Master "never include in Profile" list. Phrases the AI must honour
  // when this Master is in use (Master generator + per-CV Adapt prompts).
  exclusions: string[];
  // Target role family this Master is framed for (e.g. "Procurement",
  // "Consulting", "Product Management"). Drives AI generation, gap detection,
  // and Adapt — the AI surfaces FactBase evidence relevant to this target
  // and reframes vocabulary appropriately. NULL = sector-agnostic.
  target_role_family: string | null;
  // Optional target sector / industry (e.g. "Financial services", "FMCG",
  // "Tech"). Adds further specificity when present.
  target_sector: string | null;
}

function rowToMaster(data: Record<string, unknown>): MasterProfile {
  const exclusions: string[] = Array.isArray(data.exclusions)
    ? (data.exclusions as unknown[]).filter(
        (e): e is string => typeof e === "string" && !!e.trim()
      )
    : [];
  const rawFamily = data.target_role_family;
  const rawSector = data.target_sector;
  return {
    id: String(data.id ?? ""),
    user_id: String(data.user_id ?? ""),
    name: String(data.name ?? "My Master"),
    summary: String(data.summary ?? ""),
    source: (data.source as MasterProfile["source"]) ?? "manual",
    factbase_hash: (data.factbase_hash as string | null) ?? null,
    updated_at: String(data.updated_at ?? ""),
    created_at: String(data.created_at ?? data.updated_at ?? ""),
    is_default: !!data.is_default,
    exclusions,
    target_role_family:
      typeof rawFamily === "string" && rawFamily.trim() ? rawFamily : null,
    target_sector:
      typeof rawSector === "string" && rawSector.trim() ? rawSector : null,
  };
}

// List every Master the signed-in user has saved, default first.
export async function getMasterProfiles(): Promise<MasterProfile[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[getMasterProfiles] error:", error);
    return [];
  }
  return (data ?? []).map((row) => rowToMaster(row as Record<string, unknown>));
}

// Get the user's default Master, or null if they have none.
export async function getDefaultMasterProfile(): Promise<MasterProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) {
    console.error("[getDefaultMasterProfile] error:", error);
    return null;
  }
  return data ? rowToMaster(data as Record<string, unknown>) : null;
}

// Get a specific Master by id (RLS ensures it's the user's own).
export async function getMasterProfileById(id: string): Promise<MasterProfile | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("user_master_profile")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[getMasterProfileById] error:", error);
    return null;
  }
  return data ? rowToMaster(data as Record<string, unknown>) : null;
}

// Backwards-compat alias for the single-Master era. New code should use
// getDefaultMasterProfile() or getMasterProfileById(id).
export async function getMasterProfile(): Promise<MasterProfile | null> {
  return getDefaultMasterProfile();
}

// Save (insert OR update) a Master. id present = update; absent = insert new.
// On insert, becomes the default if the user has none yet, otherwise follows
// the explicit isDefault flag.
export async function saveMaster(input: {
  id?: string;
  name?: string;
  summary: string;
  source?: "manual" | "generated" | "edited";
  isDefault?: boolean;
  // When true, allow empty summary (used for "Add blank Master" — the row
  // exists as a stub the user fills in. tailorCV detects empty summary and
  // falls back to the no-Master AI generation path.)
  allowEmpty?: boolean;
  // Target role family this Master is framed for (e.g. "Procurement",
  // "Consulting", "Product Management"). NULL = sector-agnostic. Drives
  // generation + gap detection + Adapt to surface family-relevant evidence.
  targetRoleFamily?: string | null;
  targetSector?: string | null;
}): Promise<{ error?: string; id?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const trimmedSummary = (input.summary ?? "").trim();
    if (!trimmedSummary && !input.allowEmpty) {
      return { error: "Profile is empty" };
    }

    const supabase = await createServerSupabaseClient();
    const trimmedName = (input.name ?? "").trim() || "My Master";
    const source = input.source ?? "manual";
    // Normalise target fields: trim, treat empty as null. undefined means
    // "don't touch this field" (so callers can update just summary/name
    // without clobbering target metadata).
    const normaliseTarget = (v: string | null | undefined) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const t = v.trim();
      return t.length > 0 ? t : null;
    };
    const targetRoleFamily = normaliseTarget(input.targetRoleFamily);
    const targetSector = normaliseTarget(input.targetSector);

    if (input.id) {
      // Update existing Master (preserving exclusions / default flag unless overridden).
      const update: Record<string, unknown> = {
        summary: trimmedSummary,
        name: trimmedName,
        source,
        updated_at: new Date().toISOString(),
      };
      if (typeof input.isDefault === "boolean") update.is_default = input.isDefault;
      if (targetRoleFamily !== undefined) update.target_role_family = targetRoleFamily;
      if (targetSector !== undefined) update.target_sector = targetSector;
      const { error } = await supabase
        .from("user_master_profile")
        .update(update)
        .eq("id", input.id)
        .eq("user_id", userId);
      if (error) {
        console.error("[saveMaster] update error:", error);
        return { error: error.message };
      }
      // If we just set this one default, demote others.
      if (input.isDefault === true) {
        await supabase
          .from("user_master_profile")
          .update({ is_default: false })
          .eq("user_id", userId)
          .neq("id", input.id);
      }
      revalidatePath("/profile");
      revalidatePath("/cv");
      return { id: input.id };
    }

    // Insert new Master. If user has no Masters yet, this one becomes default.
    const { data: existing } = await supabase
      .from("user_master_profile")
      .select("id")
      .eq("user_id", userId)
      .limit(1);
    const willBeFirst = !existing || existing.length === 0;
    const isDefault = input.isDefault ?? willBeFirst;

    if (isDefault && !willBeFirst) {
      // Demote current default before inserting the new one (partial unique index).
      await supabase
        .from("user_master_profile")
        .update({ is_default: false })
        .eq("user_id", userId)
        .eq("is_default", true);
    }

    const insertRow: Record<string, unknown> = {
      user_id: userId,
      name: trimmedName,
      summary: trimmedSummary,
      source,
      is_default: isDefault,
      updated_at: new Date().toISOString(),
    };
    if (targetRoleFamily !== undefined) insertRow.target_role_family = targetRoleFamily;
    if (targetSector !== undefined) insertRow.target_sector = targetSector;

    const { data: inserted, error } = await supabase
      .from("user_master_profile")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) {
      console.error("[saveMaster] insert error:", error);
      return { error: error.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return { id: inserted?.id };
  } catch (e) {
    console.error("[saveMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save." };
  }
}

// Backwards-compat: save (or upsert) the default Master. Maintained for any
// callers that haven't migrated to saveMaster() yet.
export async function saveMasterProfile(input: {
  summary: string;
  source?: "manual" | "generated" | "edited";
}): Promise<{ error?: string }> {
  // Find the user's default (if any) and update; otherwise insert as default.
  const { userId } = await auth();
  if (!userId) return { error: "Not signed in" };
  const existing = await getDefaultMasterProfile();
  return saveMaster({
    id: existing?.id,
    name: existing?.name ?? "My Master",
    summary: input.summary,
    source: input.source,
    isDefault: true,
  });
}

// Set which Master is the user's default. Atomically demotes the current
// default and promotes the chosen one.
export async function setDefaultMaster(id: string): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const supabase = await createServerSupabaseClient();
    // Demote all of user's Masters first, then promote the chosen one.
    const { error: demoteErr } = await supabase
      .from("user_master_profile")
      .update({ is_default: false })
      .eq("user_id", userId)
      .neq("id", id);
    if (demoteErr) {
      console.error("[setDefaultMaster] demote error:", demoteErr);
      return { error: demoteErr.message };
    }
    const { error: promoteErr } = await supabase
      .from("user_master_profile")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
    if (promoteErr) {
      console.error("[setDefaultMaster] promote error:", promoteErr);
      return { error: promoteErr.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[setDefaultMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to set default." };
  }
}

// ── User-level exclusions ──────────────────────────────────────────────
// Phrases the user never wants in ANY Profile. Stored on user_profile,
// applied to every Profile generation path (Master gen, per-CV adapt,
// no-Master AI generation, scan-as-you-type). Replaces the old per-Master
// exclusions which proved too granular for typical use.

export async function getUserExclusions(): Promise<string[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_profile")
    .select("profile_exclusions")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return [];
  const raw = (data as { profile_exclusions?: unknown }).profile_exclusions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is string => typeof e === "string" && !!e.trim());
}

export async function setUserExclusions(
  exclusions: string[]
): Promise<{ error?: string; needsMigration?: boolean }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    // Sanitise: trim, drop empties, dedupe (case-insensitive), cap to 50.
    const cleaned = Array.from(
      new Map(
        exclusions
          .map((e) => (typeof e === "string" ? e.trim() : ""))
          .filter(Boolean)
          .map((e) => [e.toLowerCase(), e])
      ).values()
    ).slice(0, 50);

    const supabase = await createServerSupabaseClient();
    // Upsert: ensure user_profile row exists for this user, then set exclusions.
    const { data: existing } = await supabase
      .from("user_profile")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("user_profile")
        .update({
          profile_exclusions: cleaned,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      if (error) {
        const code = String((error as { code?: string }).code ?? "");
        if (
          code === "42703" ||
          /column .*profile_exclusions.* does not exist/i.test(error.message ?? "") ||
          /could not find the .*profile_exclusions.* column/i.test(error.message ?? "")
        ) {
          return {
            error:
              "The exclusions feature needs a one-line database migration. Run the SQL in your Supabase dashboard, then try again.",
            needsMigration: true,
          };
        }
        return { error: error.message };
      }
    } else {
      const { error } = await supabase
        .from("user_profile")
        .insert({ user_id: userId, profile_exclusions: cleaned });
      if (error) return { error: error.message };
    }
    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[setUserExclusions] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to save exclusions." };
  }
}

// Delete a Master by id. If it was the default and others remain, the
// most-recently-updated other becomes the new default.
export async function deleteMaster(id: string): Promise<{ error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const supabase = await createServerSupabaseClient();

    // Fetch the row to know if it was default.
    const { data: row } = await supabase
      .from("user_master_profile")
      .select("id, is_default")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!row) return { error: "Master not found." };

    const { error: delErr } = await supabase
      .from("user_master_profile")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    if (delErr) {
      console.error("[deleteMaster] error:", delErr);
      return { error: delErr.message };
    }

    // Promote a replacement default if needed.
    if (row.is_default) {
      const { data: replacement } = await supabase
        .from("user_master_profile")
        .select("id")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (replacement && replacement.length > 0) {
        await supabase
          .from("user_master_profile")
          .update({ is_default: true })
          .eq("id", replacement[0].id);
      }
    }

    revalidatePath("/profile");
    revalidatePath("/cv");
    return {};
  } catch (e) {
    console.error("[deleteMaster] unexpected:", e);
    return { error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

// Backwards-compat: deletes the user's default Master.
export async function deleteMasterProfile(): Promise<{ error?: string }> {
  const def = await getDefaultMasterProfile();
  if (!def) return {};
  return deleteMaster(def.id);
}

export async function generateMasterProfile(input: {
  cvId?: string;
  // Optional ad-hoc context from the Profile Builder Wizard. Treated as
  // truth-grounded supplementary data, not persisted to user_skills /
  // user_employers. Used only for THIS generation call.
  wizardContext?: WizardContext;
  // Target role family this Master is framed for. When set, the AI surfaces
  // FactBase evidence relevant to this family and reframes vocabulary
  // appropriately. NULL/undefined = sector-agnostic generation.
  targetRoleFamily?: string | null;
  targetSector?: string | null;
  // Optional — FactBase fit assessment for the target family (from the gap
  // detector). When "transferable" or "minimal", the Master generation
  // prompt FORCES the CAREER-CHANGER template + pivot framing, producing
  // an honest Profile instead of a confident-sounding fake. Defaults to
  // "strong" (normal generation).
  factbaseFitForFamily?: "strong" | "transferable" | "minimal";
  transferableAngles?: string[];
}): Promise<{ summary?: string; warnings: string[]; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { warnings: [], error: "No AI provider connected. Add an API key in Settings." };
  }
  // Pull the user's GLOBAL exclusions so they're honoured by every
  // Profile generation, regardless of whether a Master exists yet.
  const exclusions = await getUserExclusions();
  return generateMasterProfileFromFactBase({
    exclusions,
    cvId: input.cvId,
    connectedProviders: keys,
    wizardContext: input.wizardContext,
    targetRoleFamily: input.targetRoleFamily ?? undefined,
    targetSector: input.targetSector ?? undefined,
    factbaseFitForFamily: input.factbaseFitForFamily,
    transferableAngles: input.transferableAngles,
  });
}

// Mirror of WizardAnswers — kept here so the server action signature doesn't
// have to import client component types.
export interface WizardContext {
  stage:
    | "working"
    | "self_employed"
    | "founder"
    | "student"
    | "between"
    | "returner"
    | "other"
    | null;
  jobTitle?: string;
  companyOrSector?: string;
  freelanceDiscipline?: string;
  freelanceYears?: string;
  freelanceSector?: string;
  businessName?: string;
  businessDoes?: string;
  businessFoundedYear?: string;
  degreeSubject?: string;
  university?: string;
  graduationYear?: string;
  lastJobTitle?: string;
  lastJobSector?: string;
  timeOut?: string;
  otherSituation?: string;
  achievement?: string;
  achievementScale?: string;
  achievementOutcome?: string;
  supportingAchievements?: string[];
  distinctive?: string;
  educationToInclude?: string;
  educationPlacement?: "lead" | "close" | "skip";
  anythingElse?: string;
}

export async function tailorMasterProfile(input: {
  master: string;
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  exclusions?: string[];
  // Target role family of the Master being adapted. Adds family register
  // to the Adapt prompt so vocabulary + emphasis match the candidate's
  // declared career direction (alongside JD-driven re-emphasis).
  targetRoleFamily?: string | null;
  targetSector?: string | null;
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
    exclusions: input.exclusions,
    connectedProviders: keys,
    targetRoleFamily: input.targetRoleFamily ?? undefined,
    targetSector: input.targetSector ?? undefined,
  });
}

// ── Inline Profile-text scanning (P2) ───────────────────────────────────
// Wraps the deterministic scanProfile + exclusions check for client-side
// MasterCard inline feedback. Returns flagged issues as { hint, where }
// pairs the UI can render directly under the textarea.
//
// Cheap and safe — pure regex, no AI calls. Debounced client-side.
export interface ProfileScanIssue {
  // Short user-facing label of the rule violated, e.g. "Tricolon", "Em-dash",
  // "Excluded phrase", "Banned vocabulary".
  rule: string;
  // The full explanation from the scanner, with the suggested fix where
  // applicable. Rendered as the body of the inline warning row.
  detail: string;
}

export async function scanProfileText(input: {
  text: string;
}): Promise<{ issues: ProfileScanIssue[] }> {
  const text = (input.text ?? "").trim();
  if (!text) return { issues: [] };

  // Pull user-level exclusions server-side so the client doesn't need to
  // pass them. These apply globally across every Master.
  const exclusions = await getUserExclusions();

  // Build a minimal TailoredCV stub for scanProfile. Scanners only read
  // .summary and (for brand-tier check) .roles[0].company. We leave roles
  // empty so the brand-tier scanner doesn't false-flag.
  const stub: TailoredCV = {
    contact: { name: "", email: null, phone: null, location: null, linkedin: null },
    summary: text,
    skills: [],
    roles: [],
    education: [],
    certifications: [],
    languages: [],
    interests: [],
    jdKeywords: [],
    gaps: [],
  };

  const flagged = [
    ...scanProfile(stub),
    // scanBannedPhrases catches AI-tell vocabulary like "spearheading",
    // "fast-paced", "leverage" that scanProfile doesn't cover. We restrict
    // its scope to the summary by handing it the stub (no skills/roles/etc.).
    ...scanBannedPhrases(stub),
    ...scanExcludedPhrases({ summary: text, exclusions }),
  ];

  // Convert flagged hits into compact issues with a short rule label so the
  // UI can group / colour them.
  const issues: ProfileScanIssue[] = flagged.map((f) => ({
    rule: ruleLabelFromPhrase(f.phrase),
    detail: f.phrase,
  }));
  return { issues };
}

function ruleLabelFromPhrase(phrase: string): string {
  const p = phrase.toLowerCase();
  if (/tricolon/.test(p)) return "Tricolon";
  if (/em-dash/.test(p)) return "Em-dash";
  if (/first-person pronoun|third-person verb|implied first person/.test(p))
    return "Voice";
  if (/structural hedge|period of/.test(p)) return "Hedge";
  if (/sole\/ownership claim|anchor leak/.test(p)) return "Anchor placement";
  if (/scope anchor.*S2 only|S1 contains a scope anchor/.test(p))
    return "Scope-anchor leak";
  if (/no outcome signal/.test(p)) return "Missing outcome";
  if (/passive cv-speak|introducer verb/.test(p)) return "Passive close";
  if (/connective fluff|specialising in|focusing on/.test(p)) return "S1 fluff";
  if (/jammed|action verbs jammed/.test(p)) return "Multi-action S2";
  if (/invented sector descriptor/.test(p)) return "Sector invention";
  if (/no specific named item|s3 contains no named/.test(p)) return "Weak S3";
  if (/length is/.test(p)) return "Length";
  if (/uniform length/.test(p)) return "Variance";
  if (/excluded phrase/.test(p)) return "Excluded phrase";
  if (/adjective stack/.test(p)) return "Adjective stack";
  if (/sentence 2 contains no number/.test(p)) return "Weak S2";
  if (/closing sentence is a generic|aspiration/.test(p)) return "Aspirational close";
  if (/banned/.test(p)) return "Banned vocab";
  if (/jd echo/.test(p)) return "JD echo";
  return "Issue";
}

// ── FactBase gap detection (B4) ──────────────────────────────────────────
// Given a JD and the user's FactBase, classify whether the FactBase has
// sufficient evidence to support a strong Profile for this role. If thin,
// returns 2-4 targeted gap-filling questions the user can answer in 1-2
// sentences each. Answers can be fed straight into the tailor as ad-hoc
// context (one-off) or saved to Skills (persistent for future tailors).

export interface FactBaseGapQuestion {
  id: string;
  text: string;
  // Short illustrative example answer — shown as placeholder in the
  // textarea. Always present (the AI generates this).
  example: string;
  // OPTIONAL: AI's best guess at the candidate's actual answer, drawn from
  // their FactBase. Pre-fills the textarea so users can click "Use this"
  // or edit, rather than typing from scratch. Massive reduction in user
  // friction — without this, the modal asks too much effort and users
  // bail. Empty string when the AI can't construct a plausible draft from
  // existing FactBase content.
  suggestedAnswer: string;
}

export interface FactBaseGapResult {
  coverageScore: "high" | "medium" | "low";
  reason: string;
  gaps: string[];
  questions: FactBaseGapQuestion[];
  // How well the FactBase supports the TARGET ROLE FAMILY specifically
  // (vs. general Profile coverage). Drives the irrelevant-job warning flow:
  //  - "strong"       — direct evidence for the target family. Normal generation.
  //  - "transferable" — no direct evidence but reframable transferable skills.
  //                     Forces CAREER-CHANGER template; shows pivot warning.
  //  - "minimal"      — essentially zero overlap. Stronger warning; user
  //                     should reconsider OR add gap evidence first.
  // When no targetRoleFamily is supplied, defaults to "strong" (no warning).
  factbaseFitForFamily: "strong" | "transferable" | "minimal";
  // 2-4 short noun phrases identifying the candidate's strongest transferable
  // angles for the target family — e.g. for Supply Chain → Law:
  // ["analytical structure from supplier-data work", "stakeholder-reporting
  // experience", "contract-handling via supplier negotiation"]. Surfaced in
  // the modal so the user can see what the system WILL lean on. Empty when
  // fit is "strong" (no career-changer framing needed).
  transferableAngles: string[];
}

export async function detectFactBaseGaps(input: {
  jdText: string;
  cvId?: string;
}): Promise<{ result?: FactBaseGapResult; error?: string }> {
  if (!input.jdText || input.jdText.trim().length < 30) {
    return { error: "JD too short to analyse." };
  }

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings." };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data." };
  }

  // Serialise FactBase into a compact summary for the AI.
  const fb = fbResult.factBase;
  const fbSummary = serialiseFactBaseLight(fb);

  const systemPrompt = `You analyse whether a candidate's FactBase has enough evidence to write a strong CV Profile for a specific JD.

Output a single JSON object:
{
  "coverageScore": "high" | "medium" | "low",
  "reason": "<one short sentence — why this coverage level>",
  "gaps": ["<short noun-phrase gap>", ...],
  "questions": [
    { "id": "g1", "text": "<short question (≤35 words)>", "example": "<brief illustrative answer (≤25 words)>", "suggestedAnswer": "<your best plausible answer DRAWN FROM THE CANDIDATE'S ACTUAL FACTBASE (≤40 words), or empty string if no FactBase signal>" }
  ]
}

Coverage scoring:
- "high" — FactBase has solid evidence for the JD's role concept. No critical gaps. Return gaps: [] and questions: [].
- "medium" — FactBase covers the role concept partially. Some specific evidence missing. Return 2-3 questions targeting the most important gaps.
- "low" — FactBase has little overlap with the JD's role concept. Return 3-4 questions targeting the most important gaps.

QUESTION QUALITY BAR (strict):
- ≤35 WORDS per question text. Brevity is critical — long questions cause users to abandon the form.
- One clear question, one short "why this matters" clause. No multi-paragraph context.
- Specific to the JD (e.g. "Have you ever run an MRP cycle?" — NOT "What's your supply chain experience?").
- Answerable in 1-2 sentences by the candidate.
- Targets evidence likely to exist in the candidate's actual experience.
- Each question fills a DIFFERENT gap (no overlap).

SUGGESTED-ANSWER (CRITICAL — Truth Contract at full strength, FABRICATION BAN):
The suggestedAnswer field pre-fills the candidate's textarea. They may accept it in one click — so any invention here becomes a claim ON THEIR CV. Truth Contract is non-negotiable.

HARDEST RULE — GAP CONTRADICTION:
If the question asks about a capability / tool / credential that IS LISTED IN THE "gaps" ARRAY for this response, suggestedAnswer MUST be an empty string. The gap exists BECAUSE the FactBase doesn't support that capability. Pre-filling an answer claiming the candidate has the capability you just flagged as missing is a direct contradiction.

BANNED hedge-fabrications (these look honest but are inventions when the underlying capability isn't in the FactBase):
- "I've begun developing skills in [tool]…"
- "I have some exposure to [tool/framework]…"
- "I've used [tool] for side projects / self-study…"
- "I have working knowledge of [tool]…"

ALLOWED pre-fills (FactBase concretely supports the claim):
- Quantified outcomes the FactBase actually contains ("recovered £14k of refunds on damaged stock")
- Ownership claims the FactBase explicitly makes ("sole supply chain analyst")
- Brand-tier prior employers from the FactBase ("placement at Siemens DISW")

When in doubt: empty string. The candidate writes their own honest answer. An empty suggestedAnswer is the correct outcome when there's no FactBase signal — it tells the user "we need this from you."

NO HEDGING LANGUAGE IN SUGGESTED ANSWERS (HARD):
The user can accept the suggested answer with one click, so the text becomes their answer verbatim. NEVER include AI-side hedging in the suggestedAnswer text:
- BANNED: "though I'd need to verify exact figures"
- BANNED: "approximately", "roughly", "around" (when not paired with a number — "around 12 suppliers" is fine, "I think around" is not)
- BANNED: "I think", "I believe", "if memory serves", "as far as I recall"
- BANNED: "I'd estimate", "ballpark", "rough estimate"
- BANNED: any meta-commentary about the AI's uncertainty ("this is a draft", "you may want to adjust", "I'm not sure if")

Either COMMIT to a concrete claim drawn from the FactBase, or OMIT the uncertain part entirely. The user is the source of truth, not the AI. If you don't have specific numbers, write the answer WITHOUT trying to gesture at numbers — let the user add them. Never put your own hedging into the user's mouth.

Example:
{
  "id": "g1",
  "text": "The JD asks for formal TPRM. Have you worked inside any TPRM-adjacent process, even informally — vendor risk reviews, supplier due diligence?",
  "example": "I haven't worked inside a formal TPRM framework, but I've done supplier-risk-adjacent work — investigating discrepancies and root-causing supplier issues.",
  "suggestedAnswer": "Not within a formal TPRM framework, but I've handled supplier-risk-adjacent work at Grain and Frame — investigating shipment discrepancies and renegotiating with underperforming couriers."
}

Output ONLY the JSON.`;

  const userPrompt = `=== JOB DESCRIPTION ===
${input.jdText.trim()}

=== CANDIDATE FACTBASE ===
${fbSummary}

=== TASK ===
Classify FactBase coverage for this JD and return targeted gap-filling questions if needed. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Gap detection returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<FactBaseGapResult>;
    const coverageScore: FactBaseGapResult["coverageScore"] =
      parsed.coverageScore === "high" || parsed.coverageScore === "medium" || parsed.coverageScore === "low"
        ? parsed.coverageScore
        : "medium";
    const gaps = Array.isArray(parsed.gaps)
      ? parsed.gaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 6)
      : [];
    const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions: FactBaseGapQuestion[] = rawQs
      .filter(
        (q): q is FactBaseGapQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as { text?: unknown }).text === "string" &&
          (q as { text: string }).text.trim().length > 0
      )
      .slice(0, 4)
      .map((q, i) => ({
        id: typeof q.id === "string" && q.id.trim() ? q.id : `g${i + 1}`,
        text: q.text,
        example: typeof q.example === "string" ? q.example : "",
        suggestedAnswer:
          typeof (q as { suggestedAnswer?: unknown }).suggestedAnswer === "string"
            ? ((q as { suggestedAnswer: string }).suggestedAnswer).trim()
            : "",
      }));
    return {
      result: {
        coverageScore,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        gaps,
        questions,
        // JD-specific gap detection doesn't carry a target_role_family
        // (the JD itself is the target). Default to "strong" + [] so the
        // career-changer warning UI doesn't trigger on the CV-builder flow
        // — that flow has its own fit-scoring UX (low/medium/high fit on
        // the JD itself).
        factbaseFitForFamily: "strong" as const,
        transferableAngles: [],
      },
    };
  } catch (e) {
    console.error("[detectFactBaseGaps] error:", e);
    return { error: e instanceof Error ? e.message : "Gap detection AI call failed." };
  }
}

// JD-AGNOSTIC FactBase gap detection — used when generating a Master Profile
// (no JD context). Asks "does the FactBase have enough material for a strong
// Master?" — checking for quantified outcomes, distinctive ownership claims,
// named systems/tools, and clear sector signal.
//
// When a target role family is supplied, the gap detector tests coverage
// AGAINST that family specifically — surfacing the gaps relevant to landing
// in that field, not generic gaps. E.g. for a Consulting target, it asks
// about structured analysis + senior-stakeholder communication; for a
// Product Management target, it asks about shipped launches + cross-
// functional ownership. This is what makes B3 (multi-family Master support)
// actually deliver value: the right gap questions for the right target.
//
// For JD-specific gap detection (CV Builder flow), use detectFactBaseGaps —
// that one tests against a specific JD's requirements.
export async function detectMasterFactBaseGaps(input: {
  cvId?: string;
  targetRoleFamily?: string | null;
  targetSector?: string | null;
}): Promise<{ result?: FactBaseGapResult; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings." };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data." };
  }
  const fb = fbResult.factBase;
  const fbSummary = serialiseFactBaseLight(fb);

  const trimmedFamily = (input.targetRoleFamily ?? "").trim();
  const trimmedSector = (input.targetSector ?? "").trim();
  const targetClause = trimmedFamily
    ? `for someone targeting ${trimmedFamily} roles${trimmedSector ? ` in ${trimmedSector}` : ""}`
    : "for the candidate's universal Master Profile";

  const systemPrompt = `You analyse whether a candidate's FactBase has enough evidence to write a strong CV Profile ${targetClause}.

Output a single JSON object:
{
  "coverageScore": "high" | "medium" | "low",
  "reason": "<one short sentence — why this coverage level>",
  "gaps": ["<short noun-phrase gap>", ...],
  "questions": [
    { "id": "g1", "text": "<a question the candidate could answer in 1-2 sentences>", "example": "<a brief example answer — illustrative only, not a fabrication>" }
  ],
  "factbaseFitForFamily": "strong" | "transferable" | "minimal",
  "transferableAngles": ["<short noun-phrase transferable angle>", ...]
}

A strong Profile requires evidence in 4 dimensions:
1. QUANTIFIED OUTCOME — at least one number/scale anchor (£X recovered, Nx growth, N suppliers managed, N% improvement, before/after delta).
2. DISTINCTIVE OWNERSHIP — at least one unambiguous "sole / founding / first / only" claim, OR a named built system/tool/process.
3. SECTOR / WORK BREADTH — clear signal of what work the candidate ACTUALLY does${trimmedFamily ? ` AND how it maps onto ${trimmedFamily}` : ""} — not just job title.
4. CREDIBILITY ANCHOR — degree + classification + uni, OR brand-tier prior employer, OR named industry credential.

${
  trimmedFamily
    ? `FAMILY-FIT ASSESSMENT (HARD — critical for honest CV writing):
Classify how well the FactBase supports the target family "${trimmedFamily}":

- "strong" — Direct evidence of ${trimmedFamily} work in the candidate's actual roles, achievements, or skills. The candidate has DONE this kind of work (even if at a small scale). Examples:
  * Target = Procurement + FactBase shows supplier negotiation + category management work → strong
  * Target = Data + FactBase shows shipped dashboards, SQL queries, models → strong
  * Target = Consulting + FactBase shows McKinsey internship or shipped client engagements → strong

- "transferable" — NO direct evidence for ${trimmedFamily}, but multiple reframable transferable skills exist (analytical structure, stakeholder communication, project delivery, data work, written reasoning, etc.). The candidate would be a career-changer pivoting into ${trimmedFamily}. Examples:
  * Target = Law + FactBase shows analytical reports + contract-handling via supplier negotiation + First-Class degree → transferable (legal practice values analytical structure + contract reasoning)
  * Target = Product Management + FactBase shows cross-functional system co-design + launches → transferable
  * Target = Consulting + FactBase shows structured analysis + First-Class degree + client-adjacent work → transferable

- "minimal" — Essentially zero overlap. No direct evidence AND limited transferable signal. The candidate would be applying out of any career direction their experience supports. Examples:
  * Target = Surgery + FactBase shows only supply-chain work (no clinical work, no medical credentials) → minimal
  * Target = Senior Investment Banking + FactBase shows entry-level retail + no finance work → minimal

TRANSFERABLE-ANGLES (when fit is "transferable" or "minimal"):
Identify 2-4 short noun-phrase ANGLES the candidate has that DO carry transferable signal for ${trimmedFamily}. These get surfaced to the user so they can see what the system will lead with. Examples for Supply Chain → Law:
  ["analytical structure from supplier-performance work", "contract-handling via supplier negotiation", "stakeholder-reporting at director level", "First-Class academic record"]

For "strong" fit, return transferableAngles: [].

This assessment drives a downstream UX flow: if fit is "transferable" the system shows a "career-changer Profile" warning and forces the career-changer template. If "minimal", the system asks the user to reconsider or add evidence before proceeding.
`
    : `FAMILY-FIT ASSESSMENT: when no target family is specified (sector-agnostic Master generation), always return factbaseFitForFamily: "strong" and transferableAngles: []. The fit assessment only applies to family-targeted Masters.
`
}
${
  trimmedFamily
    ? `
TARGET-FAMILY-SPECIFIC CHECKS (apply alongside the 4 dimensions above — these are what will land the candidate a ${trimmedFamily} role):
- Does the FactBase contain evidence of ${trimmedFamily}-specific capabilities, even informally?
- If the candidate's experience is from a different sector, is there REFRAMABLE evidence that maps onto ${trimmedFamily}? If yes, the coverage is medium (we can reframe). If no, coverage is low and we need to ask about transferable skills.
- Gap questions should target the SPECIFIC ${trimmedFamily} signals missing — not just generic "tell us your achievements".

NON-CANONICAL TARGET FAMILY HANDLING: if "${trimmedFamily}" is not a household-name family (e.g. "Investment Banking" is well-known; "Underwater Welding Inspection" is niche), treat the family name as AUTHORITATIVE and use your general knowledge of that field's CV-writing register, vocabulary, and recruiter expectations to construct family-appropriate gap questions. Don't second-guess the user's chosen target.
`
    : ""
}
Coverage scoring:
- "high" — FactBase has evidence across all 4 dimensions${trimmedFamily ? `, AND ${trimmedFamily}-relevant evidence (direct or reframable) is clear` : ""}. Return gaps: [] and questions: [].
- "medium" — FactBase covers 2-3 dimensions strongly${trimmedFamily ? `, OR has reframable evidence for ${trimmedFamily} but specific signals missing` : ""}. Return 2 questions targeting the weakest gaps.
- "low" — FactBase covers 0-1 dimensions strongly${trimmedFamily ? `, OR has little evidence reframable for ${trimmedFamily}` : ""}. Return 3-4 questions targeting the weakest gaps.

QUESTION QUALITY BAR (every question must meet — strict):
- ≤35 WORDS per question text. Brevity is critical — long questions cause users to abandon the form. Cut every word that isn't load-bearing.
- One clear question, one short "why this matters" clause. No multi-paragraph context. The example placeholder does the heavy lifting of showing what a good answer looks like — keep the question itself lean.
- Specific to the dimension being filled${trimmedFamily ? ` AND the ${trimmedFamily} target` : ""}.
- Answerable in 1-2 sentences by the candidate using their actual experience.
- Targets evidence likely to exist (don't ask about exotic credentials; ask about reframable signals from their REAL work).
- Each question fills a DIFFERENT dimension (no overlap).

SUGGESTED-ANSWER (CRITICAL — Truth Contract at full strength, FABRICATION BAN):
The suggestedAnswer field is the candidate's pre-filled textarea content. They may accept it in one click, so any invention here becomes a claim ON THEIR CV. Truth Contract is non-negotiable.

HARDEST RULE — GAP CONTRADICTION:
If the question asks about a capability / tool / credential that IS LISTED IN THE "gaps" ARRAY for this same response, the suggestedAnswer MUST be an empty string. The gap exists precisely BECAUSE the FactBase doesn't support that capability. Pre-filling an answer claiming the candidate has the capability you just flagged as missing is a direct contradiction and a Truth Contract violation.

Examples of BANNED contradictory pre-fills:
- Gap: "Named Data tools or languages (SQL, Python, Power BI, Tableau)" → BANNED to suggest "I've begun developing skills in SQL" / "I've used Python for personal projects" / "I have some Power BI exposure". The gap means no FactBase evidence — empty string only.
- Gap: "Formal third-party risk management (TPRM) framework experience" → BANNED to suggest "I've worked with informal TPRM-adjacent processes". Empty string only.
- Gap: "Quantified £/% outcome" → BANNED to suggest a specific £-figure or % the FactBase doesn't contain. Empty string only.
- Hedge phrases that fabricate at low confidence ("I've begun…", "I have some exposure to…", "I've used X for side projects…", "I have working knowledge of…") are BANNED when the underlying capability isn't in the FactBase. These soft fabrications are the most dangerous because they look honest.

Pre-filling IS ALLOWED when the FactBase concretely supports the answer:
- ALLOWED: question about quantified outcomes + FactBase shows "recovered £14k of refunds on damaged stock" → suggestedAnswer paraphrases this real evidence.
- ALLOWED: question about distinctive ownership + FactBase shows "sole supply chain analyst at Grain and Frame" → suggestedAnswer uses this.
- ALLOWED: question about brand-tier prior employer + FactBase shows Siemens DISW placement → suggestedAnswer references it accurately.

When in doubt: empty string. The candidate sees an empty textarea + the example placeholder and writes their own honest answer — that's the correct outcome when there's no FactBase signal. An empty suggestedAnswer is a feature, not a failure: it tells the user "we need this from you because we don't have it on file."

The cost of a wrongly-fabricated pre-fill is much higher than the cost of an empty field: the user may accept the draft without noticing the fabrication, persist it to their Skills, and propagate the invention through every future CV. Never paper over a real gap with a plausible-sounding suggestion.

NO HEDGING LANGUAGE IN SUGGESTED ANSWERS (HARD):
The user can accept the suggestedAnswer with one click, so the text becomes their answer verbatim and feeds straight into the Profile generator. NEVER include AI-side hedging in the suggestedAnswer text:
- BANNED: "though I'd need to verify exact figures", "though I'm not certain of the exact number", "though figures are approximate"
- BANNED: "approximately", "roughly", "around" (when not paired with a confirmed number; "around 12 suppliers" is fine, "I think around" is not)
- BANNED: "I think", "I believe", "if memory serves", "as far as I recall"
- BANNED: "I'd estimate", "ballpark", "rough estimate"
- BANNED: any meta-commentary about the AI's uncertainty ("this is a draft", "you may want to adjust", "I'm not sure if")

Either COMMIT to a concrete claim drawn from the FactBase, or OMIT the uncertain part entirely. If the FactBase says "scaled through 2x revenue growth" without a £-figure, the suggested answer says "Scaled the supply chain through 2x revenue growth, managing increased PO volumes" — period. NOT "Scaled the supply chain through 2x revenue growth, managing increased PO volumes — though I'd need to verify exact figures." The hedge is your own uncertainty; don't put it in the user's mouth. The user IS the source of truth and can edit / add figures themselves.

Example question${trimmedFamily ? ` (target = ${trimmedFamily})` : ""}:
{
  "id": "g1",
  "text": "What's a number you've moved — £-amount, growth %, count managed? Recruiters scan for one concrete metric.",
  "example": "Recovered ~£14k of refunds on damaged stock through courier-handling claims.",
  "suggestedAnswer": "My supplier tracking system at Grain and Frame helped me recover roughly £2k of refunds on damaged stock over six months."
}

Output ONLY the JSON.`;

  const userPrompt = `=== CANDIDATE FACTBASE ===
${fbSummary}
${trimmedFamily ? `\n=== TARGET ROLE FAMILY ===\n${trimmedFamily}${trimmedSector ? ` (sector: ${trimmedSector})` : ""}\n` : ""}
=== TASK ===
Classify FactBase coverage for a strong Profile ${targetClause}, and return targeted gap-filling questions if needed. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Gap detection returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<FactBaseGapResult>;
    const coverageScore: FactBaseGapResult["coverageScore"] =
      parsed.coverageScore === "high" || parsed.coverageScore === "medium" || parsed.coverageScore === "low"
        ? parsed.coverageScore
        : "medium";
    const gaps = Array.isArray(parsed.gaps)
      ? parsed.gaps.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 6)
      : [];
    const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions: FactBaseGapQuestion[] = rawQs
      .filter(
        (q): q is FactBaseGapQuestion =>
          !!q &&
          typeof q === "object" &&
          typeof (q as { text?: unknown }).text === "string" &&
          (q as { text: string }).text.trim().length > 0
      )
      .slice(0, 4)
      .map((q, i) => ({
        id: typeof q.id === "string" && q.id.trim() ? q.id : `g${i + 1}`,
        text: q.text,
        example: typeof q.example === "string" ? q.example : "",
        suggestedAnswer:
          typeof (q as { suggestedAnswer?: unknown }).suggestedAnswer === "string"
            ? ((q as { suggestedAnswer: string }).suggestedAnswer).trim()
            : "",
      }));

    // Family-fit assessment + transferable angles. Default to "strong" + []
    // when no target family was supplied OR the AI didn't return these
    // fields — both cases mean "no career-changer warning needed".
    const rawFit = (parsed as { factbaseFitForFamily?: unknown }).factbaseFitForFamily;
    const factbaseFitForFamily: FactBaseGapResult["factbaseFitForFamily"] =
      !trimmedFamily
        ? "strong"
        : rawFit === "strong" || rawFit === "transferable" || rawFit === "minimal"
          ? rawFit
          : "strong";
    const rawAngles = (parsed as { transferableAngles?: unknown }).transferableAngles;
    const transferableAngles: string[] = Array.isArray(rawAngles)
      ? rawAngles
          .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
          .map((a) => a.trim())
          .slice(0, 6)
      : [];

    return {
      result: {
        coverageScore,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        gaps,
        questions,
        factbaseFitForFamily,
        transferableAngles,
      },
    };
  } catch (e) {
    console.error("[detectMasterFactBaseGaps] error:", e);
    return { error: e instanceof Error ? e.message : "Gap detection AI call failed." };
  }
}

// ── Post-generation Profile strength assessment ──────────────────────────
//
// After a Master Profile is generated, the user needs to know HONESTLY how
// compelling the Profile is for the target family + their realistic
// conversion ceiling. Without this, users send career-changer Profiles into
// roles where they won't land (e.g. Magic Circle for a non-Russell-Group
// First-Class candidate with no law experience) and blame the system.
//
// Returns:
// - score 1-10 (with band: weak / moderate / competitive / strong)
// - one-sentence rationale ("Why this score")
// - realistic conversion ceiling ("Strongest for graduate / paralegal entry
//   at smaller commercial firms; will not convert at Magic Circle")
// - 2-4 specific improvement suggestions — what the user could ADD to their
//   FactBase / wizard answers to push the score higher
//
// This is the SaaS coaching loop: produce a Profile, score it honestly,
// suggest concrete improvements, let the user act. The system isn't just a
// one-shot CV generator — it's a coach that gets the user toward stronger
// inputs over time.

export interface ProfileStrengthResult {
  // 1-10 — overall strength of this Profile FOR ROLES AT THE CANDIDATE'S
  // LEVEL within the target family. A junior candidate competitive for
  // junior roles in the family gets 7-8; a strong candidate for the
  // family at their level gets 9+. NOT calibrated against the senior end
  // of the family.
  score: number;
  // Short label derived from score: weak (1-3) / moderate (4-6) /
  // competitive (7-8) / strong (9-10).
  band: "weak" | "moderate" | "competitive" | "strong";
  // One short sentence explaining the score — what works, what holds it
  // back. Focused on the PROFILE, not on the candidate as a person.
  reason: string;
  // Realistic conversion ceiling — what role-types / employer-tiers this
  // Profile actually competes for. Frames POSITIVELY first (where it
  // converts well), then briefly notes stretch targets. Tells the user
  // WHERE TO APPLY, not "you're inadequate".
  conversionCeiling: string;
  // 2-4 specific, actionable suggestions to push the score higher. Each
  // has a SHORT TITLE (one-liner the user reads at a glance) and a longer
  // DETAIL (the worked rationale + example). Detail is hidden behind a
  // click-to-expand in the UI so the card stays compact by default.
  improvements: Array<{
    title: string;
    detail: string;
    impact: "high" | "medium" | "low";
  }>;
}

export async function assessProfileStrength(input: {
  profile: string;
  targetRoleFamily?: string | null;
  targetSector?: string | null;
  cvId?: string;
}): Promise<{ result?: ProfileStrengthResult; error?: string }> {
  if (!input.profile?.trim()) {
    return { error: "No Profile to assess." };
  }
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings." };
  }

  // Load FactBase for context. We don't surface it in the score directly —
  // the AI uses it to identify what's MISSING (and thus what improvements
  // to suggest).
  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data." };
  }
  const fbSummary = serialiseFactBaseLight(fbResult.factBase);
  const trimmedFamily = (input.targetRoleFamily ?? "").trim();
  const trimmedSector = (input.targetSector ?? "").trim();

  // Load user exclusions so the strength card doesn't suggest re-adding
  // content the user has explicitly excluded. Bug observed in production:
  // strength card suggested "Surface the supplier performance tracking
  // system" when "supplier performance tracking system" was on the user's
  // exclusion list. The strength card AI needs the same exclusion-awareness
  // the Profile generator already has.
  const exclusions = await getUserExclusions();

  const systemPrompt = `You are a constructive CV strategist. You score a candidate's generated CV Profile and tell them honestly where it converts well, then suggest specific improvements to push it higher.

WRITING STYLE (HARD — every field obeys these rules):
1. NO EM-DASHES (— or --). Use periods, commas, or semicolons. Restructure rather than use em-dash.
2. Maximum 2 sentences per field. Hard cap.
3. Maximum 25 words per sentence. Hard cap. If a sentence is too long, split it.
4. Active voice. Lead with verbs ("Add X" / "Surface Y" / "Reframe Z"), not "The FactBase shows...".
5. Concrete, not vague. Name specific phrases / numbers / clauses, not "make it stronger".
6. Field length limits:
   - reason: 1-2 sentences, max 35 words total.
   - conversionCeiling: 2 short sentences, max 45 words total.
   - improvement.title: 6-12 words, action-verb first.
   - improvement.detail: 1-2 short sentences, max 35 words total.
7. No filler phrases: "this is", "you have", "the FactBase records that you", "what works is". Cut straight to the substance.

CORE PRINCIPLE — CALIBRATE TO THE CANDIDATE'S LEVEL, NOT THE SENIOR END OF THE FAMILY:
The score reflects how compelling the Profile is FOR ROLES AT THE CANDIDATE'S ACTUAL LEVEL. A junior candidate with a strong junior-level Profile gets 8/10 — not 5/10 because they can't convert at C-suite. A senior candidate with a strong senior-level Profile also gets 8/10. The score answers: "given this candidate's level, how well does this Profile compete for roles at that level?"

INFER THE CANDIDATE'S LEVEL FROM THE FACTBASE:
- Entry / Graduate: just-graduated, 0-1 yr full-time experience. Target: graduate schemes, entry analyst, junior associate, paralegal.
- Junior: 1-3 yrs experience. Target: analyst, associate, executive, manager.
- Mid: 3-7 yrs experience. Target: senior analyst, senior associate, lead, principal.
- Senior: 7-15 yrs. Target: head of, director, partner.
- Executive: 15+ yrs / C-suite.

Output a single JSON object:
{
  "score": <integer 1-10>,
  "band": "weak" | "moderate" | "competitive" | "strong",
  "reason": "<one sentence focused on the PROFILE — what works + what could lift it>",
  "conversionCeiling": "<one sentence — frame POSITIVELY first (where it converts well), then briefly note stretch targets>",
  "improvements": [
    {
      "title": "<short one-liner the user reads at a glance — 6-12 words>",
      "detail": "<the rationale + example — 1-2 sentences>",
      "impact": "high" | "medium" | "low"
    }
  ]
}

SCORE BANDS (calibrate strictly to CANDIDATE'S LEVEL):
- 1-3 "weak": Structural issues. Profile would not compete for roles even at the candidate's own level.
- 4-6 "moderate": Functional Profile. Clear holes in direct evidence or hard outcomes. This is where most career-changer Profiles SHOULD land by default.
- 7-8 "competitive": Profile is credible and well-positioned for the candidate's level. Direct family evidence present. Realistic at most mainstream employers at that level.
- 9-10 "strong": Genuinely standout Profile for the candidate's level. Real shot at top-tier employers within the family.

DEFAULT SCORES (anchor your judgment HONESTLY):

In-family candidate (NOT pivoting):
- Junior, structurally clean Profile + quantified scope anchor + brand-tier prior employer + First-Class degree = 8/10. Competitive.
- Add one hard £/% outcome on top = 9/10. Strong.

Career-changer candidate (target family ≠ current family) — strict calibration:
- Pivot framing + transferable bridge + credible academic anchor + NO direct family credential + NO quantified outcome on the transferable bridge = 5/10. STRICT CAP.
- Add a quantified outcome on the transferable bridge work = 5-6/10.
- Add a named credential in progress (e.g. SQE prep, paralegal cert, planned exam, registered law module) = 6-7/10.
- Add direct evidence of the new family's day-to-day work with a quantified outcome = 7-8/10.
- 7+ for a career-changer requires AT LEAST ONE of: a hard credential, direct evidence with a number, or a brand-tier prior employer that travels across families (e.g. McKinsey → any business family). Transferable bridge alone never gets above 6.

CREDENTIAL-REQUIRED FAMILY ADJUSTMENT (HARD):
For families that gate entry on a specific credential — Legal (LLB / SQE / LPC / paralegal cert), Medicine (MBBS / GMC reg), Accounting (ACA / ACCA / CIMA), Architecture (ARB), Education (QTS / PGCE), Therapy (BACP / UKCP), Veterinary (RCVS) — academic anchor WITHOUT the credential does NOT lift the score above 5/10. A First-Class non-target degree is not a substitute for SQE prep when applying to law. Career-changer + transferable bridge + strong academic + NO credential signal = 5/10 STRICT for these families. To get above 5, the candidate must show credential commitment (prep in progress, planned exam, registered module).

For non-credential families (Marketing, Sales, Operations, Consulting, Product Management, Data, Engineering, HR, Hospitality, Retail), academic anchor + transferable bridge can lift to 5-6 without a credential because no specific licence gates entry.

Drop below 4 only when there's a real STRUCTURAL problem (missing pivot for career-changer, no anchor at all, generic register).

CONVERSION CEILING — DESCRIBE WHERE THE PROFILE LANDS, DON'T PRESCRIBE INDUSTRIES:
You are describing where the PROFILE COMPETES WELL. You are NOT telling the candidate where they should apply. Avoid prescriptive industry lists ("you should target SMEs, scale-ups, consumer-goods, e-commerce") which lock the candidate into sectors they may not want.

STRUCTURE: 2 short sentences. First sentence names the role-TYPE + general employer SCALE the Profile competes for. Second sentence names what would close the gap to top-tier.

GOOD example: "Competes well for Supply Chain Analyst roles at scale-ups and mid-market employers. Adding a hard £/% outcome would open competitiveness at large corporates and graduate schemes."

GOOD example (career-changer): "Lands at graduate paralegal and legal-operations roles where operational grounding is valued. Closing the credential gap (SQE prep, paralegal certificate, or a law module on the FactBase) would open junior commercial-law positions."

BAD example (DO NOT WRITE LIKE THIS): "Competitive for X, Y, and Z roles at SMEs, scale-ups, and consumer-goods or e-commerce businesses; a stretch at FTSE-100 procurement graduate schemes and large corporate functions where heavier academic filtering applies, closeable by surfacing a quantified outcome."
↑ Too long, single sentence, em-dash, prescribes industries, mentions academic filtering.

NEVER name specific sectors as targets ("consumer-goods", "e-commerce", "SaaS") unless those genuinely match the candidate's FactBase. Use sector-neutral employer-scale categories: "SMEs", "scale-ups", "mid-market employers", "large corporates", "FTSE-listed employers", "graduate schemes".

NEVER reference specific personal attributes not in the FactBase (A-levels, school, postcode, etc.).

GROUNDING RULES (HARD):

There are THREE valid suggestion types — distinguish between them precisely:

A. SURFACE-FROM-FACTBASE — content the user has in their FactBase but didn't make the Profile. e.g. "Surface the courier-switch outcome with a number — the FactBase has this." HIGH-IMPACT typically; the system already has the evidence, it just needs to make the 100-word cut.
  - Rule: If you suggest "quantify X", X must ALREADY be in the Profile text. If X is in the FactBase but NOT in the Profile, the suggestion must be "Surface X with a number" or "Add X to the Profile (with a number)" — NOT "Quantify X" (which falsely implies X is in the Profile).

B. CAPTURE-NEW-EVIDENCE — content that COULD be relevant for the target family but isn't in the FactBase. The AI doesn't know whether the user has it, but is prompting their memory. e.g. "Have you done any GDPR / compliance work, even informally? Add it if so — common in Legal-adjacent applications." This is a HELPFUL memory-jog, not a fabrication.
  - Allowed: prompting the user to add evidence they MIGHT have but haven't recorded.
  - Required framing: phrase as a prompt or conditional, not as an assumption. "If you have X, add it" / "Have you done X?" — NEVER "you need to add X" or "you lack X".

C. REPHRASE / RESTRUCTURE — high-level framing improvements ONLY where it's a stylistic judgment call the user can make (not a scanner-caught error). e.g. "Lead S1 with the legal skill, not the job title."

⛔ HARD BAN — NEVER SUGGEST FIXES TO SCANNER-TERRITORY ISSUES:
The Profile generator has a critic loop that catches and fixes structural / vocabulary / formatting errors BEFORE the Profile reaches you. If you see one of these in the Profile, it's a SYSTEM BUG, not a USER improvement. NEVER surface as an improvement suggestion:
- Em-dashes (— or --). The Profile bans em-dashes entirely.
- Sentence length (>26 words in body sentences).
- Multi-action jam (3+ verbs in one sentence).
- Tricolons.
- Banned vocabulary (spearhead, leverage, hands-on, absorbing, actionable, etc.).
- Passive voice closes.
- First-person pronouns (I/we/my).
- Em-dash variants (en-dash, hyphen-as-em-dash).
- Adjective stacks at sentence openings.
- Brand-tier employer name in S1 (when not brand-tier).
- Possessive employer constructions.
- Sole-vs-collaborative contradictions.
- Sector-descriptor-without-scale.
- Generic outcome patterns ("improving X visibility / accuracy / structure").

If you see ANY of these in the Profile, DO NOT suggest the user fix them. It's the system's job to catch these and the appearance of one means the critic loop missed it. Your job is to suggest content / framing improvements that are genuinely the USER'S choice to make — never to clean up AI-generated structural mistakes.

⛔ GRAMMATICAL CLARITY (HARD):
Every sentence in your output (reason, conversionCeiling, improvement.title, improvement.detail) must be grammatically clear and naturally phrased. NO awkward subject-noun constructions, NO dropped articles, NO ambiguous antecedents. If you write "No credential signals commitment to the Legal family", that's awkward — readers parse it as "No credential signals [verb]" before realising it's "[No credential] signals commitment". REWRITE as: "Without a credential the Profile reads as exploratory rather than committed" or "Add any credential signal to move beyond transferable-skills-only framing".

⛔ NATURAL ENGLISH:
Write like a senior CV strategist talking to the candidate. Not like a system. Avoid "the FactBase records that you...", "The Profile mentions...", "This is...". Just say the thing.

CANONICAL CV PROFILE STRUCTURE (DO NOT SUGGEST DEVIATIONS):
The standard UK CV Profile follows a fixed structure that recruiters expect. Do NOT suggest restructuring that violates this canon:

- S1 = current role + sector/pivot context. Pivot signals (career-changer) live HERE.
- S2 = scope anchor + the work that delivered it (quantified outcomes belong here).
- S3 = ONE distinctive ownership/breadth claim with a named specific item.
- S4 = credentials close (degree + classification + university + cohort detail) + named target ("targeting a graduate solicitor training contract").

The NAMED TARGET CLOSE lives in S4 by default. NEVER suggest moving the target close to S1 or earlier. The S4 placement is canonical because recruiters scan the close last and the target locks in the application's intent at exactly the right moment. Moving the target to S1 violates expected CV structure and dilutes the pivot signal in S1 with too much information at once.

If the candidate's Profile follows this canonical structure, your improvement suggestions should focus on STRENGTHENING the content within each sentence's role — NOT shuffling content between sentences.

USER EXCLUSIONS (HARD — never suggest re-adding excluded content):
The user maintains an EXCLUSION LIST of phrases / concepts they have explicitly removed from their Profile. These exclusions are absolute — the user has decided this content does not represent them or is sensitive / outdated / unwanted. Your suggestions MUST respect them.

If an exclusion list is provided in the user prompt:
- DO NOT suggest re-adding any excluded phrase to the Profile.
- DO NOT suggest variants or paraphrases of excluded phrases (e.g. if "supplier performance tracking system" is excluded, do NOT suggest "Surface the supplier performance tracker", "Add the performance tracking workflow", or any rewording — the underlying concept is excluded).
- DO NOT suggest "surfacing" FactBase content that matches an exclusion (even if it's in the FactBase, the user has decided it doesn't belong in the Profile).
- If a planned suggestion would touch an excluded concept, REPLACE it with a different improvement targeting a different FactBase dimension.

CONTENT THAT BELONGS IN THE PROFILE vs OTHER CV SECTIONS (HARD):
The Profile is a 60-100 word top-of-CV summary. NOT EVERYTHING ON A CV BELONGS IN THE PROFILE. Specifically:
- BELONGS IN PROFILE: role + scope anchor + 1-2 quantified outcomes + named system/employer + degree (class + uni + classification + cohort position / avg % if exceptional) + named target.
- BELONGS IN EDUCATION SECTION (NOT Profile): A-levels, GCSEs, individual modules (unless leveraged for a specific skill claim), school name, specific grades for individual modules.
- BELONGS IN EXPERIENCE BULLETS (NOT Profile): detailed task lists, day-to-day activities, named tools / software, specific dates.
- BELONGS IN INTERESTS / HOBBIES (NOT Profile): sports, volunteer work (unless leveraged for a specific skill claim), travel.

When suggesting improvements to push the Profile higher, suggest only things appropriate to the PROFILE SECTION. NEVER suggest the candidate "add A-levels to the Profile" / "mention school in the Profile" / "include hobbies in the Profile" — those belong in other CV sections. If A-levels / school / hobbies WOULD help the candidate's CV overall, that's outside the Profile's scope and the suggestion belongs elsewhere — don't surface it as a Profile improvement.

CONVERSION CEILING — DON'T SPECULATE ABOUT MISSING PERSONAL ATTRIBUTES:
The conversion ceiling describes where the PROFILE competes well. It must NOT speculate about specific personal attributes that aren't in the FactBase (A-levels, school, postcode, age, ethnicity, gender, work-permit status, etc.). If a top-tier employer filters on AAB+ A-levels and the FactBase doesn't record A-levels, the conversion ceiling does NOT say "won't convert because no AAB+ A-levels" — that's an unfounded assumption about the candidate. Instead: "stretch at top-tier employers with heavy academic filtering" — frame the GAP in employer-side terms, not candidate-deficiency terms.

IMPROVEMENT TITLES (the user reads at a glance, expands to detail):
- 6-12 words
- Action verb leading: "Surface X with a number", "Add Y to your FactBase", "Reframe Z as W"
- Specific enough to be actionable from the title alone
- NO em-dashes

FRAMING — COACHING NOT CRITICISM:
The strength card is a coach surfacing optional improvements, not a critic flagging fixes. Frame TYPE-C (rephrase/restructure) suggestions as alternatives the user could explore, not as defects to repair. The Profile already shipped IS valid; you are pointing out where it could be stronger.

GOOD framing of TYPE-C structural suggestions:
- "Consider leading S1 with the contract-review work"
- "An alternative pivot framing: anchor S1 in current-role legal-adjacent activity"
- "Try restructuring S3 to lead with the named outcome, not the tool"

BAD framing (reads as the system criticising its own AI output):
- "Sharpen the pivot signal in S1" (sounds like a defect)
- "Fix the pivot framing" (overtly critical)
- "Improve S1 by replacing X with Y" (imperative, hard)

This rule applies ONLY to TYPE-C structural / framing suggestions. TYPE-A (surface from FactBase) and TYPE-B (capture new evidence) can stay imperative because they target genuine content gaps, not structural choices. The TYPE-C cases are matters of judgment — frame as suggestions, not corrections.

IMPROVEMENT DETAILS:
- Max 2 sentences. Max 35 words total. Hard cap.
- Sentence 1: action and concrete what-to-add. Sentence 2 (optional): one example phrasing.
- NO em-dashes. NO filler ("the FactBase shows that you", "what this means is"). Cut to the substance.
- Concrete. Name specific numbers, clauses, phrases, never "make it stronger" / "improve clarity".

GOOD example: "Surface a £ or % outcome for the courier switch. e.g. 'reducing logistics costs by 12%' converts the soft claim into a quantified anchor."

BAD example (DO NOT WRITE LIKE THIS): "The FactBase records that you analysed courier performance, identified a higher-value alternative, and switched logistics partners — this is a concrete, decision-led outcome that belongs in the Profile. If you have a cost saving (£ or %) or a delivery-performance improvement (e.g. on-time rate uplift), add it: 'reducing logistics costs by X%' or 'improving on-time delivery from X% to Y%' turns a soft claim into a quantified anchor."
↑ 60+ words, em-dash, "the FactBase records that you" filler, two examples when one suffices.

Output ONLY the JSON object.`;

  const userPrompt = `=== GENERATED PROFILE ===
${input.profile.trim()}

=== TARGET ROLE FAMILY ===
${trimmedFamily || "(none — sector-agnostic Master)"}${trimmedSector ? `\nSector: ${trimmedSector}` : ""}

=== CANDIDATE'S FACTBASE (context — what they actually have, vs what's in the Profile) ===
${fbSummary}
${
  exclusions.length > 0
    ? `\n=== USER EXCLUSION LIST (NEVER suggest re-adding these or paraphrases thereof) ===\n${exclusions.map((e) => `- ${e}`).join("\n")}\n`
    : ""
}
=== TASK ===
Score the Profile honestly against the target family. Name the realistic conversion ceiling. Suggest 2-4 high-impact improvements drawn from the FactBase gaps. NEVER suggest re-adding any phrase from the exclusion list. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Strength assessment returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<ProfileStrengthResult>;
    const rawScore = typeof parsed.score === "number" ? parsed.score : 5;
    const score = Math.max(1, Math.min(10, Math.round(rawScore)));
    const band: ProfileStrengthResult["band"] =
      score <= 3 ? "weak" : score <= 6 ? "moderate" : score <= 8 ? "competitive" : "strong";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const conversionCeiling =
      typeof parsed.conversionCeiling === "string" ? parsed.conversionCeiling.trim() : "";
    const rawImprovements = Array.isArray(parsed.improvements) ? parsed.improvements : [];
    const improvements: ProfileStrengthResult["improvements"] = rawImprovements
      .filter(
        (
          i
        ): i is { title: string; detail: string; impact: "high" | "medium" | "low" } =>
          !!i &&
          typeof i === "object" &&
          typeof (i as { title?: unknown }).title === "string" &&
          typeof (i as { detail?: unknown }).detail === "string" &&
          ((i as { impact?: unknown }).impact === "high" ||
            (i as { impact?: unknown }).impact === "medium" ||
            (i as { impact?: unknown }).impact === "low")
      )
      .slice(0, 5)
      .map((i) => ({
        title: i.title.trim(),
        detail: i.detail.trim(),
        impact: i.impact,
      }));
    return {
      result: { score, band, reason, conversionCeiling, improvements },
    };
  } catch (e) {
    console.error("[assessProfileStrength] error:", e);
    return { error: e instanceof Error ? e.message : "Strength assessment AI call failed." };
  }
}

// Persist gap-question answers as a single Skill entry so they enrich every
// future FactBase extraction, not just this Master generation. The skill row
// is tagged as "context" so the user can find + edit it later. Returns the
// number of answers saved.
//
// Why one row, not one-per-question: keeps the user's Skills list clean. The
// user can split into multiple skills later if they want; we don't force a
// noisy explosion of skill rows.
// Elaborate a user's short / fragmentary gap-question answer into a fuller,
// CV-grade response drawn from the FactBase + the user's actual fragment.
// Lets users type rough input ("i deal with supplier contracts sometimes")
// and get back a polished version they can accept, edit, or clear. Reduces
// SaaS friction: most real users won't write A+ essay answers, but they
// will type a few honest words.
//
// Truth Contract still applies:
// - The elaboration MUST NOT introduce claims the user didn't make and the
//   FactBase doesn't support.
// - "i deal with contracts" → can be elaborated using FactBase context
//   (supplier contracts at Grain and Frame, liability clauses, etc.) IF
//   the FactBase supports it.
// - If the user fragment claims something not supported by FactBase, the
//   elaboration mirrors only the fragment's actual signal — never invents.
export async function elaborateGapAnswer(input: {
  questionText: string;
  userFragment: string;
  cvId?: string;
  targetRoleFamily?: string | null;
}): Promise<{ elaborated?: string; error?: string }> {
  const fragment = (input.userFragment ?? "").trim();
  if (!fragment) {
    return { error: "Type a few words first, then click Elaborate to flesh it out." };
  }
  if (!(input.questionText ?? "").trim()) {
    return { error: "Missing question context." };
  }

  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings." };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data." };
  }
  const fbSummary = serialiseFactBaseLight(fbResult.factBase);
  const trimmedFamily = (input.targetRoleFamily ?? "").trim();

  const systemPrompt = `You take a candidate's short / fragmentary answer to a gap question and elaborate it into a fuller 1-2 sentence answer that's useful for downstream CV-Profile generation.

INPUTS YOU RECEIVE:
- The QUESTION the user is answering
- The USER'S FRAGMENT — a short, possibly messy, possibly mis-capitalised real input ("i deal with supplier contracts sometimes", "no", "commercial law", "self studying sqe")
- The CANDIDATE'S FACTBASE — every claim they have evidence for elsewhere in their work history / achievements / skills
${trimmedFamily ? `- The TARGET ROLE FAMILY — ${trimmedFamily}` : ""}

YOUR JOB:
Output a single JSON object: { "elaborated": "<1-2 sentence polished answer>" }

RULES (HARD):
1. PRESERVE THE USER'S ACTUAL CLAIM. If they wrote "i deal with supplier contracts", the elaborated version must be about supplier contracts. Don't drift to a different topic.
2. ENRICH ONLY WITH FACTBASE-SUPPORTED CONTEXT. If the FactBase mentions Grain and Frame, overseas suppliers, supplier disputes — fold those in naturally to make the answer concrete. If the FactBase doesn't mention specific context for the fragment, keep the answer at the same scope as the user's input (don't invent specifics).
3. NEVER ADD CLAIMS THE USER DIDN'T MAKE. If the user wrote "i deal with supplier contracts", don't write "I review supplier contracts AND lead vendor negotiations AND draft SLAs" — they only claimed contract handling. Stay within the user's scope.
4. POLISH THE LANGUAGE, NOT THE SUBSTANCE. Lower-case → proper case. Casual register → CV register. "i deal with X" → "I handle X at [employer if FactBase has it]". Don't invent quantification, don't add specificity beyond the FactBase.
5. IF THE FRAGMENT IS "NO" / "N/A" / "NOT YET" / similar — the elaboration should mirror that honesty: "Not currently — exploring [whatever the question asked about] as a future step." or just "No formal experience yet." Don't fabricate a positive answer.
6. KEEP IT TO 1-2 SENTENCES. Maximum ~40 words.
7. UK English throughout.
8. Plain first-person voice ("I review…", "I've handled…") — the candidate is answering a question, not writing the Profile yet.

EXAMPLES:

Fragment: "i deal with supplier contracts sometimes"
FactBase mentions: supplier disputes at Grain and Frame, courier negotiations, damaged stock claims
Elaborated: "I review supplier contracts at Grain and Frame — flagging liability clauses, payment terms, and damaged-stock provisions to the director before sign-off, and revisiting contract terms when supplier disputes arise."

Fragment: "no"
Elaborated: "No formal experience in this area yet."

Fragment: "commercial law mostly"
FactBase mentions: procurement, supplier contracts
Elaborated: "Commercial law is the practice area that most aligns with my background — my procurement role gives me daily exposure to how commercial agreements work in practice."

Fragment: "yeah at uni i did a module on contract law"
FactBase mentions: First-Class BA, Birmingham City University
Elaborated: "Studied a contract-law module as part of my First-Class BA at Birmingham City University, covering offer, acceptance, consideration, and remedies."

Output ONLY the JSON object.`;

  const userPrompt = `=== QUESTION ===
${input.questionText.trim()}

=== USER'S FRAGMENT ===
${fragment}

=== CANDIDATE'S FACTBASE ===
${fbSummary}
${trimmedFamily ? `\n=== TARGET ROLE FAMILY ===\n${trimmedFamily}\n` : ""}
=== TASK ===
Elaborate the user's fragment into a polished 1-2 sentence answer. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Elaborate returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
      elaborated?: unknown;
    };
    const elaborated =
      typeof parsed.elaborated === "string" ? parsed.elaborated.trim() : "";
    if (!elaborated) {
      return { error: "Elaborate returned empty output." };
    }
    return { elaborated };
  } catch (e) {
    console.error("[elaborateGapAnswer] error:", e);
    return { error: e instanceof Error ? e.message : "Elaborate AI call failed." };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JD SKILL EXTRACTION + MATCH SCORING (Phase 2 Round 2)
// ══════════════════════════════════════════════════════════════════════════════
//
// Drives the fast-checklist audit modal in CV Builder. The flow:
//   1. extractJDSkills(jdText) → structured skill extraction from the JD
//   2. scoreSkillsMatch(jdSkills, userSkills, factbase) → match assessment
//   3. UI shows the appropriate modal based on matchBand (high/medium/low)
//   4. User ticks confirmations / adds new skills via free-text
//   5. Tailor runs with ticked answers persisted to user_skills + used as
//      wizardContext for THIS tailor call
//
// This is what closes the SaaS gap competitors leave: every Teal/Rezi/Jobscan
// fabricates skills from JD wishlist without checking user evidence. HuntHQ
// asks the user — "JD needs CMMS, you don't have it, tick if you do or skip".

export interface JDSkillExtraction {
  // Hard-skill tools / systems explicitly named in the JD (CMMS, SAP S/4HANA,
  // SPEEDY, Tableau, Excel, Python, etc.). The high-confidence ATS keywords.
  jdSpecificTools: string[];
  // Methodologies / frameworks / techniques named in the JD (Lean, S&OP,
  // Agile, OTIF, MRP, root-cause analysis, etc.).
  methodologies: string[];
  // Domain / functional capabilities (Demand forecasting, Inventory
  // management, Stakeholder management, Project coordination, etc.).
  domainCapabilities: string[];
  // Industry / sector knowledge (Automotive, FMCG, Healthcare, etc.) — only
  // populated when the JD explicitly mentions sector experience as a
  // requirement / preference.
  industry: string[];
  // Required = essentials per JD "Must have" / "Required" / "What you'll need".
  // Subset of the above lists, flagged separately because missing-required
  // items get higher modal priority.
  required: string[];
  // Nice-to-have = JD "Desirable" / "Advantage" / "Bonus".
  niceToHave: string[];
}

export interface SkillsMatchResult {
  jdSkills: JDSkillExtraction;
  // Skills the user already has (in user_skills Library OR FactBase work
  // history) that match JD requirements. Per match: which JD skill matched,
  // which Library item provided the match, confidence level.
  matched: Array<{
    jdSkill: string;
    librarySource: string;
    confidence: "high" | "medium" | "low";
  }>;
  // JD-required / desirable skills the user does NOT have in Library or
  // FactBase. These become tickbox options in the audit modal.
  missing: string[];
  // Vague items in the user's existing Skills section / Library that could
  // be specified with named tools the user has from FactBase context.
  // e.g. "AI tools" → user actually uses Claude Code, ChatGPT, Gemini.
  vague: Array<{ vagueItem: string; specifySuggestions: string[] }>;
  // Overall match score 0-100 — used to drive modal branching.
  matchScore: number;
  // Match band — drives UI behaviour:
  //  - "high" (≥75): silent auto-gen, no modal (high JD-Library overlap)
  //  - "medium" (40-74): fast checklist modal (some gaps)
  //  - "low" (<40): full audit modal (significant gaps)
  matchBand: "high" | "medium" | "low";
}

export async function extractJDSkills(input: {
  jdText: string;
}): Promise<{ result?: JDSkillExtraction; error?: string }> {
  const jdText = (input.jdText ?? "").trim();
  if (!jdText) {
    return { error: "No job description provided." };
  }
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected. Add an API key in Settings." };
  }

  const systemPrompt = `You extract structured Skills metadata from a job description.

Output a single JSON object:
{
  "jdSpecificTools": ["<tool 1>", ...],
  "methodologies": ["<method 1>", ...],
  "domainCapabilities": ["<capability 1>", ...],
  "industry": ["<industry 1>", ...],
  "required": ["<exact item from above lists>", ...],
  "niceToHave": ["<exact item from above lists>", ...]
}

CATEGORIES:

1. jdSpecificTools — NAMED tools, software, systems, platforms explicitly mentioned in the JD. Examples: "CMMS", "SAP S/4HANA", "SPEEDY", "Tableau", "Microsoft Excel (advanced)", "Salesforce CRM", "Python", "SQL", "AWS", "Jira", "Asana", "LexisNexis", "Practical Law". Acronyms must include spelled-out form on first mention if the JD spells them out.

2. methodologies — Methods / frameworks / techniques. Examples: "Lean manufacturing", "Sales & Operations Planning (S&OP)", "Material Requirements Planning (MRP)", "On Time In Full (OTIF) tracking", "Agile", "Six Sigma", "Root-cause analysis", "Statistical analysis", "Process improvement", "Continuous improvement".

3. domainCapabilities — Functional capabilities the candidate is expected to do. Examples: "Demand forecasting", "Inventory management", "Supplier negotiation", "Stakeholder management", "Project coordination", "Contract review", "Legal research". These are the JOB CAPABILITIES, not soft skills.

4. industry — Sector / industry knowledge ONLY when the JD explicitly mentions it as a requirement / preference. Examples: "Automotive industry", "FMCG", "B2B SaaS", "Manufacturing", "Commercial law". If the JD doesn't mention sector, return [].

5. required vs niceToHave — Split the items from categories 1-4 into "essentials" (under JD's "Required" / "Must have" / "Essential" / "What you'll need" sections) vs "desirable" (under "Preferred" / "Nice to have" / "Advantage" / "Bonus" / "Desirable" sections). Items that don't appear in either explicit list go to niceToHave.

EXCLUSIONS (do NOT include):
- Soft skills: "Communication", "Teamwork", "Problem solving", "Leadership", "Detail-oriented", "Self-starter", etc. These belong in experience bullets, not the Skills section.
- Generic competencies without domain anchor.
- JD-banner fluff: "passion", "innovation", "drive", "results-oriented" (these are aspirational descriptors, not skills).
- Benefits / perks / company values.

ITEM FORMAT:
- 1-6 words per item.
- Concrete + specific.
- Acronyms with spelled-out form ("Material Requirements Planning (MRP)", NOT just "MRP").
- Use the JD's exact wording where unambiguous.

VOLUME GUIDELINES:
- jdSpecificTools: 2-8 typically (more for technical roles).
- methodologies: 2-6 typically.
- domainCapabilities: 4-10 typically.
- industry: 0-2 (only when JD requires it).
- required: 3-10 items (subset of above).
- niceToHave: rest.

Output ONLY the JSON object.`;

  const userPrompt = `=== JOB DESCRIPTION ===
${jdText}

=== TASK ===
Extract structured Skills metadata per the categories above. Output ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "JD skill extraction returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<JDSkillExtraction>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
    return {
      result: {
        jdSpecificTools: arr(parsed.jdSpecificTools),
        methodologies: arr(parsed.methodologies),
        domainCapabilities: arr(parsed.domainCapabilities),
        industry: arr(parsed.industry),
        required: arr(parsed.required),
        niceToHave: arr(parsed.niceToHave),
      },
    };
  } catch (e) {
    console.error("[extractJDSkills] error:", e);
    return { error: e instanceof Error ? e.message : "JD skill extraction failed." };
  }
}

// Cross-references extracted JD skills against the user's Skills Library +
// FactBase work-history evidence. Uses AI to assess "does the user's
// experience plausibly support this JD-required skill?" — not naive string
// match (which misses semantic matches like "supplier negotiation" in
// FactBase vs "Vendor negotiation" in JD).
export async function scoreSkillsMatch(input: {
  jdSkills: JDSkillExtraction;
  cvId?: string;
  // Optional — pass the CURRENT Skills section the AI is considering
  // emitting. The scorer can flag VAGUE items there that should be
  // specified ("AI tools" → ask for named AI tools).
  currentSkillsItems?: string[];
}): Promise<{ result?: SkillsMatchResult; error?: string }> {
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    return { error: "No AI provider connected." };
  }

  const fbResult = await extractFactBase({ cvId: input.cvId });
  if (fbResult.error || !fbResult.factBase) {
    return { error: fbResult.error ?? "Could not load profile data." };
  }
  const fbSummary = serialiseFactBaseLight(fbResult.factBase);

  const allJdSkills = [
    ...input.jdSkills.jdSpecificTools,
    ...input.jdSkills.methodologies,
    ...input.jdSkills.domainCapabilities,
    ...input.jdSkills.industry,
  ];
  // De-duplicate while preserving order.
  const uniqueJdSkills = Array.from(new Set(allJdSkills));

  const systemPrompt = `You assess how well a candidate's FactBase + Skills Library supports a JD's required and desirable skills.

INPUT:
- JD-required + desirable skill list (jdSkills, with required vs niceToHave split)
- Candidate's FactBase (work history, achievements, persisted Skills Library)
- Optional: the CURRENT Skills section the system has drafted (currentSkillsItems)

For each JD skill, decide:
- MATCHED: candidate's FactBase has clear evidence of this skill (work history bullets mention it, persisted Skills include it, achievements reference it). Confidence high if direct named match; medium if semantically equivalent ("supplier negotiation" matches "vendor negotiation").
- MISSING: no FactBase evidence supports this skill. The candidate would be claiming something untrue if it were added without their input.

Then identify VAGUE items in currentSkillsItems (if provided):
- A vague item is a generic placeholder like "AI tools", "AI tools integration", "Microsoft Office", "Programming", "Database", "ERP Systems" that has explicit FactBase support for a specific tool.

⛔ TRUTH CONTRACT FOR specifySuggestions (HARD — non-negotiable):
- Each suggested specific tool MUST appear EXPLICITLY in the candidate's FactBase. Direct named mention in work history, achievements, persisted Skills, or wizard answers. NOT inferred. NOT "plausible given role". NOT "common in the industry". The candidate has to have NAMED the specific tool somewhere in their evidence.
- BANNED: inferring "AI-powered sales training tools at Siemens DISW" because the candidate worked at Siemens — that's speculation, not FactBase. The candidate didn't name those tools.
- BANNED: "Excel automation workflows" if the FactBase only says "Excel" and doesn't mention automation.
- BANNED: generic fillers like "AI-assisted data handling and reporting" / "LLM-assisted workflow automation" / "data analytics tools" — these are inferred plausible categories, not named tools from FactBase.

If the FactBase doesn't explicitly support 2+ specific tools for a vague item, return FEWER specifySuggestions (1, or empty array). The free-text "Anything else?" field handles cases where the user has tools the FactBase doesn't yet record — the user can add them.

DO suggest tools that ARE explicit:
- FactBase says "uses ChatGPT for X" → suggest "ChatGPT" ✓
- FactBase says "Claude Code for CV automation" → suggest "Claude Code" ✓
- FactBase says "built Airtable ERP" + current vague is "AI tools" → DO NOT suggest "Airtable automations" unless FactBase explicitly mentions Airtable in an AI/automation context
- FactBase mentions Power Query in achievements + current vague is "Excel" → suggest "Excel (Power Query)" ✓

Better to leave specifySuggestions empty than to fabricate plausible specifications. The user adds the truth via free-text.

Output a single JSON object:
{
  "matched": [
    { "jdSkill": "<exact JD skill>", "librarySource": "<short phrase showing where evidence is>", "confidence": "high" | "medium" | "low" }
  ],
  "missing": ["<JD skill 1>", ...],
  "vague": [
    { "vagueItem": "<current Skills item>", "specifySuggestions": ["<specific tool 1>", ...] }
  ],
  "matchScore": <integer 0-100, = (matched.length / uniqueJdSkills.length) * 100>,
  "matchBand": "high" | "medium" | "low"
}

MATCH BAND CALIBRATION (be honest):
- "high": ≥75% of JD-required skills matched in FactBase. Candidate is genuinely well-aligned. UI: silent auto-gen, skip modal.
- "medium": 40-74% match. Real gaps exist; checklist modal needed.
- "low": <40% match. Significant misalignment; full audit modal + career-changer flow if applicable.

Honest calibration: when in doubt about whether FactBase supports a skill, mark MISSING — the user can correct via checklist tick if they actually have it. Better to ask than fabricate.

Output ONLY the JSON object.`;

  const userPrompt = `=== JD SKILLS (extracted) ===
${JSON.stringify(input.jdSkills, null, 2)}

=== CANDIDATE'S FACTBASE ===
${fbSummary}
${
  input.currentSkillsItems && input.currentSkillsItems.length > 0
    ? `\n=== CURRENT SKILLS SECTION (assess for vague items) ===\n${input.currentSkillsItems.join("\n")}\n`
    : ""
}
=== TASK ===
Score each JD skill (matched/missing) + identify vague current-Skills items. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Skills match scoring returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<SkillsMatchResult>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
    const rawMatched = Array.isArray(parsed.matched) ? parsed.matched : [];
    const matched: SkillsMatchResult["matched"] = rawMatched
      .filter(
        (
          m
        ): m is { jdSkill: string; librarySource: string; confidence: "high" | "medium" | "low" } =>
          !!m &&
          typeof m === "object" &&
          typeof (m as { jdSkill?: unknown }).jdSkill === "string" &&
          typeof (m as { librarySource?: unknown }).librarySource === "string" &&
          ((m as { confidence?: unknown }).confidence === "high" ||
            (m as { confidence?: unknown }).confidence === "medium" ||
            (m as { confidence?: unknown }).confidence === "low")
      )
      .map((m) => ({
        jdSkill: m.jdSkill.trim(),
        librarySource: m.librarySource.trim(),
        confidence: m.confidence,
      }));
    const rawVague = Array.isArray(parsed.vague) ? parsed.vague : [];
    const vague: SkillsMatchResult["vague"] = rawVague
      .filter(
        (
          v
        ): v is { vagueItem: string; specifySuggestions: string[] } =>
          !!v &&
          typeof v === "object" &&
          typeof (v as { vagueItem?: unknown }).vagueItem === "string" &&
          Array.isArray((v as { specifySuggestions?: unknown }).specifySuggestions)
      )
      .map((v) => ({
        vagueItem: v.vagueItem.trim(),
        specifySuggestions: arr(v.specifySuggestions),
      }));
    // Recompute matchScore + band from matched.length / uniqueJdSkills.length
    // so we don't trust the AI's arithmetic.
    const denom = Math.max(1, uniqueJdSkills.length);
    const computedScore = Math.round((matched.length / denom) * 100);
    const matchBand: SkillsMatchResult["matchBand"] =
      computedScore >= 75 ? "high" : computedScore >= 40 ? "medium" : "low";
    return {
      result: {
        jdSkills: input.jdSkills,
        matched,
        missing: arr(parsed.missing),
        vague,
        matchScore: computedScore,
        matchBand,
      },
    };
  } catch (e) {
    console.error("[scoreSkillsMatch] error:", e);
    return { error: e instanceof Error ? e.message : "Skills match scoring failed." };
  }
}

// One-shot helper that runs extract → score in sequence. Used by the CV
// Builder pre-flight before tailoring.
export async function auditSkillsForJD(input: {
  jdText: string;
  cvId?: string;
  currentSkillsItems?: string[];
}): Promise<{ result?: SkillsMatchResult; error?: string }> {
  const extracted = await extractJDSkills({ jdText: input.jdText });
  if (extracted.error || !extracted.result) {
    return { error: extracted.error ?? "JD skill extraction failed." };
  }
  return scoreSkillsMatch({
    jdSkills: extracted.result,
    cvId: input.cvId,
    currentSkillsItems: input.currentSkillsItems,
  });
}

export async function saveGapAnswersAsSkills(input: {
  answers: Array<{ question: string; answer: string }>;
}): Promise<{ saved: number; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { saved: 0, error: "Not signed in" };

    const cleaned = input.answers
      .map((a) => ({
        question: (a.question ?? "").trim(),
        answer: (a.answer ?? "").trim(),
      }))
      .filter((a) => a.answer.length > 0);

    if (cleaned.length === 0) return { saved: 0 };

    const supabase = await createServerSupabaseClient();
    // Pack as one row — each Q&A pair becomes a line in the body.
    const body = cleaned
      .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
      .join("\n\n");

    const { error } = await supabase.from("user_skills").insert({
      user_id: userId,
      raw_text: body,
    });

    if (error) {
      console.error("[saveGapAnswersAsSkills] supabase error:", error);
      return { saved: 0, error: error.message };
    }

    revalidatePath("/profile");
    return { saved: cleaned.length };
  } catch (e) {
    console.error("[saveGapAnswersAsSkills] unexpected:", e);
    return { saved: 0, error: e instanceof Error ? e.message : "Failed to save answers." };
  }
}

// Compact FactBase serialisation for the gap detector. Trimmed-down version
// of what the Master generator uses — we only need enough signal to classify
// coverage, not enough to generate full content.
function serialiseFactBaseLight(fb: import("@/lib/cv/factbase").FactBase): string {
  const lines: string[] = [];
  const roles = fb.facts.filter(
    (f): f is import("@/lib/cv/factbase").RoleFact => f.kind === "role"
  );
  if (roles.length > 0) {
    lines.push("== Roles ==");
    for (const r of roles) {
      const dates = `${r.startDate ?? "?"} – ${r.isCurrent ? "Present" : r.endDate ?? "?"}`;
      lines.push(`- ${r.title} at ${r.company} (${dates})`);
    }
  }
  const achievements = fb.facts.filter(
    (f): f is import("@/lib/cv/factbase").AchievementFact => f.kind === "achievement"
  );
  if (achievements.length > 0) {
    lines.push("\n== Achievements / Skills evidence ==");
    for (const a of achievements) {
      lines.push(`- ${a.content}`);
    }
  }
  const skills = fb.facts.filter(
    (f): f is import("@/lib/cv/factbase").SkillFact => f.kind === "skill"
  );
  if (skills.length > 0) {
    lines.push("\n== Skills ==");
    for (const s of skills) {
      lines.push(`- ${s.content}`);
    }
  }
  const educations = fb.facts.filter(
    (f): f is import("@/lib/cv/factbase").EducationFact => f.kind === "education"
  );
  if (educations.length > 0) {
    lines.push("\n== Education ==");
    for (const e of educations) {
      lines.push(`- ${e.qualification} from ${e.institution}${e.classification ? ` (${e.classification})` : ""}`);
    }
  }
  return lines.join("\n").trim();
}

// ── Master fit-scoring (B2) ──────────────────────────────────────────────
// Given a JD and the user's saved Masters, classify which Master is the
// best fit (or if none are). Used by the CV tailor page to auto-pick the
// right Master and warn when no saved Master matches the JD's role family.
//
// Cheap single AI call: send all Master names + summaries + the JD, return
// the best id + fitScore + detected role family.
export interface MasterFitResult {
  bestMasterId: string | null;
  fitScore: "high" | "medium" | "low";
  detectedRoleFamily: string;
  reason: string;
}

export async function scoreMastersForJD(input: {
  jdText: string;
}): Promise<{ result?: MasterFitResult; error?: string }> {
  const masters = await getMasterProfiles();
  if (masters.length === 0) return { error: "No saved Masters." };
  if (!input.jdText || input.jdText.trim().length < 30) {
    return { error: "JD too short to score." };
  }

  // Single-Master shortcut: no scoring needed, just classify the fit.
  // We still run the AI call so the banner can say "high/medium/low fit".
  const keys = await getApiKeyValues();
  if (Object.keys(keys).length === 0) {
    // No AI keys — degrade gracefully: pick default Master, claim "medium" fit.
    const def = masters.find((m) => m.is_default) ?? masters[0];
    return {
      result: {
        bestMasterId: def.id,
        fitScore: "medium",
        detectedRoleFamily: "(no AI provider connected)",
        reason: "Fit-scoring requires an AI provider. Picked your default Master.",
      },
    };
  }

  const mastersBlock = masters
    .map((m, i) => {
      const targetLine = m.target_role_family
        ? `Target role family: ${m.target_role_family}${m.target_sector ? ` (sector: ${m.target_sector})` : ""}`
        : "Target role family: (not declared — sector-agnostic)";
      return `Master ${i + 1} — id: ${m.id}\nName: ${m.name}\n${targetLine}\nSummary: ${m.summary}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = `You classify how well a candidate's saved Master Profiles fit a specific job description.

For each Master, consider whether the JD's role family (e.g. supply chain analyst, commercial property surveyor, software engineer) aligns with the Master's identity. When the Master has a declared "Target role family", that field is the AUTHORITATIVE signal of the Master's intended use — treat a JD that matches the declared family as a HIGH fit, even if the summary itself overlaps multiple families.

Return ONE JSON object: {
  "bestMasterId": "<id of the best-fitting Master>",
  "fitScore": "high" | "medium" | "low",
  "detectedRoleFamily": "<short noun phrase describing the JD's role family, e.g. 'commercial property surveyor', 'demand planner', 'investment analyst'>",
  "reason": "<one short sentence explaining the pick>"
}

Fit thresholds:
- "high" = the Master's role family matches the JD's role family closely. Vocabulary mostly aligns. Master is the right starting point with at most word-level adjustments.
- "medium" = adjacent role family. Some transferable skills, but the JD uses meaningfully different vocabulary. Adapt may help.
- "low" = different role family. The Master would need substantial restructuring (i.e. a new Master would be more honest).

Pick the BEST fit even when fitScore is "low" — bestMasterId is always the closest match.

Output ONLY the JSON object. No prose.`;

  const userPrompt = `=== JOB DESCRIPTION ===
${input.jdText.trim()}

=== CANDIDATE'S SAVED MASTER PROFILES ===
${mastersBlock}

=== TASK ===
Classify which Master fits this JD best. Return ONLY the JSON object.`;

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
    if (start === -1 || end === -1) {
      return { error: "Fit-scoring AI returned non-JSON output." };
    }
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<MasterFitResult>;
    const bestMasterId =
      typeof parsed.bestMasterId === "string" && masters.some((m) => m.id === parsed.bestMasterId)
        ? parsed.bestMasterId
        : (masters.find((m) => m.is_default)?.id ?? masters[0].id);
    const fitScore: MasterFitResult["fitScore"] =
      parsed.fitScore === "high" || parsed.fitScore === "medium" || parsed.fitScore === "low"
        ? parsed.fitScore
        : "medium";
    return {
      result: {
        bestMasterId,
        fitScore,
        detectedRoleFamily: typeof parsed.detectedRoleFamily === "string" ? parsed.detectedRoleFamily : "",
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      },
    };
  } catch (e) {
    console.error("[scoreMastersForJD] error:", e);
    return { error: e instanceof Error ? e.message : "Fit-scoring AI call failed." };
  }
}

// Per-CV adapter for the "Adapt to this JD" button. Loads the chosen Master
// (or the user's default if no id given) + its exclusions, runs the
// constrained adaptation, returns original + adapted + warnings + the master
// name so the UI can show "Adapting [Master name] for [JD]".
export async function adaptMasterForCV(input: {
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  masterId?: string;
}): Promise<{
  master?: string;
  adapted?: string;
  masterName?: string;
  warnings: string[];
  error?: string;
  unchanged?: boolean;
}> {
  const { userId } = await auth();
  if (!userId) return { warnings: [], error: "Not signed in" };

  const masterRow = input.masterId
    ? await getMasterProfileById(input.masterId)
    : await getDefaultMasterProfile();

  if (!masterRow || !masterRow.summary?.trim()) {
    return {
      warnings: [],
      error: masterRow
        ? `"${masterRow.name}" Master is empty — add content to it on the Profile page before adapting.`
        : "No saved Master Profile to adapt. Save one on the Profile page first.",
    };
  }

  const masterSummary = masterRow.summary.trim();
  // Use global user-level exclusions (replacing legacy per-Master exclusions).
  const exclusions = await getUserExclusions();

  const result = await tailorMasterProfile({
    master: masterSummary,
    jdText: input.jdText,
    cvId: input.cvId,
    companyName: input.companyName,
    roleName: input.roleName,
    exclusions,
    // Pass through the Master's saved target family so Adapt knows what
    // career direction this Master is framed for. Adds register context
    // alongside the JD-driven re-emphasis.
    targetRoleFamily: masterRow.target_role_family,
    targetSector: masterRow.target_sector,
  });

  if (result.error) {
    return { warnings: result.warnings, error: result.error };
  }

  const adapted = result.tailored ?? masterSummary;
  return {
    master: masterSummary,
    adapted,
    masterName: masterRow.name,
    warnings: result.warnings,
    unchanged: adapted === masterSummary,
  };
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
