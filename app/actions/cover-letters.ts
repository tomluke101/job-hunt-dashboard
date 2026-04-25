"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";
import OpenAI from "openai";
import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";
import { getProfile, getCVs, getSkills, getEmployers, getWritingExamples, getCoverLetterPrefs } from "@/app/actions/profile";
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

3. SELF-CHARACTERISING SUMMARY SENTENCES — be AGGRESSIVE in catching these. If a sentence abstracts concrete activity into a branded noun ("pattern", "approach", "grounding", "foundation", "understanding", "mindset") and then claims the candidate acquired, developed, carries, or applies it, it is banned. The SPECIFIC WORDING DOES NOT MATTER — match by SHAPE. Here are the shapes to catch:
   - "[activity / experience] gave me [a grounding / foundation / understanding / strong sense / feel / instinct / direct experience / hands-on experience / real exposure / first-hand exposure / valuable insight] [in / for / of / into] [abstract noun]". Example hits: "gave me a strong grounding in structured coordination", "gave me a foundation in analytical thinking", "gave me direct experience of coordinating cross-functional change", "gave me hands-on experience of [abstract Y]", "which gave me [any abstract acquired quality]". Match this BROADLY — any verb-of-acquiring + abstract-noun-of-quality applied to the candidate's past activity is the same banned shape.
   - "[activity / experience] has pushed me to develop [an approach / a method / a way of thinking / a habit] [to / for / around] [abstract noun]". Example hit: "it's pushed me to develop a structured, logical approach to competing priorities and distressed supply situations".
   - "[activity / experience] has taught me [abstract quality / how to do abstract thing]".
   - "[activity / experience] has given me [insight / perspective / discipline / rigour] [in / on / around] [abstract noun]".
   - "[activity / experience] has shown me [abstract truth]".
   - "[activity / experience] has refined / sharpened / honed my [abstract quality]".
   - "[X] has carried through into [my current role / every role since]".
   - "[X] has shaped how I [approach / think about / work with / engage with] [abstract topic]", with or without "end to end", "from the ground up", "at every level".
   - "[X] sits at the [intersection / crossover / boundary / meeting point] of [Y] and [Z]" — editorialising about the role or candidate's work.
   - "[X], all of which [sit / are] at the [core / heart / centre / centre of gravity] of [my current work / what I do / my role]" — meta-positioning the parallel between JD responsibilities and the candidate's work, instead of just letting the list speak for itself. Same family. FIX: drop the "all of which sit at the core of my current work" tail; the listed items + the JD-integration framing already establish the parallel.
   - "Doing / Working [X] taught me [abstract quality]".
   - "[X experience] prepared me for [Y] / built the foundation for [Y]".
   - "[X] is the kind of [Y] that translates directly to [Z]", "maps to the kind of work [Z] requires", "underpins both [A] and [B]", "mirrors the [abstract quality] [Y team / role] requires", "closely mirrors the [abstract quality / coordination] [Y] requires", "reflects the [abstract quality] needed for [Y]".
   - Any sentence that names a pattern/approach/habit/mindset as something the candidate "brings", "has", "lives by", or "developed".
   UNIVERSAL TEST: if a sentence starts by describing a past or ongoing activity and ends with an abstract quality the candidate has or developed as a result, it is a self-characterising summary. DELETE IT.
   FIX: delete the sentence entirely (preferred), OR replace with a concrete continuation naming one specific thing the candidate does ("I still produce the weekly supplier summary for the director" — fine; "that approach has carried through" — banned). When in doubt, DELETE — the letter is almost always stronger without these sentences.

3b. ATTRIBUTION INFLATION VARIANTS — "from scratch" is banned. So are all its variants that mean the same thing: "from the ground up", "from zero", "end to end by myself", "built entirely by me", "solo", "single-handedly", "without help", "independently", "on my own", "by myself". Any modifier that asserts solo authorship of a system / project / build is banned unless the source CV/skills explicitly states solo ownership. Specifically: "I designed and INDEPENDENTLY developed X" → drop "independently". "I single-handedly built X" → drop "single-handedly". "I built X on my own" → drop "on my own". If a sentence describes a collaborative build and contains any of these phrases, REMOVE the phrase — the collaboration mention does not cancel the overclaim. Default to neutral verbs ("worked on", "developed", "designed") with NO solo-claim modifier unless the source explicitly states solo authorship.

