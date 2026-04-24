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
  const { data, error } = await supabase.from("cover_letters").insert({
    user_id: userId,
    application_id: applicationId ?? null,
    content,
  }).select("id").single();
  if (error) {
    console.error("[saveCoverLetter] supabase error:", error);
    throw new Error(error.message);
  }
  void provider;
  revalidatePath("/cover-letter");
  return data?.id;
}

export async function saveManualCoverLetter(applicationId: string, content: string): Promise<{ id?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("cover_letters").insert({
      user_id: userId,
      application_id: applicationId,
      content,
    }).select("id").single();
    if (error) {
      console.error("[saveManualCoverLetter] supabase error:", error);
      return { error: error.message };
    }
    revalidatePath("/tracker");
    return { id: data?.id };
  } catch (e) {
    console.error("[saveManualCoverLetter] unexpected error:", e);
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function updateCoverLetterContent(letterId: string, content: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) return;
  const supabase = await createServerSupabaseClient();
  await supabase
    .from("cover_letters")
    .update({ content })
    .eq("id", letterId)
    .eq("user_id", userId);
  revalidatePath("/cover-letter");
}

function sanitiseLetter(text: string): string {
  // Strip em-dashes regardless of what the model produced.
  return text.replace(/\s*—\s*/g, ", ").replace(/\s*--\s*/g, ", ");
}

function fixSignOff(text: string, signOff: string, name: string): string {
  if (!signOff || !name) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match "Sign-off[,?] Name" on the same line and split onto two lines with comma.
  return text.replace(
    new RegExp(`(${esc(signOff)},?)[ \t]+(${esc(name)})`, "g"),
    `${signOff},\n${name}`
  );
}

