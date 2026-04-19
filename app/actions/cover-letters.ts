"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";
import OpenAI from "openai";
import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";
import { getProfile, getCVs, getSkills, getWritingExamples, getCoverLetterPrefs } from "@/app/actions/profile";
import { getTaskPreferences } from "@/app/actions/preferences";
import type { CoverLetterPrefs } from "@/app/actions/profile";

export interface SavedCoverLetter {
  id: string;
  application_id?: string;
  content: string;
  provider?: string;
  created_at: string;
}

export async function getSavedCoverLetters(): Promise<SavedCoverLetter[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("cover_letters")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

export async function saveCoverLetter(content: string, applicationId?: string, provider?: string): Promise<string | undefined> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from("cover_letters").insert({
    user_id: userId,
    application_id: applicationId ?? null,
    content,
    provider: provider ?? null,
  }).select("id").single();
  revalidatePath("/cover-letter");
  return data?.id;
}

async function fetchCompanyResearch(companyName: string, apiKey: string): Promise<string> {
  try {
    const client = new OpenAI({ apiKey, baseURL: "https://api.perplexity.ai" });
    const res = await client.chat.completions.create({
      model: "llama-3.1-sonar-small-128k-online",
      max_tokens: 150,
      messages: [{ role: "user", content: `In 2-3 factual sentences: what is ${companyName} known for, any recent news or initiatives, and what is their culture like?` }],
    });
    return res.choices[0]?.message.content ?? "";
  } catch { return ""; }
}