3c. MIXED-VOICE ATTRIBUTION — if a sentence pairs a solo-claim verb with a collaborative-claim verb on the same object ("I built and co-designed an ERP system with the company director", "I designed and led a team build of X with my manager"), the solo-claim verb is overclaiming. The collaboration applies to the whole work, not just half of it. FIX: drop the solo-claim verb, keep the collaborative verb. "I built and co-designed an ERP system with the company director" → "I co-designed and helped build an Airtable-based ERP system with the company director" (or simply "I worked with the company director to design and build..."). Never use "I built X" + "with [person]" together — the "with [person]" applies to the building, so use a collaborative verb throughout.

3d. OVER-SPECIFIED ACADEMIC GRADES — once a credential is named (first-class, distinction, summa cum laude, etc.), do NOT also include numeric grade percentages or specific module marks. The credential conveys top performance on its own; adding "averaging over 80% in my final year" / "with an 82% final mark" / "scoring 85% in my dissertation" reads as bragging on top of an already-strong claim. FIX: drop the percentage. Keep only the credential name and university. Only exception: if the JD explicitly requires a specific minimum mark / GPA, the candidate may state it once.

3e. ATTRIBUTION CONSISTENCY ACROSS THE LETTER — scan the whole letter for contradictions in how the candidate describes the same piece of work in different paragraphs. If the candidate says in one paragraph "I collaborated with the company director to design and build an Airtable-based ERP system" and in another paragraph says "I've self-taught the systems I built at Grain and Frame" referring to the same systems, that is a contradiction — one frames the ERP as collaborative, the other as solo. FIX: rewrite the second mention to match the first ("the systems I helped build" rather than "the systems I built"). The whole letter must be internally consistent on who built what. The collaborative framing wins — never let a later sentence quietly upgrade earlier collaborations into solo claims.

3f. AWKWARD DEGREE INTEGRATION — when a degree credential is woven into P1, watch for stilted constructions. Banned shapes: "After completing [degree], this role has been where that [abstract X] has been put to practical use", "After completing [degree], I joined the business and have taken on [abstract remit]", "After completing [degree], I joined the business and [abstract continuation]", "After completing [degree], my work in [Y] has continued to develop", "Following my [degree], I have been [doing Y]", "After completing [degree], I joined [employer] and have taken on a broad operational remit", any sentence with "I joined the business" / "I joined the company" without naming the employer when the employer is named elsewhere in the letter. The fix must include the actual employer name (Grain and Frame) AND a concrete continuation (a real activity or role start), not abstract phrases like "broad operational remit" / "the full supply chain cycle" / "a wide-ranging role" / "a hands-on remit". Good shapes (do not copy): "After completing a first-class Business degree at Birmingham City University, I joined Grain and Frame as a Supply Chain Analyst...". REWRITE OPTION (preferred): if the P1 opening already has a strong concrete first sentence with the role and employer named, REMOVE the degree-mention sentence from P1 entirely — move it to the END of the internship/student-period paragraph as a clean chronological fact ("...alongside completing a first-class Business degree at Birmingham City University"). This is almost always the cleaner placement.

4. OVERCLAIM VIA JD-NAMED SYSTEMS: sentences that compare the candidate's work to a specific JD-named system/acronym ("which required the same kind of CMMS integrity", "similar to SPEEDY", "the same kind of [named system] rigour", "which parallels [named system]"). FIX: remove the comparison; describe the work in generic functional terms only.

5. AUDIENCE INFLATION: phrases like "senior stakeholders", "senior leadership", "executives", "the board", "leadership team", "C-suite" applied to the candidate's current work when not supported by context. FIX: replace with the actual audience (director, team, manager, owners) or generalise ("the business", "the team").