async function reviseCoverLetter(
  letter: string,
  userPreference: "auto" | "anthropic" | "openai" | "gemini" | "mistral" | "groq" | "perplexity" | undefined,
  connectedProviders: Partial<Record<"anthropic" | "openai" | "gemini" | "mistral" | "groq" | "perplexity", string>>,
  signOff: string,
  fullName: string,
): Promise<string> {
  const checklist = `You are an expert cover letter editor. Scan the letter below for any of the specific issues listed. Rewrite ONLY the offending sentences; leave everything else untouched. If no issues are found, return the letter exactly as given.

ISSUES TO CHECK (rewrite any sentence that matches):

1. EVASIVE EMPLOYER DESCRIPTORS in the opening ("at a product-led business", "at a small business", "at a growing company", "at a mid-sized firm", "at a fast-paced SME", "at an innovative startup"). FIX: drop the "at a [descriptor]" clause; keep just "as a [role title]".

2. MEGA-SENTENCES (any sentence over 40 words). FIX: split into two sentences.

3. SELF-CHARACTERISING SUMMARY SENTENCES — be AGGRESSIVE in catching these. If a sentence abstracts concrete activity into a branded noun ("pattern", "approach", "grounding", "foundation", "understanding") and then claims the candidate got it / carries it / applies it, it is banned. The specific wording does not matter — it is the SHAPE that is banned. Match broadly:
   - Any sentence containing "gave me a [grounding / foundation / understanding / strong sense / feel / instinct] [in / for / of] [abstract noun]" — regardless of what comes before or after. Example hits: "gave me a strong grounding in structured coordination", "gave me a foundation in analytical thinking", "gave me a strong sense of operational rigour".
   - Any sentence containing "sits at the [intersection / crossover / boundary / meeting point] of [X] and [Y]" — this is editorialising about the role/candidate's work.
   - Any sentence containing "shaped how I [approach / think about / work with / engage with] [abstract topic]", with or without "end to end", "from the ground up", "at every level".
   - Any sentence of the form "[activity] has carried through into [my current role / every role since]".
   - Any sentence of the form "Doing / Working [X] taught me [abstract quality]".
   - Any sentence of the form "[X experience] prepared me for [Y] / built the foundation for [Y]".
   - Any sentence containing "is the kind of [Y] that translates directly to [Z]", "maps to the kind of work [Z] requires", "underpins both [A] and [B]", "underpins the kind of [X] that [Y]".
   - Any sentence that names a pattern/approach/habit/mindset as something the candidate "brings", "has", or "lives by".
   FIX: delete the sentence entirely, OR replace with a concrete continuation naming one specific thing the candidate does (e.g. "I still produce the weekly supplier summary for the director" is fine; "that approach has carried through" is not). When in doubt, DELETE — the letter is almost always stronger without these sentences.

4. OVERCLAIM VIA JD-NAMED SYSTEMS: sentences that compare the candidate's work to a specific JD-named system/acronym ("which required the same kind of CMMS integrity", "similar to SPEEDY", "the same kind of [named system] rigour", "which parallels [named system]"). FIX: remove the comparison; describe the work in generic functional terms only.

5. AUDIENCE INFLATION: phrases like "senior stakeholders", "senior leadership", "executives", "the board", "leadership team", "C-suite" applied to the candidate's current work when not supported by context. FIX: replace with the actual audience (director, team, manager, owners) or generalise ("the business", "the team").

6. CLOSING ISSUES:
   - Over 18 words → shorten to 6-18.
   - Starts with a summary stem ("I'd welcome a conversation about", "My experience in [list]", "I'm confident my experience", "What I can bring to [team]", "I would bring", "I can offer", "Given my background in", "With my experience in"). FIX: rewrite as a short forward-action invitation (6-18 words) that references the role or company naturally.
   - Contains "from day one", "from an early stage", "from the outset", "hit the ground running". FIX: remove the phrase.
   - Generic and company-agnostic ("Happy to talk through any of this in more detail"). FIX: rewrite to reference the specific role or company.

7. OTHER BANNED PHRASES (anywhere): "team player", "hard worker", "passionate about", "proven track record", "detail-oriented", "results-oriented", "I believe I would be a great fit", "I am excited to apply", "dynamic", "synergy". FIX: remove or replace with concrete detail.

8. EM-DASHES (—) anywhere in the output. FIX: replace with a comma or new sentence.

9. FILLER/GLUE TRANSITION SENTENCES AND PHRASES ("That's the day-to-day core of what I do", "That's the analytical side of it", "The analytical work has been the core of it", "In addition to the above", "On top of that"). Also topic-transition fillers that add no information: "On the inventory side", "On the logistics side", "On the reporting side", "On the analytical side", "On the [X] side of things" — these are low-value transitions that can almost always be deleted. FIX: delete the phrase or the entire sentence if it only exists to transition.

OUTPUT RULES:
- Return the COMPLETE revised letter from greeting to sign-off.
- Start IMMEDIATELY with "Dear " — no preamble, no commentary, no explanation of what you changed.
- Preserve the 3-4 paragraph structure. Do not reduce to 2 paragraphs.
- End with the sign-off line "${signOff}," and then the name "${fullName}" on its own line.
- Do NOT invent new facts about the candidate. Only fix the specific issues above.

LETTER TO CHECK:

${letter}`;

  try {
    const result = await callAI({
      task: "cover-letter",
      systemPrompt: "You are an expert cover letter editor. Apply only the specific fixes requested. Return only the revised letter, with no preamble or commentary.",
      prompt: checklist,
      userPreference,
      connectedProviders,
    });
    const revised = result.text.trim();
    // Safety: must start with "Dear" and be at least 60% of the original length
    if (!/^Dear\s/i.test(revised) || revised.length < letter.length * 0.6) {
      return letter;
    }
    return revised;
  } catch {
    return letter;
  }
}