function buildSystemPrompt({
  profile, cvContent, skills, writingExamples, companyResearch, clPrefs,
}: {
  profile: Awaited<ReturnType<typeof getProfile>>;
  cvContent: string;
  skills: Awaited<ReturnType<typeof getSkills>>;
  writingExamples: Awaited<ReturnType<typeof getWritingExamples>>;
  companyResearch: string;
  clPrefs: CoverLetterPrefs;
}): string {
  const tone = profile.tone ?? "balanced";
  const toneGuide =
    tone === "formal" ? "Write in a formal, structured, professional tone." :
    tone === "conversational" ? "Write in a warm, direct, conversational tone — confident but human." :
    "Write in a clear, confident, professional-but-human tone.";

  const skillsText = skills.length > 0
    ? skills.map((s) => `- ${s.polished_text || s.raw_text}`).join("\n")
    : "None provided.";

  const writingStyleText = writingExamples.length > 0
    ? `Study these examples and match the candidate's natural voice and sentence rhythm:\n\n${writingExamples.map((e, i) => `Example ${i + 1}:\n${e.content.slice(0, 600)}`).join("\n\n")}`
    : "";

  const contactLine = [profile.email, profile.phone, profile.linkedin_url].filter(Boolean).join(" | ");

  const salutation = clPrefs.salutation || "Dear Hiring Manager";

  const alwaysMentionSection = clPrefs.always_mention?.trim()
    ? `ALWAYS INCLUDE — the candidate has asked you to always get these across:\n${clPrefs.always_mention}`
    : "";

  const neverDoSection = clPrefs.never_do?.trim()
    ? `NEVER INCLUDE — the candidate has asked you to always avoid these:\n${clPrefs.never_do}`
    : "";

  const extraToneSection = clPrefs.extra_tone_notes?.trim()
    ? `ADDITIONAL TONE GUIDANCE:\n${clPrefs.extra_tone_notes}`
    : "";

  return `You are an expert career coach and professional writer. Write a cover letter that genuinely gets people hired.

MANDATORY RULES — follow every one without exception:
- Write in the FIRST PERSON throughout — "I", "my", "me". Never refer to the candidate by name or in third person ("he", "she", "they") anywhere in the letter body
- OPENING — choose whichever strategy best fits this candidate for this specific role:
  (A) DIRECT RELEVANCE: candidate has clearly relevant experience. Lead with the experience most directly parallel to this role. Do NOT name the employer in the first sentence. Pattern: "For the past [period], I've [done X that directly mirrors what this role needs]."
  (B) HONEST BRIDGE: candidate is cross-industry or non-traditional. Name the gap, own it, immediately close it. Pattern: "My background is in [X], not [Y] — but the core work is the same: [specific transferable skill]. I've been doing this [context]." This is more powerful than pretending the gap doesn't exist.
  (C) ROLE INSIGHT: candidate has a genuine, specific insight about what this role actually demands. State it, then show you have it. Must be specific to this role, not a general industry observation.
  HARD BANS on openings: employer/company name in sentence one; gerund openers ("Building...", "Designing..."); dramatic reveals ("— that's the kind of work I do"); industry truisms; "I am writing to apply"; personal trait lists.
- 3-4 paragraphs, 250-380 words total. Concise wins
- Include at least one quantified achievement (numbers, percentages, scale)
- Mirror terminology from the job description naturally — do not stuff keywords
- One paragraph specifically on why THIS company — use the company research below
- Write about what the candidate brings TO the employer, not what they want FROM the job
- ${toneGuide}
- Closing: one confident sentence — an open, warm invitation to speak. No "please", no "do get in touch", no suggesting the hiring manager would be doing the candidate a favour. Never use "I look forward to hearing from you". No location-specific phrases ("in Birmingham") in the closing.
- Location or geography should not appear in the closing paragraph at all
- Refer to the candidate's current employer by name AT MOST ONCE in the entire letter. After the first mention, use "the business", "the company", or "my current role"
- Em-dashes (—) and double hyphens (--): NEVER use either. Use plain sentence structure, a colon, or a new sentence instead
- If the JD lists a specific requirement the candidate meets (licence, degree), only mention it if it weaves naturally into a relevant sentence — never as a standalone line
- Never editorialize your own points. Do NOT explain what the role is, what the company does, or what makes experience valuable. Do NOT write commentary like "These aren't academic exercises", "That's not just theory", "these aren't peripheral tasks here, they're the role", "that's exactly what this role needs". State the point and trust the reader — the interpretation is theirs to make, not yours to spell out
- BANNED PHRASES — never use: "team player", "hard worker", "passionate about", "I believe I would be a great fit", "results-oriented", "proven track record", "detail-oriented", "synergy", "I am excited to apply", "dynamic", "not just a [noun]", "that's exactly the kind of", "that's the kind of X I"
- Vary sentence length. Use contractions where natural. Sound like a real person
- Do NOT summarise the CV — tell a story the CV cannot tell

CANDIDATE:
Name: ${profile.full_name ?? ""}
Headline: ${profile.headline ?? ""}
Location: ${profile.location ?? ""}
Sign-off: ${profile.sign_off ?? "Kind regards"}
Contact: ${contactLine}

CV:
${cvContent}

ADDITIONAL SKILLS & EXPERIENCE (beyond CV — draw on these where relevant; adapt, rephrase, or condense them to fit the letter's flow naturally — do not force them in or copy them rigidly):
${skillsText}

${writingStyleText ? `WRITING STYLE — match this voice:\n${writingStyleText}\n` : ""}
${companyResearch ? `COMPANY RESEARCH — use specific details from this:\n${companyResearch}\n` : ""}
${alwaysMentionSection ? `${alwaysMentionSection}\n` : ""}
${neverDoSection ? `${neverDoSection}\n` : ""}
${extraToneSection ? `${extraToneSection}\n` : ""}
OUTPUT: Return only the complete cover letter body. Start with "${salutation}," on its own line, then a blank line, then the first paragraph. End with the sign-off and candidate name. No preamble, no explanation, no subject line.`;
}

export async function generateCoverLetter(input: {
  jobDescription: string;
  companyName?: string;
  roleName?: string;
  cvId?: string;
  anythingToAdd?: string;
  applicationId?: string;
}): Promise<{ text: string; provider: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const [profile, allCVs, skills, writingExamples, taskPrefs, keys, clPrefs] = await Promise.all([
    getProfile(), getCVs(), getSkills(), getWritingExamples(), getTaskPreferences(), getApiKeyValues(), getCoverLetterPrefs(),
  ]);

  if (Object.keys(keys).length === 0) throw new Error("No AI provider connected. Add an API key in Settings.");

  const cv = input.cvId
    ? allCVs.find((c) => c.id === input.cvId)
    : allCVs.find((c) => c.is_default) ?? allCVs[0];

  if (!cv) throw new Error("No CV found. Please upload your CV in My Profile first.");

  // Company research via Perplexity if connected
  let companyResearch = "";
  if (input.companyName && keys.perplexity) {
    companyResearch = await fetchCompanyResearch(input.companyName, keys.perplexity);
  }

  const systemPrompt = buildSystemPrompt({ profile, cvContent: cv.content, skills, writingExamples, companyResearch, clPrefs });

  const userPrompt = `Write a cover letter for this role:

JOB DESCRIPTION:
${input.jobDescription}

${input.anythingToAdd?.trim() ? `SPECIFIC INSTRUCTIONS — the candidate has asked you to include or emphasise the following:\n${input.anythingToAdd}` : ""}`;

  const result = await callAI({
    task: "cover-letter",
    prompt: userPrompt,
    systemPrompt,
    userPreference: taskPrefs["cover-letter"],
    connectedProviders: keys,
  });

  // Auto-save (body only — header is rendered in the UI)
  const letterId = await saveCoverLetter(result.text, input.applicationId, result.provider);

  return { text: result.text, provider: result.provider, letterId };
}