6. CLOSING ISSUES — the closing's REGISTER must match the rest of the letter body. For most cover letters (professional/balanced tone, traditional employer), the conventional professional closing is the correct choice — do NOT push toward casual unless the body is conversational.
   - Over 22 words → shorten to 6-22.
   - The classic "I would welcome the opportunity to discuss this role and how my experience aligns" family is GOOD for professional-tone letters — DO NOT flag it as a problem. It is the convention and reads as professional, not as AI-cliché.
   - DO flag and rewrite these summary-statement closings (these are bad regardless of tone): "My experience in [list of qualifications]", "I'm confident my experience would", "I am well-placed to", "Given my background in", "With my experience in", "I believe my skills would", "It would be an honour to".
   - DO flag "I look forward to hearing from you" — overused to the point of meaninglessness. Replace with a closer from the F1-F5 family in the system prompt's pattern library.
   - DO remove "from day one", "from an early stage", "from the outset", "hit the ground running".
   - Formulaic "discuss the [role title] at [Company]" is acceptable for professional tone — only flag if the closing reads as obviously generic AI-boilerplate (e.g. doesn't reference the named role or function at all and could be pasted onto any cover letter).
   - Inconsistent register: if the letter body is professional/formal but the closing is overly casual ("happy to chat", "let me know if interested"), rewrite to a professional closing. If the letter body is conversational, the casual closing is fine.
   FIX: rewrite to a closing in the appropriate register that references the role/company/function naturally and is between 6-22 words. Default to the F1-F5 pattern family for professional-tone letters.

7. OTHER BANNED PHRASES (anywhere): "team player", "hard worker", "passionate about", "proven track record", "detail-oriented", "results-oriented", "I believe I would be a great fit", "I am excited to apply", "dynamic", "synergy". FIX: remove or replace with concrete detail.

8. EM-DASHES (—) anywhere in the output. FIX: replace with a comma or new sentence.

9. FILLER/GLUE TRANSITION SENTENCES AND PHRASES — STRICT ENFORCEMENT, NO EXCEPTIONS:
   Specific banned phrases (delete on sight, do not negotiate): "That's the day-to-day core of what I do", "That's the analytical side of it", "The analytical work has been the core of it", "In addition to the above", "On top of that". Topic-transition fillers that add zero information: "On the supplier side", "On the inventory side", "On the logistics side", "On the reporting side", "On the analytical side", "On the procurement side", "On the [X] side", "On the [X] side of things", "From a [X] standpoint", "From a [X] perspective". These are pure filler. FIX: delete the phrase. The sentence usually works fine without it (e.g. "On the supplier side, I built X..." → "I built X..."). If the deletion makes the sentence ungrammatical, also delete or rewrite the rest of the sentence.

10. ORPHAN/PADDING PARAGRAPHS — a single-sentence final paragraph (BEFORE the closing) that reads as a tacked-on summary stat list or skill recap (e.g. "My Excel skills are advanced, and I have hands-on experience with ERP systems, demand forecasting, and analytical investigation."). These are fillers, not paragraphs. FIX: either delete the orphan paragraph entirely, OR fold its content into P2 or P3 if there is a genuinely useful detail in it. Three substantive paragraphs is better than three substantive paragraphs plus a one-line orphan.

11. INCOHERENT MULTI-TOPIC PARAGRAPHS — a paragraph that switches subject mid-way without a coherent through-line. Example: P3 starts with Siemens activities, then jumps back to Grain and Frame ("Managing running-out... is something I handle at Grain and Frame regularly"), then jumps again to JLR ("The employee learning scheme is also a genuine draw..."). Three different employers/contexts in one paragraph = incoherent. FIX: identify the paragraph's primary topic (usually the first 1-2 sentences). REMOVE any sentences that pivot to a different employer or unrelated topic. Hooks belong in topic-matched paragraphs (e.g. an SSDS hook about procurement work belongs in the Grain and Frame paragraph, NOT in the Siemens paragraph). If a hook has been jammed into a paragraph that doesn't match its topic, either move it to a topic-matched paragraph or delete it. A coherent single-topic paragraph is always better than a multi-topic paragraph with a hook crammed in.

12. EMPLOYER-NAME ELISION — if the candidate's current employer is mentioned somewhere in the letter and then later referred to as "the business" / "the company" / "the role" without re-naming, that's fine. BUT: never write "I joined the business" / "I joined the company" without naming the employer if the employer hasn't been named yet in the surrounding context. FIX: if the employer needs to be referred to in a chronology stem ("After completing my degree, I joined [X]"), it must be NAMED ("Grain and Frame"), not "the business" / "the company".

13. OVERCLAIMING DEGREE FUNDING — banned phrasings: "I've self-funded my development through my degree", "I funded my own degree", "I paid my way through university". These imply a unique self-funding context most candidates don't actually have (a standard undergraduate degree with student loans is not "self-funded" in the meaningful sense). FIX: rewrite to focus on self-direction without claiming to have funded the degree, e.g. "I've taken responsibility for my own development through [specific things — courses, self-taught systems, etc.]" — or remove the self-funding angle and focus on the demonstrable self-development evidence.

14. JD-META-COMMENTARY — sentences that tell the JD's reader what their own JD says are banned. The hiring manager wrote (or has read) the JD; they do not need it summarised back to them. Banned constructions: "[X] is listed as a significant advantage in the JLR role", "[X] is mentioned in the JD as essential", "[X] is something the role specifies", "as the JD notes, [X]", "you mention that [X]", "you've outlined [X] as a key responsibility", "the role asks for [X], and [Y]", "as outlined in the job description". These all narrate the JD back at its author. FIX: drop the meta-commentary entirely. State the candidate's relevant work directly without referencing where the requirement came from. E.g. "Working experience of MRP and ERP systems is listed as a significant advantage in the JLR role, and it's been central to mine" → DELETE the sentence (and check rule 15 — the candidate may not actually have formal MRP/ERP experience).

15. NAMED-TECHNOLOGY-CATEGORY OVERCLAIM — do not claim the candidate has experience with a specific named technology category (MRP, ERP, SAP, Oracle, Workday, Salesforce, Tableau, Power BI, AWS, Azure, etc.) unless the candidate's CV/skills/profile EXPLICITLY names that category. Functionally similar tools do not count: building an Airtable system is NOT "experience with ERP systems"; using Google Sheets is NOT "experience with Excel" (well, related but specific systems matter); building automation in Zapier is NOT "experience with workflow platforms like X". If the candidate has a related-but-different tool, describe it specifically (e.g. "I built an Airtable-based ERP system" — fine, names the actual tool) — never abstract upward to a category the candidate hasn't worked with directly. FIX: remove or rewrite any sentence that claims membership in a named technology category without explicit profile evidence.

16. EMPHASIS-VIA-NEGATION — sentences that add emphasis by negating the opposite are AI-written. Banned shapes: "[X] is a regular part of the role, not an occasional one", "I do this daily, not occasionally", "this is a core part of my work, not a one-off", "it's central, not peripheral", "it's a habit, not a one-time effort", "this is the rule, not the exception". Real human writing just states the positive ("X is a regular part of my role") and stops — adding "not Y" is the AI tic of trying to add weight by contrast. FIX: delete the "not [Y]" half of the construction; keep only the positive statement.

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
      messages: [{ role: "user", content: `In 2-3 factual sentences, focus ONLY on: ${companyName}'s most recent concrete business moves, named initiatives, product/strategy announcements, market shifts, or operational priorities (within the last 12 months if possible). Do NOT include culture statements, mission language, stated values, employer-brand copy, or generic descriptions. Just the specific, concrete, recent facts.` }],
    });
    return res.choices[0]?.message.content ?? "";
  } catch { return ""; }
}