function ensureNameAfterSignOff(text: string, signOff: string, name: string): string {
  if (!signOff || !name) return text;
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.endsWith(name)) return trimmed;
  const lines = trimmed.split("\n");
  const lastNonEmptyIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim().length > 0) return i;
    return -1;
  })();
  if (lastNonEmptyIdx < 0) return trimmed;
  const lastLine = lines[lastNonEmptyIdx].trim().replace(/,\s*$/, "");
  if (lastLine === signOff) {
    return trimmed + "\n" + name;
  }
  return trimmed;
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
    ? `Study these examples to understand the candidate's natural voice, vocabulary level, sentence rhythm, and any distinctive phrasing. Extract these stylistic qualities and apply them — but maintain ALL quality rules regardless of what appears in the examples. Never copy banned patterns (gerund openers, em-dashes, "excited to apply", "I look forward to", clichéd phrases) even if they appear in the samples. Take the voice and rhythm, not the mistakes:\n\n${writingExamples.map((e, i) => `Example ${i + 1}:\n${e.content.slice(0, 600)}`).join("\n\n")}`
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
  (B) HONEST BRIDGE: candidate is cross-industry or non-traditional. Open by stating the specific work they do that directly maps to this role. Do NOT name the gap and then explain how it closes. Do NOT say "that's what a [role title] does" or "which maps directly to what this role requires" or "that's a reasonable description of what X does". Show the parallel work and let the hiring manager draw the conclusion themselves. Pattern: "For the past [period], I've been [doing specific work that directly mirrors the role's core demands] — [one sentence of concrete context or achievement]."
  (C) ROLE INSIGHT: candidate has a genuine, specific insight about what this role actually demands. State it, then show you have it. Must be specific to this role, not a general industry observation.
  HARD BANS on openings: employer/company name in sentence one; gerund openers ("Building...", "Designing..."); dramatic reveals ("— that's the kind of work I do"); industry truisms; "I am writing to apply"; personal trait lists; stating or explaining the parallel out loud ("that's what X does", "which is exactly what this role needs", "that maps to what you're looking for"); evasive employer descriptors used as substitutes for the employer name ("at a product-led business", "at a small business", "at a growing company", "at a mid-sized firm", "at an innovative startup", "at a fast-paced SME", "at a product business"). If you cannot name the employer in sentence one, DO NOT use a descriptor phrase in its place — use only the role title ("as a Supply Chain Analyst") with no "at a [adjective] [noun]" clause. The employer may be named naturally later in the letter.
- STRUCTURE — EXACTLY 3 or 4 distinct paragraphs before the closing line, 250-380 words. Never 2 paragraphs. Never merge content that belongs in separate paragraphs into one mega-paragraph. Each paragraph must be clearly distinct and serve a different job:
  * P1 — OPENING: one paragraph. The opening move per the rules below. Do NOT end P1 with a filler/transition sentence like "That's the day-to-day core of what I do", "That's what my role looks like", "That's the shape of my current work", or any sentence that restates/labels what the paragraph just said. End P1 on a concrete sentence of content, not a meta-comment.
  * P2 — CORE EVIDENCE: one paragraph telling a coherent story about the candidate's most relevant work — 2 to 4 specific achievements with concrete detail. P2 has ONE theme (e.g. analytical work, operational delivery, project leadership) — do NOT try to cram every achievement in the profile into this paragraph. Leave material for P3.
  * P3 — either a GENUINE why-this-company (conditions below) OR a second distinct experience/story paragraph. A distinct experience paragraph means: ONE story, achievement, or theme not already covered in P2, with its own coherent through-line. It is NOT a grab-bag of leftover facts. It is NOT an orphan sentence appended with "Across both roles..." or "In addition to the above..." or "Beyond that...". Do NOT use P3 to list academic grades, degree classifications, or university achievements unless the candidate is genuinely early-career (no or minimal work experience) OR the JD explicitly requires a specific qualification. Grades belong on the CV.
  * P4 (optional) — only if there is a second genuinely distinct angle worth covering. If there is not, stop at 3 paragraphs. Do not pad.
  * CLOSING: one sentence after the paragraphs, on its own line. See closing rules.