export async function refineCoverLetter(input: {
  originalLetter: string;
  refinementRequest: string;
  jobDescription: string;
}): Promise<{ text: string; provider: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const [taskPrefs, keys] = await Promise.all([getTaskPreferences(), getApiKeyValues()]);
  if (Object.keys(keys).length === 0) throw new Error("No AI provider connected.");

  const result = await callAI({
    task: "cover-letter",
    systemPrompt: "You are an expert cover letter editor. Apply the requested changes to the cover letter and return the complete updated version. Preserve the overall structure and quality. Return only the letter body (starting with the greeting), no explanation.",
    prompt: `Original cover letter:\n\n${input.originalLetter}\n\nRefinement request: ${input.refinementRequest}\n\nReturn the complete updated cover letter.`,
    userPreference: taskPrefs["cover-letter"],
    connectedProviders: keys,
  });

  return { text: result.text, provider: result.provider };
}

// ── Skill gap discovery ───────────────────────────────────────────────────────

export interface SkillGap {
  id: string;
  skill: string;
  question: string;
  jd_context: string;
}

export async function analyzeSkillGaps(jobDescription: string, cvId?: string): Promise<SkillGap[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const [allCVs, skills, taskPrefs, keys] = await Promise.all([
    getCVs(), getSkills(), getTaskPreferences(), getApiKeyValues(),
  ]);

  if (Object.keys(keys).length === 0) return [];

  const cv = cvId
    ? allCVs.find((c) => c.id === cvId)
    : allCVs.find((c) => c.is_default) ?? allCVs[0];

  const cvContent = cv?.content ?? "";
  const skillsText = skills.map((s) => s.polished_text || s.raw_text).join("\n");

  const prompt = `Analyze this job description against the candidate's profile. Identify 2-4 specific skills, tools, or experiences that:
1. Are explicitly mentioned in the JD as required or desirable
2. Are NOT already covered in the candidate's CV or additional skills list
3. Are concrete and verifiable (specific tools, types of experience, credentials) — not vague soft skills
4. Are things a plausible candidate MIGHT actually have

Focus only on the most impactful gaps. Do not ask about highly specialized technical skills unlikely to be held. Do not ask about things already in the profile.

JD:
${jobDescription.slice(0, 3000)}

CANDIDATE CV:
${cvContent.slice(0, 2000)}

ADDITIONAL SKILLS:
${skillsText.slice(0, 1000)}

Return ONLY a valid JSON array, no other text, no markdown:
[{"id":"1","skill":"PowerPoint presentations","question":"The role asks for PowerPoint proficiency — have you created professional presentations in a work or study context?","jd_context":"Is proficient in Microsoft Excel (formulas, tables) and PowerPoint (presentations and formatting)"}]

If there are no meaningful gaps, return an empty array: []`;

  try {
    const result = await callAI({
      task: "cover-letter",
      prompt,
      systemPrompt: "You are analyzing a job description against a candidate profile. Return only valid JSON, nothing else.",
      userPreference: taskPrefs["cover-letter"],
      connectedProviders: keys,
    });

    const text = result.text.trim();
    const jsonStart = text.indexOf("[");
    const jsonEnd = text.lastIndexOf("]");
    if (jsonStart === -1 || jsonEnd === -1) return [];
    return JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as SkillGap[];
  } catch {
    return [];
  }
}

export async function createApplicationFromCoverLetter(
  company: string,
  role: string,
  jobDescription: string,
  letterId: string,
): Promise<string | undefined> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");
  const supabase = await createServerSupabaseClient();

  const { data: app } = await supabase
    .from("applications")
    .insert({
      user_id: userId,
      company,
      role,
      location: "",
      status: "applied",
      stage: "",
      applied_date: new Date().toISOString().split("T")[0],
      job_description: jobDescription || null,
    })
    .select("id")
    .single();

  if (app?.id) {
    await supabase
      .from("cover_letters")
      .update({ application_id: app.id })
      .eq("id", letterId)
      .eq("user_id", userId);
    revalidatePath("/tracker");
    revalidatePath("/cover-letter");
  }

  return app?.id;
}