function buildSystemPrompt({
  profile, cvContent, skills, employers, writingExamples, companyResearch, clPrefs,
}: {
  profile: Awaited<ReturnType<typeof getProfile>>;
  cvContent: string;
  skills: Awaited<ReturnType<typeof getSkills>>;
  employers: Awaited<ReturnType<typeof getEmployers>>;
  writingExamples: Awaited<ReturnType<typeof getWritingExamples>>;
  companyResearch: string;
  clPrefs: CoverLetterPrefs;
}): string {
  const tone = profile.tone ?? "balanced";
  const toneGuide =
    tone === "formal" ? "Write in a formal, structured, professional tone." :
    tone === "conversational" ? "Write in a warm, direct, conversational tone — confident but human." :
    "Write in a clear, confident, professional-but-human tone.";

  const employerLookup = new Map(employers.map((e) => [e.id, e]));

  const formatEmployerLine = (e: typeof employers[number]) => {
    const dates = e.is_current
      ? `${e.start_date} → present`
      : `${e.start_date} → ${e.end_date ?? "?"}`;
    const summary = e.summary ? ` — ${e.summary}` : "";
    return `- ${e.role_title} at ${e.company_name} (${dates})${summary}`;
  };

  const workHistoryText = employers.length > 0
    ? employers.map(formatEmployerLine).join("\n")
    : "None provided.";

  const skillsText = skills.length > 0
    ? skills.map((s) => {
        const tags = (s.employer_ids ?? [])
          .map((id) => employerLookup.get(id)?.company_name)
          .filter(Boolean);
        const attribution = tags.length > 0 ? ` [from: ${tags.join(", ")}]` : " [general / not employer-specific]";
        return `- ${s.polished_text || s.raw_text}${attribution}`;
      }).join("\n")
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

  return `You are an expert career coach. Write a cover letter that genuinely gets people interviews.

CORE STYLE — write like a thoughtful human writing to another thoughtful human:
- Concrete over abstract. Specific names and numbers over generic descriptors.
- Short sentences over long. Direct over hedged.
- Show; do not tell. State facts and let them carry the weight.
- Sound like a real person. Use contractions where natural. Vary sentence length.
- If a sentence would only ever appear in formal written prose and never in a real conversation, rewrite it.

STRUCTURE — exactly 3 (rarely 4) distinct paragraphs, 250-380 words, then a one-sentence closing on its own line:
- P1 OPENING (one paragraph): introduce what you currently do with concrete activity. Use the role title alone in sentence 1 ("as a Supply Chain Analyst at Grain and Frame, I..."). End on a concrete content sentence — never a meta-comment about the work.
- P2 CORE EVIDENCE: ONE topic, ONE employer (usually the current/most relevant). 2-4 specific achievements with concrete detail. Lead with a sentence that names a specific function/team/process from the JD and grounds it in your parallel work — pick the strongest 3 JD-named responsibilities and stop, max 35 words on that sentence. Numbers over adjectives.
- P3 SECOND DISTINCT paragraph: usually the OTHER employer (internship/previous role). If candidate is early-career and has a notable degree (first-class etc.), END this paragraph with the degree as a clean chronology fact ("alongside completing a first-class Business degree at Birmingham City University").
- P4 (rare): only if a second genuinely distinct angle exists. Otherwise stop at 3.
- CLOSING: one sentence, on its own line. See closing rules.

CLOSING — one sentence, 6-22 words, matching the body's tone. Reference "this role" / "the role" / "the [named function]" — NEVER "the [Job Title] role at [Company]" (redundant; they know who they are). For professional/balanced tone (the default), use one of these shapes (do NOT copy verbatim — generate a novel sentence in the shape):
  F1: "I would welcome the opportunity to discuss how my skills and experience align with this role in further detail."
  F2: "I would welcome the chance to discuss this role and how my background fits in more depth."
  F3: "I would be glad to discuss how I could contribute to the team further."
  F4: "I would value the opportunity to discuss this role and the work involved in more detail."
For conversational tone only, drop a register: "Happy to dig into any of this on a call.", "Let me know if you'd like to talk it through."

POSITIVE FIT REQUIREMENTS:
- Name the company at least once in the body (NOT in sentence 1). Natural mid-sentence reference in P2 or P3, or in the closing.
- Use the JD's own vocabulary for at least three specific responsibilities/processes/functions naturally (not keyword-stuffing).
- If the JD names a specific scheme/system/function AND the candidate has parallel evidence in their profile, OPTIONALLY weave one 1-2 sentence integration into a topic-matched paragraph. MAX ONE such hook per letter, never bolt on a separate paragraph for it. Skip if no natural fit exists.

ATTRIBUTION HONESTY:
- If the candidate's profile says they collaborated with someone (manager, director, team), preserve that EXACTLY. "Collaborated with the director to build" stays "collaborated with the director to build" — never rewrite as solo.
- Never insert solo-claim modifiers ("from scratch", "single-handedly", "independently", "on my own", "from the ground up") unless the source text explicitly states solo authorship.
- Never claim experience with a named technology category (MRP, ERP, SAP, Oracle, Tableau, Power BI etc.) unless the profile explicitly names that category. Specific tools the candidate actually uses (e.g. "Airtable") are fine — never abstract upward.
- Never inflate the audience: "the director" stays "the director", not "senior stakeholders" / "senior leadership" / "executives".
- Refer to the current employer by name AT MOST ONCE in the body. After that use "the business" / "the company" / "my current role".

HARD FORMATTING:
- No em-dashes (—) or double hyphens (--) anywhere. Use commas, semicolons, or new sentences.
- First-person throughout ("I", "my", "me"). Never third-person references to the candidate.

BANNED PATTERNS — these are AI tells. Do not use them in any form:
- Editorialising / commentary about the work: "sits at the intersection of", "is the kind of work that", "maps directly to", "translates to", "mirrors the X that Y requires", describing the company's function back to them, explaining why something is relevant.
- Self-characterising summaries (most commonly at paragraph ends): "gave me a grounding in [abstract X]", "gave me direct experience of [abstract X]", "shaped how I approach [abstract X]", "carried through into my current role", "prepared me for", "is the kind of work that translates to". After your last concrete sentence in a paragraph, STOP.
- Filler / glue: "On the X side", "On the X side of things", "On the [supplier/inventory/discrepancy/logistics/reporting] side", "Across both roles", "In addition to the above", "Beyond that", "On top of that", "That's the X side of it", "That's the day-to-day core".
- JD-meta-commentary: "[X] is listed as a significant advantage in the JLR role", "as the JD notes", "you mentioned that". Never narrate the JD back at its author.
- Emphasis-via-negation: "is a regular part of the role, not an occasional one", "this is core, not peripheral". State the positive and stop.
- Stated-values flattery: "I share your commitment to X", "your focus on X resonates with my passion for Y".
- Stilted formal stems: "I am writing to apply", "It would be an honour to", "I look forward to hearing from you", "I would like to express my interest".
- Fast-learner pivot from any gap: "the foundation is there", "I'm a quick study", "natural next step", "the skills transfer directly".
- Naming candidate gaps: never name a JD-required system the candidate lacks. Stay silent.
- Underselling against the target: never "X's scale is genuinely different from smaller operations".
- Awkward degree integration in P1: "After completing X, I joined the business and have taken on a broad operational remit" — banned. If P1 already has a strong opener, put the degree at the END of the internship paragraph instead, NOT in P1.
- Banned phrases anywhere: "team player", "hard worker", "passionate about", "results-oriented", "proven track record", "detail-oriented", "synergy", "I am excited to apply", "dynamic", "from day one", "from an early stage", "from the outset", "hit the ground running".
- Evasive employer descriptors in P1: "at a product-led business", "at a small business", "at a growing company". Use the role title alone if you can't name the employer in sentence 1.

TONE: ${toneGuide}

CANDIDATE:
Name: ${profile.full_name ?? ""}
Headline: ${profile.headline ?? ""}
Location: ${profile.location ?? ""}
Sign-off: ${profile.sign_off ?? "Kind regards"}
Contact: ${contactLine}

WORK HISTORY (structured — use this as the canonical source of truth for which employer the candidate worked for and when. The CV may have additional context but this list is authoritative for employer names, role titles, and dates. P2 should usually focus on the FIRST entry below — the current/most recent employer. P3 should cover the SECOND entry where applicable.):
${workHistoryText}

CV (use the experience and achievements — ignore any stated career direction or target industry in the personal statement, which may have been written for a different role):
${cvContent}

ADDITIONAL SKILLS & EXPERIENCE (beyond CV — each item is tagged with the employer(s) it relates to, or marked "general / not employer-specific"):
${skillsText}

SKILL ATTRIBUTION RULES (CRITICAL):
- A skill tagged [from: Employer X] describes work the candidate did AT Employer X. When you reference that achievement in the letter, it MUST appear in the paragraph about Employer X — never in a different employer's paragraph.
- A skill tagged [from: Employer X, Employer Y] applies to both — use it in whichever paragraph fits the letter's flow, but do not invent a new employer for it.
- A skill tagged [general / not employer-specific] is a transferable / innate skill. Use it where natural — usually woven into the most relevant paragraph as supporting evidence, never attributed to a specific employer.
- NEVER place a skill from one employer's paragraph into another employer's paragraph. This is the most common attribution error and the work history above exists to prevent it.

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

  const [profile, allCVs, skills, employers, writingExamples, taskPrefs, keys, clPrefs] = await Promise.all([
    getProfile(), getCVs(), getSkills(), getEmployers(), getWritingExamples(), getTaskPreferences(), getApiKeyValues(), getCoverLetterPrefs(),
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

  const systemPrompt = buildSystemPrompt({ profile, cvContent: cv.content, skills, employers, writingExamples, companyResearch, clPrefs });

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