- FORBIDDEN FILLER & GLUE PHRASES — do not use these to stitch sentences or pad paragraphs: "That's the day-to-day core of what I do", "That's the core of what I do", "That's what my role looks like", "That's the shape of my week", "That's the analytical side of it", "That's the [X] side of things", "The analytical work has been the core of it", "The analytical work has been central to [X]", "The [X] work has been the core", "The [X] side of it has been [Y]", "This has been the focus of my recent work", "Across both roles, I [unrelated fact]", "Across [X] and [Y], I [unrelated fact]" (never glue unrelated items together with "Across..."), "Beyond that, I [unrelated fact]", "In addition to the above", "On top of that", "What's more". Never open a paragraph with a vague summary sentence like "The [X] work has been [abstract phrase]" — open with a concrete sentence that does actual work. If a sentence only exists to transition between disconnected facts, delete it. Every sentence must carry content.
- NEVER END A PARAGRAPH WITH A CHARACTERISING SUMMARY — in addition to all existing self-characterising bans: do not end any paragraph with a sentence of the form "[doing X] gave me a grounding in the kind of [Y] that [Z role/industry] demands", "Doing [X] taught me [abstract Y]", "That experience gave me [abstract quality]", "[X] prepared me for [Y]", "That work built the foundation for [Y]", "[X] is the kind of [Y] that translates directly to [Z]", "[X] maps to the kind of work [Z] requires", "That [abstract pattern / cross-functional approach / data-to-decision pattern] has carried through into my [current / every] role", "That way of working has carried through", "That habit has shaped how I [do Y]", "That [abstract quality] has shaped how I approach [Y]", "I've brought that [abstract pattern] into every role since", "That's how I've always approached this kind of work". Any sentence that abstracts the previous concrete work into a "pattern" or "approach" and then claims the candidate has carried it forward is banned. After your last concrete sentence in a paragraph, STOP. Do not explain what the paragraph showed. Do not summarise the candidate's ways of working.
- Include at least one quantified achievement (numbers, percentages, scale)
- Mirror terminology from the job description naturally — do not stuff keywords
- FIT TO THIS ROLE — MANDATORY POSITIVE REQUIREMENTS (these override any fear of editorialising — using JD vocabulary to establish role fit is NOT editorialising, it is what a good cover letter does):
  (i) The target company's name MUST appear at least once in the letter body. It MUST NOT appear in the opening sentence (see opening bans). Natural places: a mid-sentence reference in P2 or P3, or the closing. Do not use it as flattery — use it as context ("the Release and Follow-Up function at JLR", "what [Company]'s [team] handles", "the role at [Company]").
  (ii) Somewhere in P2 or P3 you MUST include one sentence that names a SPECIFIC function, team, process, or responsibility from the JD and grounds it in parallel work the candidate actually does. Recommended shape (adapt, do not copy verbatim): "A large part of my current role is what the [named JD function/team/process] handles: [AT MOST THREE specific responsibilities drawn from the JD's language, phrased neutrally, each item MAX ~8 words]." HARD LENGTH LIMIT on this sentence: 35 words total, maximum. If you have more than three strong parallels, PICK THE THREE STRONGEST and stop — do not cram every JD duty into one sentence. This sentence establishes role-fit using the JD's own vocabulary WITHOUT editorialising. HARD RULES for this sentence: no "at scale", no "at this level", no "in an environment like this", no scale comparisons, no gap-naming, no commentary like "is work I understand", "is what a [role] does", "maps directly to", "is the kind of work [Z] requires" — just list the responsibilities and move on to the next point.
  (iii) Weave at least three JD-specific phrases or responsibilities naturally into P2 or P3, using the JD's own vocabulary. Not keyword-stuffing — genuine parallels. Example: if the JD says "investigate stock discrepancies" and the candidate does similar work, use that phrase or a close variant rather than a generic paraphrase.
- These positive requirements REPLACE the old "one paragraph specifically on why THIS company" rule. You do NOT need a dedicated why-this-company paragraph. Instead, the company and the specific role are integrated into the evidence paragraphs through JD-vocabulary and one named-function sentence. A separate why-this-company paragraph is still permitted only under the STRICTER RULE below (both-conditions must be met), but the default should be integration, not a dedicated paragraph.
- Write about what the candidate brings TO the employer, not what they want FROM the job
- ${toneGuide}
- CLOSING: exactly one short, confident sentence on its own line, strictly 6-18 words. STRICT LENGTH LIMIT — if the closing is longer than 18 words, shorten it. STRUCTURAL CONSTRAINT: the closing must be a FORWARD-ACTION sentence (an invitation to speak, a concrete expression of interest in the role), NOT a summary statement of qualifications.
  CLOSING PATTERN LIBRARY — pick ONE of these eight shapes based on what fits the letter most naturally, then GENERATE a novel sentence that follows the shape (reference the specific role, company, or named function where possible). DO NOT copy any example below verbatim — use the shape only:
    Shape 1 — Forward invitation (classic, reliable): "I'd welcome the chance to discuss the [named function / role] in more depth."
    Shape 2 — Specific-hook (name something concrete from the letter or JD): "The [specific JD thing, e.g. 'supplier recovery work in MP&L'] is exactly the challenge I want to take on next."
    Shape 3 — Direct availability: "Available to talk this through at a time that suits you."
    Shape 4 — Concrete offer: "Happy to walk through any of the [named systems / projects] I've described on a call."
    Shape 5 — Interest-led short: "Really keen to take this further with the [named team / function] at [Company]."
    Shape 6 — Exploration-style: "Would be glad to explore how the work I've described maps to the [named function]."
    Shape 7 — Forward-looking: "Looking forward to discussing this with you."
    Shape 8 — Plain confident short: "Glad to discuss the role further."
  Variation across letters is the goal — do not default to Shape 1 every time. If the letter includes a specific named function or JD detail, prefer Shape 2, 5, or 6. If the candidate is a generalist applying to a role without a distinctive named function, Shapes 1, 3, 4, 7 or 8 work well. Each shape should produce a CLOSING SPECIFIC TO THIS LETTER — if the sentence could be pasted onto any other cover letter, rewrite it.
  BANNED STEMS for the closing (do not start the closing with any of these): "I'd welcome a conversation about", "My experience in [list]", "I'm confident my experience", "What I can bring to [team]", "I would bring", "I can offer", "I am well-placed to", "Given my background in", "With my experience in". If your closing starts with "My experience" or lists qualifications, you have written a summary sentence, not a closing — delete it and write a forward-looking invitation instead. The closing MUST reference the specific role or company by name — a generic "happy to chat" is not acceptable. Write a closing that only makes sense for THIS role at THIS company. The closing is an INVITATION TO SPEAK — not a summary of qualifications, not a recap of the letter, not a three-part self-promotion. CONSTRAINTS: first-person, warm, confident, references the role/company/function specifically, is NOT a question, does NOT ask for anything, does NOT hedge on fit, does NOT list qualifications, does NOT copy a stock example. BANNED closing templates: "I'd welcome the chance to talk through how my experience translates into [X]", "talk through how my experience translates", "how my background aligns with", "how my skills align with", "how my experience maps to", "I'd welcome the opportunity to discuss how [X] could [Y]", "I'd be delighted to discuss further how", "if it looks like the right fit", "if the fit looks right", "if this sounds like a good match", "if you think I'd be a good fit", "Happy to talk through any of this in more detail", "Happy to discuss any of this further", "Happy to go into more depth", "My experience in [A], [B], and [C] would contribute directly to [team] at [Company]", "I'm confident my experience in [A], [B], and [C] [would / will] [Y]" (these are summary statements, not invitations to speak), "from day one", "from an early stage", "from the outset", "hit the ground running", "I would contribute from [time phrase]". Do not copy verbatim any closing you have seen elsewhere.
- Location or geography should not appear in the closing paragraph at all
- Refer to the candidate's current employer by name AT MOST ONCE in the entire letter. After the first mention, use "the business", "the company", or "my current role"
- EM-DASH BAN — HARD RULE: The character — must not appear anywhere in your output. Not once. Not mid-sentence, not in parentheticals, not anywhere. Double hyphens (--) are also banned. This is a non-negotiable formatting requirement. Use a comma, colon, semicolon, or start a new sentence instead. There are no exceptions to this rule
- If the JD lists a specific requirement the candidate meets (licence, degree), only mention it if it weaves naturally into a relevant sentence — never as a standalone line
- Never editorialize. This means: do NOT comment on the role, the company, or the candidate's own experience. Do NOT explain why something is relevant or impressive. Do NOT say what a methodology or approach "is" or "means". Do NOT describe the company's own culture, values, team structure, or department purpose back to them — they wrote the JD, they know what their team does. Do NOT state the connection between the candidate's experience and the role — show the work and let the reader make the connection. Banned commentary patterns: "That's a methodology I respect", "the research element is real and substantive", "these aren't peripheral tasks here, they're the role", "that's exactly what this role needs", "that's a reasonable description of what X does", "which maps directly to", "sits at the exact intersection", "sits at the point where", "directly applies", "I respect this approach", "That's how I work", "that pattern of [X] is how I've approached every role", "[X] means a [role title] needs to", "that's what a [role] does", "is how I operate", "is work I understand in practice", "I've carried that [X] into everything since", "[function/team] exists to", "[X] [is/are] specific to operating at a scale and complexity I want to work within", "[X] [is/are] specific to [abstract quality] I want to [work within / work towards]", "[X] [is/are] the kind of [Y] I've been working towards in [Z]", "[X] [is/are] representative of [abstract quality]", "[X] [is/are] characteristic of [abstract quality]", "[X] [is/are] symptomatic of", describing what a department or role is for, explaining at the end of a paragraph what the candidate's work "has been building towards" or "has prepared them for". Never end a paragraph with a self-characterizing summary sentence — state the achievement and stop; let the reader draw their own conclusion
- NEVER INFLATE AUDIENCE OR STAKEHOLDER LEVEL — do not upgrade the audience or recipients of the candidate's work beyond what the source text explicitly states. If the CV/skills say "I report to the director" or "I produce summaries for the team" or "I update the owners", the letter must not rewrite this as "senior stakeholders", "senior leadership", "executives", "the board", "the leadership team", "C-suite", "cross-functional leaders", or similar inflated labels. If the source names a specific audience (director, owner, manager, team, client), use that specific word or a close synonym — do not upgrade it. Do not pull stakeholder/seniority language from the job description and apply it retroactively to the candidate's current work. This also applies to verbs: do not upgrade "told the director" to "briefed senior stakeholders"; do not upgrade "sent updates to the team" to "delivered executive reports".
- ATTRIBUTION INTEGRITY — never inflate the candidate's contribution beyond what the source text says. Do NOT insert solo-authorship words like "from scratch", "single-handedly", "designed and built myself", "I created", "I architected", "I built out", or "I built and implemented" unless the CV or skills text explicitly states solo ownership. When the source text is ambiguous or uses verbs like "built", "developed", "implemented", "launched", "delivered", "rolled out", you must DEFAULT to neutral verbs that do not overclaim: "worked on", "helped build", "contributed to designing", "was central to delivering", "led the [specific part of] work on". Never upgrade a neutral verb in the source to a stronger one ("built" → "designed and built", "developed" → "built from scratch", "worked on" → "led"). Never drop mentions of collaborators, managers, directors, or teammates that appear in the source text — if the source says "worked with my director to build X", the letter must preserve the collaboration, not rewrite it to "I built X". When in doubt, understate.
- NEVER NAME CANDIDATE GAPS — do not write sentences that name specific tools, systems, acronyms, processes, or requirements from the JD as things the candidate does not have, has not worked with, or is yet to learn. Banned constructions: "X, Y and Z are all things I don't have direct experience with yet, but...", "I haven't worked with [named JD system] before, however...", "I'm new to [named JD system]", "while I haven't used [X] directly...", "learning [specific JD system] will be [the natural next step / straightforward / fast]". If the candidate lacks experience with a JD requirement, stay silent on it — do not flag it, do not name it, and do not pre-empt the objection. The hiring manager has the CV. Never list JD-named systems the candidate cannot claim.
- NEVER CLAIM OR IMPLY EXPERIENCE WITH NAMED JD SYSTEMS THE CANDIDATE LACKS — if the JD names a specific system, acronym, or proprietary process (e.g. CMMS, SPEEDY, SSDS, SAP, Oracle, a named internal tool) and the candidate's CV/skills/profile does not explicitly show direct experience with THAT NAMED system, you must NOT claim or imply it. Specifically banned: "which required the same kind of [named system] [work / integrity / discipline] the role demands", "similar to [named system]", "the same kind of [named system] rigour", "equivalent to working with [named system]", "functionally similar to [named system]", "which parallels [named system] work", "drawing on the same [named system] principles". The candidate's actual parallel work may be described ONLY in generic functional terms (data integrity, schedule accuracy, inventory reconciliation, supplier performance tracking) WITHOUT comparing it to or invoking the JD-named system. Using the JD-named system as a yardstick to measure the candidate's work against is a form of overclaiming even when dressed as comparison.
- NEVER UNDERSELL AGAINST THE TARGET COMPANY — do not write any sentence that compares the target company's scale, complexity, sophistication, pace, or standards unfavourably to the candidate's current or past workplaces. Banned patterns: "[Company]'s scale introduces a level of complexity that's genuinely different from [smaller operations / what I've seen]", "a different scale of supply chain", "a more complex environment than I've worked in", "a step up from what I've done before", "at the level [Company] operates at, the demands are different", "[Company] operates at a scale I want to grow into", "I'm looking to move up to [Company]'s level". The letter must treat the candidate as a peer applying for the role, not a smaller-league applicant stretching upward.
- NEVER USE THE "FAST LEARNER" PIVOT — do not pivot from any gap, unfamiliarity, or weakness into a claim about speed of learning, adaptability, or transferability. Banned patterns: "the foundation is there", "the foundations are there", "learning the specific systems is [the natural next step / straightforward / fast]", "I consistently pick up new tools quickly", "I'm a quick study", "I learn ahead of schedule", "I hit the ground running", "the skills transfer directly", "it's just a matter of learning the specifics", "picking up [X] will be [fast / natural / intuitive]". If you find yourself about to write this pivot, it is a signal that the preceding sentence was a gap-admission — delete both and write a concrete achievement instead.
- WHY-THIS-COMPANY PARAGRAPH — STRICTER RULE: a why-this-company paragraph is only permitted if BOTH of these conditions are met: (a) external company research below names a specific initiative, product decision, news item, market move, or unusual process that the candidate can genuinely comment on, AND (b) the candidate's profile / skills / "anything to add" context establishes a real personal connection to that thing (direct experience of the product, a past project in the same area, a named team or tool overlap). If BOTH conditions are not met, you MUST write a third experience/achievement paragraph instead — not a hybrid, not a softened "I admire X", not "I'm drawn to Y". No paragraph that starts with "[Company]'s..." and then describes what the company does, what scale they operate at, what their approach is, or what their team handles. No abstract admiration. When in doubt, default to a third experience paragraph.
- NO FABRICATED COMPANY AWARENESS — never invent the candidate's engagement with, awareness of, or interest in the company's activities, news, announcements, products, leadership, or initiatives. Do NOT write phrases like "I followed [Company]'s recent push to...", "I noticed [Company]'s move into...", "I've been watching [Company]", "I was drawn to [Company] when...", "I read about [Company]'s...", "caught my attention", "I've been tracking [Company]". If the candidate's profile, skills, "anything to add", or company research does not establish this awareness as a real fact, you must not assert it. If no genuine awareness is available, use a different why-this-company angle (concrete detail from the JD the candidate has real experience with) or replace the paragraph with a third experience paragraph entirely.
- WHY THIS COMPANY paragraph: HARD RULES — (1) Never describe the company's own department, function, or process back to them. Never explain what a team exists to do or why a role matters — they know. (2) Never restate JD requirements as setup for your own claims ("The X remit... is work I understand"). (3) Never use a JD detail as editorial commentary — only use it if you can show direct personal experience with that specific thing. If external research is provided: use a named initiative, product decision, market move, or specific recent development. If no research: either reference something concrete from the candidate's own direct experience of the company's products, customers, or market — or pick one specific, unusual detail from the JD (a named system, a specific process, an unusual constraint) and connect it to a real personal experience. If nothing genuine and specific can be said about this company, write a third strong experience/achievement paragraph instead — a hollow "why this company" paragraph is worse than no "why this company" paragraph at all. Do NOT make generic observations about culture or values that could apply to any company ("commitment to continuous improvement", "people-first culture", "innovation at the core")
- BANNED PHRASES — never use: "team player", "hard worker", "passionate about", "I believe I would be a great fit", "results-oriented", "proven track record", "detail-oriented", "synergy", "I am excited to apply", "dynamic", "not just a [noun]", "that's exactly the kind of", "that's the kind of X I", "from day one"
- Vary sentence length. Use contractions where natural. Sound like a real person
- Do NOT summarise the CV — tell a story the CV cannot tell

CANDIDATE:
Name: ${profile.full_name ?? ""}
Headline: ${profile.headline ?? ""}
Location: ${profile.location ?? ""}
Sign-off: ${profile.sign_off ?? "Kind regards"}
Contact: ${contactLine}

CV (use the experience and achievements — ignore any stated career direction or target industry in the personal statement, which may have been written for a different role):
${cvContent}

ADDITIONAL SKILLS & EXPERIENCE (beyond CV — draw on these where relevant; adapt, rephrase, or condense them to fit the letter's flow naturally — do not force them in or copy them rigidly):
${skillsText}

${writingStyleText ? `WRITING STYLE — match this voice:\n${writingStyleText}\n` : ""}
${companyResearch ? `COMPANY RESEARCH — use specific details from this:\n${companyResearch}\n` : ""}
${alwaysMentionSection ? `${alwaysMentionSection}\n` : ""}
${neverDoSection ? `${neverDoSection}\n` : ""}
${extraToneSection ? `${extraToneSection}\n` : ""}
OUTPUT: Return only the complete cover letter body. Start with "${salutation}," on its own line, then a blank line, then the first paragraph. End with the sign-off and name formatted exactly like this — two separate lines, comma after the sign-off:
${profile.sign_off ?? "Kind regards"},
${profile.full_name ?? ""}
${clPrefs.include_header ? `Do NOT add any contact details (phone, email, LinkedIn) after the name.` : ``}No preamble, no explanation, no subject line. FINAL REMINDER: the em-dash character (—) must not appear anywhere in your output.`;
}

export async function generateCoverLetter(input: {
  jobDescription: string;
  companyName?: string;
  roleName?: string;
  cvId?: string;
  anythingToAdd?: string;
  pivotContext?: string;
  applicationId?: string;
}): Promise<{ text: string; provider: string; letterId?: string }> {
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

${input.pivotContext?.trim() ? `CAREER PIVOT — the candidate has flagged this as a deliberate career change or sector move. Use this ONLY if it provides specific, genuine framing (transferable skills named, concrete reason for the move). If it is vague ("I want a change", "looking for something new"), ignore it entirely and silently. If specific: use the Honest Bridge opening — show the parallel work, let the hiring manager draw the connection themselves. Never explicitly name the career change ("I am moving from X to Y"). Override the CV personal statement's stated career direction with this framing:\n${input.pivotContext}` : ""}
${input.anythingToAdd?.trim() ? `CANDIDATE CONTEXT — additional framing and emphasis. Use as high-priority context:\n${input.anythingToAdd}` : ""}`;

  const result = await callAI({
    task: "cover-letter",
    prompt: userPrompt,
    systemPrompt,
    userPreference: taskPrefs["cover-letter"],
    connectedProviders: keys,
  });

  const signOff = profile.sign_off ?? "Kind regards";
  const fullName = profile.full_name ?? "";

  // Critic pass: second model call that checks for the specific patterns that
  // keep leaking through prompt bans, and rewrites offending sentences in place.
  // Falls back to the original text if the critic output is malformed.
  const revised = await reviseCoverLetter(
    result.text,
    taskPrefs["cover-letter"],
    keys,
    signOff,
    fullName,
  );

  const cleanText = ensureNameAfterSignOff(
    fixSignOff(sanitiseLetter(revised), signOff, fullName),
    signOff,
    fullName
  );

  // Auto-save (body only — header is rendered in the UI)
  const letterId = await saveCoverLetter(cleanText, input.applicationId, result.provider);

  return { text: cleanText, provider: result.provider, letterId };
}

export async function refineCoverLetter(input: {
  originalLetter: string;
  refinementRequest: string;
  jobDescription: string;
}): Promise<{ text: string; provider: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const [taskPrefs, keys, profile] = await Promise.all([getTaskPreferences(), getApiKeyValues(), getProfile()]);
  if (Object.keys(keys).length === 0) throw new Error("No AI provider connected.");

  const result = await callAI({
    task: "cover-letter",
    systemPrompt: "You are an expert cover letter editor. Apply the requested changes and return the complete updated letter. Preserve the overall structure and quality. HARD FORMATTING RULES: (1) The em-dash character (—) must not appear anywhere in your output — not once. Use a comma, colon, or new sentence instead. This is non-negotiable. (2) No double hyphens (--). (3) No editorializing or commentary. (4) No banned phrases: team player, passionate about, proven track record, excited to apply, I look forward to hearing from you, from day one. CRITICAL OUTPUT RULE: your response must begin IMMEDIATELY with the letter greeting (e.g. 'Dear Hiring Team,') — no preamble, no explanation, no commentary before or after the letter. If you choose not to incorporate something, do so silently.",
    prompt: `Original cover letter:\n\n${input.originalLetter}\n\nRefinement request: ${input.refinementRequest}\n\nReturn the complete updated cover letter.`,
    userPreference: taskPrefs["cover-letter"],
    connectedProviders: keys,
  });

  // Safety strip — remove any AI commentary before the greeting, then sanitise
  const text = result.text.trim();
  const greetingMatch = text.match(/(Dear\s+\S)/);
  const stripped = greetingMatch ? text.slice(text.indexOf(greetingMatch[0])) : text;
  const signOff = profile.sign_off ?? "Kind regards";
  const fullName = profile.full_name ?? "";
  const cleaned = ensureNameAfterSignOff(
    fixSignOff(sanitiseLetter(stripped), signOff, fullName),
    signOff,
    fullName
  );

  return { text: cleaned, provider: result.provider };
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
  letterId: string | null | undefined,
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

  if (app?.id && letterId) {
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
