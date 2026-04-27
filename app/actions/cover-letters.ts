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

// ── Plan-then-write architecture types ───────────────────────────────────────

interface PlannedAchievement {
  source: "skill" | "cv" | "employer_summary";
  employer: string;
  description: string;
  jd_relevance: string;
  attribution: "solo" | "collaborative" | "supportive";
}

interface CoverLetterPlan {
  opening_strategy: "direct_relevance" | "honest_bridge" | "role_insight";
  narrative_anchor: {
    type: "specific_recent_achievement" | "specific_current_responsibility" | "specific_role_insight";
    draft_p1_first_sentence: string;
  };
  jd_integration_sentence: string;
  company_name: string;
  p2_theme: string;
  p2_achievements: PlannedAchievement[];
  p3_strategy: "second_employer" | "distinct_theme_same_employer";
  p3_achievements: PlannedAchievement[];
  hook: null | {
    type: "jd_named_function" | "jd_named_system" | "company_initiative" | "candidate_connection";
    integration_location: "p2" | "p3";
    description: string;
  };
  motivation_to_carry: string | null;
  degree_placement: "p1_after_anchor" | "p3_end" | "omit";
  closing_shape: string;
}

// Few-shot examples — fictional candidates, demonstrate VOICE / STRUCTURE.
// Both audited against the bar: no banned shapes, specific narrative anchors,
// JD-integration via candidate-centric subjects, honest attribution, clean
// closings. Used in the WRITE stage to teach voice — model is told NOT to
// copy specific achievements/numbers/roles into the candidate's letter.

const EXAMPLE_LETTER_DIRECT_RELEVANCE = `Dear Hiring Team,

For the past two years I've been doing financial analysis at a 60-person manufacturing business, building margin models, investigating cost variances, and translating raw operational data into decisions for the leadership team. Last quarter I redesigned our product profitability dashboard and surfaced a £180k gross margin gap on one of our core SKU lines that the team had been missing for six months.

A large part of my current role mirrors what the FP&A function handles: monthly variance analysis, scenario modelling for budget cycles, and partnering with operations on cost-reduction initiatives. I built and own the rolling 13-week cash flow forecast that the CFO uses for board reporting. I led a working capital project last year that shortened DSO by 11 days and freed up roughly £1.2m of cash. I also worked with operations and commercial to rebuild our reporting suite in PowerBI, with the cross-functional alignment work being as much of the project as the technical build.

Before my current role, I worked as a Junior Analyst at a Big 4 firm, supporting M&A due diligence on mid-market deals. I built financial models and quality-of-earnings reports under tight deadlines and presented findings directly to senior partners on multiple closes. I completed a first-class Mathematics degree at Bristol alongside that work.

I would welcome the opportunity to discuss how my experience aligns with this role in more detail.

Kind regards,
Sarah Chen`;

const EXAMPLE_LETTER_PIVOT = `Dear Hiring Team,

For the past three years I've been a Senior Designer at a healthcare startup, leading visual design across our product surface. The work I've found myself drawn into most is the brief stage. Last month I rewrote an inbound brief from a Series B client that was trying to redesign their patient onboarding flow, reframed the problem from "make it prettier" to "cut drop-off in steps 3 and 4", and turned that into a scope the client signed off in one revision instead of the usual three.

That consultative problem-reframing is the work I want to do as a primary function. At my current company I run weekly working sessions with our biggest clients to surface what's actually blocking them, translate that into product change requests, and project-manage internal delivery teams to ship resolutions. I rebuilt our customer feedback intake process with our head of customer success last year, which shortened time-to-resolution from 14 days to 4 on average. I've directly handled escalations from three of our top accounts, including one renewal that was at risk of churning.

Before this role, I worked as an Account Executive at a digital agency in London for two years, managing six concurrent retainer clients and £400k of annual revenue, focused on retention conversations and scoping new work. I completed a degree in Cognitive Science at UCL alongside earlier internships.

I would welcome the chance to discuss the role in more depth.

Kind regards,
Marcus Rivera`;

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

REQUIRED-ELEMENTS CHECK — DO THIS BEFORE THE PRIORITY SCAN. Sin of omission is as bad as sin of commission. A letter without these elements is generic and fails — rewrite to add them, do not return as-is.

[R1] COMPANY-NAMED-IN-BODY: scan the candidate's letter for the target company's name. To know what the target company is: FIRST check the JD for any explicit hiring-company name (look for "About [Company]", "Why [Company]", "Join [Company]", "[Company] is...", company-named header sections, branded phrases like "[Company] Digital" / "[Company] Group"). Most JDs name the hiring company multiple times. If the JD names a company, that's the target — even if the user left the company-name field blank. The target's name MUST appear at least once in the letter body. If it does NOT, the letter is generic — REWRITE the JD-integration sentence and/or P2/P3 to include the company name. EXCEPTION: if the JD genuinely contains no identifiable target company (very short test JDs, scrubbed listings), do not enforce this rule — instead enforce [R1B].

[R1B] CRITICAL: when no target company is known, the letter MUST NOT use the candidate's CURRENT employer's name as a substitute for the missing target company in the JD-integration sentence or closing. Banned construction: "the [function] at [Candidate's current employer] handles..." — this reads as the candidate describing their own role at their own company rather than as a role-fit statement for the new role. FIX: rewrite the JD-integration sentence using a generic target reference ("this role", "the role described", "this position") instead of the candidate's own employer name. The candidate's current employer can still appear as the place they currently work (P1: "As a [role] at [current employer], I..."), but it must NOT be referenced as the target company in any "mirrors what [target] handles" / "[target]'s focus on X" / closing reference.

[R2] JD-INTEGRATION SENTENCE PRESENT IN P2: P2 MUST open with a sentence that names a SPECIFIC function, team, process, or named-responsibility from the target job description, AND lists 3 concrete JD-aligned items the candidate does. Required pattern: "A large part of my current role mirrors what the [named function] at [Company] handles: [item], [item], and [item]." OR a candidate-as-subject variant. If P2 does NOT have this sentence, the letter is just a generic activity list — fail. FIX: rewrite P2's opening sentence using the required pattern. Identify the JD's most prominent named function/team/process (e.g. "the Release and Follow-Up function" for JLR, "the FP&A function" for finance roles, "the Customer Success role"). Pick 3 concrete responsibilities from the JD that the candidate has parallel work for.

[R3] CLOSING REFERENCES THE NAMED FUNCTION OR ROLE: closing should reference the specific named function from the JD (e.g. "the Release and Follow-Up function") or "this role" — never just a generic "this position" with no specificity. If the closing is bland and could be pasted onto any cover letter, rewrite it to reference the specific role/function.

PRIORITY SCAN — DO THESE NEXT, EVERY TIME, EVEN IF UNCERTAIN. These three patterns recurrently leak through the long checklist below. Read every sentence and flag any that matches:

[A] ROLE-AS-SUBJECT SHAPE (highest priority): any sentence whose grammatical subject names the role, the company, the company's focus, the company's commitment, the role's responsibilities, or "[X] at the centre of this role" / "[X] central to this role", AND whose predicate connects to the candidate's work. Match by SHAPE not by exact words. Example hits to learn from:
  - "The prospect engagement and pipeline management at the centre of this role map closely to work I do every day."
  - "OneAdvanced's focus on software that directly shapes how health practitioners run their organisations is exactly the kind of impact I want to work toward."
  - "Motia's focus on pricing optimisation maps closely to what I do."
  - "[Company]'s commitment to X aligns with my approach to Y."
  - "The work at [Company] reflects what I do day to day."
The subject of every sentence must be the candidate or the candidate's specific work, NEVER the role, the company, or the role's responsibilities. FIX: rewrite with the candidate's work as subject, OR delete the sentence if it adds no concrete information.

[B] EXPLICIT PARALLEL-DRAWING: any sentence that explicitly states the connection between the candidate's experience and the target role/JD activity. The reader must draw the parallel themselves; the letter must show the work and stop. Example hits to learn from:
  - "That is the same discipline as qualifying a prospect and tailoring a solution to their objectives."
  - "This work is the same as what a [role] does."
  - "[X] is essentially [JD activity]."
  - "What I do every day mirrors what [JD activity] requires."
  - "This translates directly to the work this role calls for."
FIX: delete the sentence entirely. The achievement before it should speak for itself.

[C] BOLTED-ON WHY-THIS-COMPANY PARAGRAPH: a paragraph (typically just before the closing) consisting of one or two sentences praising the company's focus / approach / commitment / impact. This violates the integration rule which requires hooks to be MID-PARAGRAPH within an existing paragraph, never their own. Example hits:
  - "OneAdvanced's focus on software that directly shapes how health practitioners run their organisations day to day is exactly the kind of tangible operational impact I want to work toward in this role."
  - "JLR's commitment to lean manufacturing is the kind of approach I want to be part of."
FIX: delete the whole paragraph. A clean 3-paragraph letter (P1 opening, P2 evidence, P3 second-employer/distinct theme, then closing) is stronger than 3 paragraphs + a bolted-on flattery paragraph. If a hook genuinely fits, integrate it as a single sentence inside an existing paragraph next to a related achievement. Otherwise drop entirely.

[D] ABSTRACT POSITIONING VERBS: any sentence that uses "sits at the core of" / "is at the core of" / "is at the heart of" / "centres on" / "has centred on" / "is the core of [my work]" / "underpins everything" / "runs through all of this" to talk about what some piece of work IS or where it FITS in the candidate's role. Example hits:
  - "Advanced Excel sits at the core of most of this analysis."
  - "Analytical thinking is at the heart of how I work."
  - "Stakeholder management runs through everything I do."
FIX: replace with a concrete sentence describing actual usage. "Advanced Excel sits at the core of most of this analysis" → "I use advanced Excel daily for [specific concrete activity]" or just delete the sentence if it adds nothing concrete.

[E] EMPHASIS-VIA-NEGATION: any sentence with the shape "[positive claim], not just [opposite]" / "[X], not [Y]" used for rhetorical contrast where the negation adds emphasis but no information. Example hits:
  - "I investigate root causes, not just the surface symptoms."
  - "This is a regular part of my role, not an occasional one."
  - "I'm focused on outcomes, not activity."
FIX: delete the "not Y" half. State the positive claim and stop. "I investigate root causes, not just the surface symptoms" → "I investigate root causes."

After running this priority scan, continue to the full checklist below for everything else.

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

8b. AWKWARD APPOSITIVE LISTS — sentences of the form "[Named function/team], particularly around [item], [item], and [item], [verb] [...]" are grammatically clumsy. "Particularly" introduces emphasis, not a multi-item list, so "particularly around X, Y, and Z" reads as malformed. Same for "specifically around [list]" / "notably around [list]" used as a parenthetical of three or more items. FIX: recast the sentence with a colon-list pattern: "[Named function/team] [verb] [...]: [item], [item], and [item]." Example rewrite: "The Release and Follow-Up function at JLR, particularly around on-time-in-full delivery, inventory accuracy, and supplier performance, maps closely to what I do" → "The Release and Follow-Up function at JLR maps closely to what I do day-to-day: on-time-in-full delivery, inventory accuracy, and supplier performance."

9. FILLER/GLUE TRANSITION SENTENCES AND PHRASES — STRICT ENFORCEMENT, NO EXCEPTIONS:
   Specific banned phrases (delete on sight, do not negotiate): "That's the day-to-day core of what I do", "That's the analytical side of it", "The analytical work has been the core of it", "In addition to the above", "On top of that". Topic-transition fillers that add zero information: "On the supplier side", "On the inventory side", "On the logistics side", "On the reporting side", "On the analytical side", "On the procurement side", "On the [X] side", "On the [X] side of things", "From a [X] standpoint", "From a [X] perspective". These are pure filler. FIX: delete the phrase. The sentence usually works fine without it (e.g. "On the supplier side, I built X..." → "I built X..."). If the deletion makes the sentence ungrammatical, also delete or rewrite the rest of the sentence.

10. ORPHAN/PADDING PARAGRAPHS — a single-sentence final paragraph (BEFORE the closing) that reads as a tacked-on summary stat list or skill recap (e.g. "My Excel skills are advanced, and I have hands-on experience with ERP systems, demand forecasting, and analytical investigation."). These are fillers, not paragraphs. FIX: either delete the orphan paragraph entirely, OR fold its content into P2 or P3 if there is a genuinely useful detail in it. Three substantive paragraphs is better than three substantive paragraphs plus a one-line orphan.

11. INCOHERENT MULTI-TOPIC PARAGRAPHS — a paragraph that switches subject mid-way without a coherent through-line. Example: P3 starts with Siemens activities, then jumps back to Grain and Frame ("Managing running-out... is something I handle at Grain and Frame regularly"), then jumps again to JLR ("The employee learning scheme is also a genuine draw..."). Three different employers/contexts in one paragraph = incoherent. FIX: identify the paragraph's primary topic (usually the first 1-2 sentences). REMOVE any sentences that pivot to a different employer or unrelated topic. Hooks belong in topic-matched paragraphs (e.g. an SSDS hook about procurement work belongs in the Grain and Frame paragraph, NOT in the Siemens paragraph). If a hook has been jammed into a paragraph that doesn't match its topic, either move it to a topic-matched paragraph or delete it. A coherent single-topic paragraph is always better than a multi-topic paragraph with a hook crammed in.

12. EMPLOYER-NAME ELISION — if the candidate's current employer is mentioned somewhere in the letter and then later referred to as "the business" / "the company" / "the role" without re-naming, that's fine. BUT: never write "I joined the business" / "I joined the company" without naming the employer if the employer hasn't been named yet in the surrounding context. FIX: if the employer needs to be referred to in a chronology stem ("After completing my degree, I joined [X]"), it must be NAMED ("Grain and Frame"), not "the business" / "the company".

13. OVERCLAIMING DEGREE FUNDING — banned phrasings: "I've self-funded my development through my degree", "I funded my own degree", "I paid my way through university". These imply a unique self-funding context most candidates don't actually have (a standard undergraduate degree with student loans is not "self-funded" in the meaningful sense). FIX: rewrite to focus on self-direction without claiming to have funded the degree, e.g. "I've taken responsibility for my own development through [specific things — courses, self-taught systems, etc.]" — or remove the self-funding angle and focus on the demonstrable self-development evidence.

14. JD-META-COMMENTARY / "ROLE-AS-SUBJECT" SENTENCES — UNIVERSAL SHAPE BAN: any sentence whose grammatical subject is the role, the company, or "the work at [Company]" — and which then lists JD items and claims they're what the candidate does — is banned regardless of the specific verb or prefix used. Match by SHAPE, not exact wording. Banned shape: "[the role / the company / the company's focus / the company's function / the X role at Y / the X work at Y / Y's commitment to / Y's approach to / the team at Y] [verb: calls for / requires / centres on / is built around / focuses on / maps to / aligns with / mirrors / reflects / sits at the heart of / demands / asks for] [list of JD items], [optional: 'all of which / which is what / and that's what / which maps to'] I [verb: do / handle / focus on / specialise in]." All such sentences narrate the JD back at its author with redundant role/company naming on top.
   Specific example hits (do not match these alone — match the SHAPE):
   - "The Supply Chain Analyst role at ZEISS calls for end-to-end reporting, inventory and order management, and cross-functional collaboration."
   - "The pricing work at Motia maps closely to what I do now: the stakeholder approval process, commercial analysis, and use of AI-driven tools."
   - "Motia's focus on pricing optimisation, commercial analysis, and AI-driven decision-making maps closely to what I do in my current role."
   - "JLR's commitment to lean manufacturing and continuous improvement aligns with my approach to..."
   - "The Release and Follow-Up team at JLR centres on material availability, inventory accuracy, and supplier performance, all of which sit at the core of my work."
   FIX: drop the meta-commentary entirely. Open the paragraph with the candidate's own concrete work, OR use ONE of these clean parallel-work patterns:
   - "At [current employer], I do exactly this work: [3 items from JD vocabulary]"
   - "A large part of my current role mirrors what [named JD function/team] handles: [3 items]"
   - "[Three concrete JD-relevant achievements at current employer] — [optional: explicit short link sentence like 'all directly relevant to the demands of this role.']"
   Never list JD requirements in a sentence whose subject is the role / role title / company / company's focus / company's commitment.

14b. CROSS-PARAGRAPH ATTRIBUTION CONSISTENCY — VERB-LEVEL CHECK: read the entire letter before finalising. For EVERY concrete activity statement (any sentence containing first-person action verbs: "I introduced", "I built", "I led", "I implemented", "I designed", "I delivered", "I drove", "I rolled out", "I launched", "I established", "I created", "I developed"), check the candidate's actual profile data. Specifically:
   (i) STRENGTH MATCH: if the source profile uses a weaker verb ("researched", "explored", "evaluated", "supported", "helped with", "contributed to", "was part of"), the letter MUST use the same or weaker verb. Never upgrade "researched AI use cases" → "introduced AI processes". Never upgrade "supported the launch" → "led the launch". Never upgrade "helped build" → "built". Never upgrade "evaluated tools" → "implemented tools".
   (ii) EMPLOYER MATCH: every action statement must attribute to the correct employer. If the source says the candidate did X at Employer A but did Y at Employer B (where X ≠ Y), the letter must not blur the two into a single claim or attribute Y's stronger work to Employer A's paragraph.
   (iii) DUPLICATE-CLAIM CHECK: if the same/similar activity (e.g. "AI work") is mentioned in two paragraphs about two different employers, verify each mention uses the actual verb from that employer's profile entry — not a synthesised stronger version. Scan for words like "AI", named systems, named projects across paragraphs and confirm consistency.
   FIX: rewrite the offending sentence to match the source verb and source employer. When in doubt about strength, use the WEAKER verb — understating is safer than overclaiming.
   Example: profile says "Carried out research into how departments could use AI to improve efficiency" at G&F, AND "Collaborated with my manager on AI-powered sales training" at Siemens. Banned synthesised claim in P2 (G&F paragraph): "I have actively introduced AI-powered processes". Correct: "I researched how different departments could use AI to improve efficiency" — same verb, same employer.

15b. ABSTRACT-UNDERSTANDING SELF-CLAIMS — banned shapes: "I have a strong working understanding of [abstract domain]", "I have a deep understanding of [abstract domain]", "I have a thorough grasp of [abstract domain]", "I bring a strong appreciation for [abstract X]", "I have a clear sense of where [X] adds value", "I bring real insight into [Y]". These are content-free claims about the candidate's understanding without any concrete evidence to back them. FIX: either delete the sentence, or replace with the SPECIFIC concrete work that demonstrates the understanding (e.g. instead of "I have a strong working understanding of where AI adds genuine commercial value", write "I researched specific use cases for AI across departments and proposed two implementations").

15c. JD-TERMINOLOGY RELABELLING — never relabel the candidate's actual work using the JD's domain-specific vocabulary if the candidate's profile doesn't establish work in that domain. Banned shapes: "[my work] generates [JD-domain]-relevant insights", "I produce [JD-domain]-relevant summaries", "I work with [JD-domain]-adjacent data", "my role involves [JD-domain] thinking", where [JD-domain] is a vocabulary item from the target role (e.g. "pricing", "marketing", "compliance", "growth", "customer success"). Example hit: candidate's profile shows they produce supplier-cost and inventory reports for the director — the LETTER must NOT relabel this as "pricing-relevant insights" or "pricing-adjacent reports" just because the target role is a Pricing Analyst position. The candidate's actual work is supplier-cost and inventory analysis. Describe it accurately. The hiring manager will draw the parallel themselves; relabelling reads as inflation. FIX: rewrite using the candidate's ACTUAL profile/CV vocabulary, not the JD's. If the actual work is "supplier-cost reports", say "supplier-cost reports" — not "pricing-relevant insights".

15d. EMBEDDED DEGREE INTEGRATION — when the candidate's degree is being integrated at the end of the internship/student-period paragraph, it MUST appear as a standalone clean sentence at the END of the paragraph, NOT embedded mid-sentence within a claim about other activities. Banned shape: "I also did X and contributed to Y, alongside completing a first-class [degree] at [University]" — degree tucked inside a sentence about other work reads as an afterthought. Required shape (preferred): "[Final concrete sentence about the role]. I completed this placement alongside a first-class [degree] at [University]." OR: "[Final concrete sentence about the role]. This was alongside a first-class [degree] at [University]." OR: "[Final concrete sentence]. I also completed a first-class [degree] at [University] during this period." The degree mention is a separate sentence — never a trailing clause inside a multi-claim sentence.

15e. NAMED-PRODUCT INACCURACY — when the candidate's profile names a specific product/system/initiative, the letter must preserve the SPECIFIC IDENTIFIER, not strip it down to a generic stem. Banned operations: dropping the qualifier ("AI-powered sales training" → "AI-powered tools" — DROPPED "sales training"), genericising the noun ("supplier performance tracker" → "performance management system"), or keeping only one half of a compound name ("AI-powered sales training" → "AI tools"). The most common failure: model preserves the adjective ("AI-powered") but drops the specific noun ("sales training"). This is still a regression — the specific noun is what gives the achievement its concrete meaning. FIX: use the EXACT named identifier from the profile, including any qualifier (sales training, customer feedback, supplier performance, etc.). If the profile says "AI-powered sales training", the letter must say either "AI-powered sales training" or a near-synonym that preserves "sales training" (e.g. "AI sales training tools"). NEVER "AI-powered tools" / "AI tools" / "AI-powered delivery tools" / similar dropped-qualifier versions.

15f. CURRENT-EMPLOYER NAME REPETITION — if the candidate's current employer is named at the start of P1 (e.g. "As a Supply Chain Analyst at Grain and Frame, I..."), the letter must NOT then re-establish that employer's name at the start of P2 (e.g. "At Grain and Frame, I build and maintain..."). Re-establishing context that was just established reads as filler and adds no information. Acceptable patterns for opening P2: a direct verb-first sentence ("I build and maintain Excel-based reporting..."), a JD-integration sentence ("A large part of my current role mirrors what this position handles: ..."), or a contextual phrase that adds NEW information ("Day-to-day, I build and maintain..."). FIX: drop the redundant "At [current employer]" prefix from the start of P2 if the employer was named in P1's opening sentence. The reader does not need the employer name twice in two sentences.

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

CLOSING — one sentence, 6-22 words, matching the body's tone. Reference "this role" / "the role" / "the [named function] role" — NEVER "the [Job Title] role at [Company]" (redundant; they know who they are). ALSO BANNED: "this role at [Company]" — combining "this role" with "at [Company]" reads as verbose / AI-thoroughness. Pick ONE specifier: either "this role" alone, OR "the [named function] role" alone, OR "the [named function] role at [Company]" if the named function alone is ambiguous. Never stack "this role" + "at [Company]". For professional/balanced tone (the default), use one of these shapes (do NOT copy verbatim — generate a novel sentence in the shape):
  F1: "I would welcome the opportunity to discuss how my skills and experience align with this role in further detail."
  F2: "I would welcome the chance to discuss this role and how my background fits in more depth."
  F3: "I would be glad to discuss how I could contribute to the team further."
  F4: "I would value the opportunity to discuss this role and the work involved in more detail."
For conversational tone only, drop a register: "Happy to dig into any of this on a call.", "Let me know if you'd like to talk it through."

POSITIVE FIT REQUIREMENTS:

(1) IDENTIFY THE TARGET COMPANY FIRST. Before writing anything, identify the target company. Look in this order:
  (a) The "Company Name" field provided by the user (if present, this is authoritative).
  (b) The JD content. MOST JDs name the hiring company explicitly — in the header, "About Us" / "About the role" sections, role descriptions, or benefits sections. Common patterns: "Join [Company]", "[Company] is an X company", "We are [Company]", "About [Company]". Read the WHOLE JD and extract any clearly-named hiring company. Examples that should be extracted: "DVSA" in a JD with "About DVSA" / "Why DVSA?" / "DVSA Digital designs..."; "Vistry" in a JD with "Vistry Homes" / "We are Vistry"; "SharkNinja" in a JD with "About SharkNinja" / "SharkNinja's products". If the JD names a hiring company, that's the target.
  (c) Only if BOTH (a) and (b) fail to identify a target — which is rare — treat the target as unknown.

COMPANY-NAMED-IN-BODY — REQUIRED WHEN TARGET IDENTIFIED. Once identified (steps a or b above), the target company name MUST appear at least once in the letter body (anywhere except sentence 1 of P1). Natural placements: inside the JD-integration sentence ("the [function] at [Company] handles..."), as a mid-sentence reference in P2 or P3, or in the closing.

CRITICAL EXCEPTIONS:
- If both the field AND the JD genuinely fail to identify a target (rare — happens with very short test JDs or scrubbed listings), use generic "this role" / "the role described" in the integration sentence and closing. Do NOT invent a target company. Do NOT default to the candidate's CURRENT employer name as a substitute. The candidate's current employer is where they currently work, not where they're applying — substituting it creates nonsense.
- The candidate's current employer can still appear in P1 as context ("As a [role] at [current employer], I..."), but never as the target in any "mirrors what [target] handles" / "[target]'s focus on X" / closing reference.

(2) JD-RELEVANCE VISIBLE IN P2 — REQUIRED, but multiple shapes work. Either:
  (a) An explicit JD-integration sentence opening P2 (when target company is known): "A large part of my current role mirrors what the [named JD function/team] at [Company] handles: [3 items]." When target company is NOT known, use the generic version: "A large part of my current role mirrors what this role describes: [3 items]" or "Much of what I do day-to-day aligns with this role's focus on: [3 items]" — never substitute the candidate's own employer for the missing target company.
  (b) Implicit JD-relevance: P2 leads with achievements that obviously parallel the JD's named responsibilities, with the JD's vocabulary woven through (e.g. JD says "investigate stock discrepancies", letter says "When stock or shipment discrepancies arise, I investigate root causes..."). The connection is clear without an explicit "mirrors X" statement.
  Use whichever fits the letter's natural flow. Forced explicit integration when implicit reads better is bad. Implicit integration when explicit would land the JD-fit cleanly is also weaker. Judgment call.

(3) JD-VOCABULARY THROUGHOUT — at least three JD-specific phrases or responsibilities woven into P2 or P3 naturally. Use the JD's own vocabulary where the candidate has matching work. Not keyword-stuffing — genuine parallels.

(4) STRONG OPENING — CONCRETE, NOT VAGUE. P1 sentence 1 must be concrete and specific. TWO valid opening patterns; pick whichever fits the candidate's strongest material:
  (a) ROLE-CONTEXT: "As a [role title] at [employer], I [3-4 specific concrete activities]." Sets up who the candidate is and what they do, in concrete terms. Works well when the activities listed have natural JD relevance, and when the candidate's strength is breadth across responsibilities (rather than one standout achievement). This is a perfectly valid strong opener — generic role-context with concrete activities reads as a real human summary, NOT as a boilerplate template.
  (b) SPECIFIC ACHIEVEMENT: "Last year I [specific recent named project/decision] at [employer]" or "I built / led / developed [specific named thing] at [employer]." Leads with a single specific moment. Works well when one achievement is dramatically the strongest JD match and the rest of the letter can build from it.
  Both are valid. Forcing either pattern when the other fits better is wrong.
  BANNED openers (regardless of pattern): "I am writing to apply for...", gerund stems ("Building...", "Designing...", "Leveraging..."), self-promoting trait lists ("As a passionate / dynamic / results-driven [role]..."), evasive employer descriptors ("at a fast-paced product business", "at a growing startup"), industry truisms.

(5) USE NUMBERS WHEN PRESENT IN PROFILE. If the candidate's profile, skills, or CV contains specific numbers (percentages, monetary values, time savings, count of suppliers/customers/projects, scale measurements), include them in the letter where they fit. Numbers are differentiators when they exist. Never invent numbers — only use what's explicitly in the candidate's data.

(6) OPTIONAL HOOK: if the JD names a specific scheme/system/function AND the candidate has parallel evidence in their profile, you MAY weave one 1-2 sentence integration into a topic-matched paragraph. MAX ONE such hook per letter, never bolt on a separate paragraph. Skip if no natural fit.

JD-RELEVANCE RANKING — CRITICAL FOR ACHIEVEMENT SELECTION:
Before drafting P2, read the JD and identify its TOP 3-5 specific requirements, methodologies, or named criteria — especially ones listed as "essential", "key responsibilities", or "desirable" (e.g. "lean principles", "process improvement methodologies", "demand forecasting", "supplier performance tracking", "data analysis tools", a specific named system). Then rank the candidate's available skills/achievements by direct match to those requirements. P2 MUST lead with the candidate's STRONGEST 2-3 matches — not whichever achievements seem generally impressive. Specifically:
- If the JD names a methodology (e.g. "lean principles", "Six Sigma", "process improvement") and the candidate has a parallel concrete achievement (e.g. led a courier migration after data analysis, redesigned a process), that achievement MUST appear in P2. Never deprioritise it for a generic inventory-management or stakeholder sentence.
- If the JD lists named tools / data-analysis software (e.g. Excel, Power BI, SQL) and the candidate's profile names matching tools, mention them by name in P2 or P3 — but only ones the candidate actually has. Never claim tools the profile doesn't list.
- If two achievements compete for space in P2 and one is a stronger JD match, the stronger match wins. Drop the weaker one (it can go in P3, or be omitted) — do not cram both in.
- This ranking applies to BOTH explicit Skills entries AND CV content. The candidate's strongest JD-aligned achievement may live in either source.

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

// Format helpers used by both single-pass and plan-then-write paths.
function formatWorkHistoryForContext(employers: Awaited<ReturnType<typeof getEmployers>>): string {
  return employers.length > 0
    ? employers.map((e) => {
        const dates = e.is_current ? `${e.start_date} → present` : `${e.start_date} → ${e.end_date ?? "?"}`;
        const summary = e.summary ? ` — ${e.summary}` : "";
        return `- ${e.role_title} at ${e.company_name} (${dates})${summary}`;
      }).join("\n")
    : "None provided.";
}

function formatSkillsForContext(
  skills: Awaited<ReturnType<typeof getSkills>>,
  employers: Awaited<ReturnType<typeof getEmployers>>,
): string {
  if (skills.length === 0) return "None provided.";
  const lookup = new Map(employers.map((e) => [e.id, e]));
  return skills.map((s) => {
    const tags = (s.employer_ids ?? [])
      .map((id) => lookup.get(id)?.company_name)
      .filter(Boolean);
    const attribution = tags.length > 0 ? ` [from: ${tags.join(", ")}]` : " [general / not employer-specific]";
    return `- ${s.polished_text || s.raw_text}${attribution}`;
  }).join("\n");
}

// Stage 1 — PLAN: produces a structured JSON plan of strategic choices.
// Returns null if the AI returns malformed JSON, in which case the caller
// falls back to the single-pass path.
async function planCoverLetter(input: {
  profile: Awaited<ReturnType<typeof getProfile>>;
  cvContent: string;
  skills: Awaited<ReturnType<typeof getSkills>>;
  employers: Awaited<ReturnType<typeof getEmployers>>;
  jobDescription: string;
  pivotContext?: string;
  anythingToAdd?: string;
  companyResearch?: string;
  taskPrefs: Awaited<ReturnType<typeof getTaskPreferences>>;
  keys: Awaited<ReturnType<typeof getApiKeyValues>>;
}): Promise<CoverLetterPlan | null> {
  const tone = input.profile.tone ?? "balanced";

  const systemPrompt = `You are planning a cover letter. Output ONLY valid JSON matching the schema below — no prose, no preamble, no commentary, no markdown fences.

You make the strategic decisions: which achievements to feature, what the opening anchor is, how P2 and P3 are themed, which closing shape to use. The next stage writes the prose; you must give that stage everything it needs to write a strong specific letter.

SCHEMA (output exactly this shape):
{
  "opening_strategy": "direct_relevance" | "honest_bridge" | "role_insight",
  "narrative_anchor": {
    "type": "specific_recent_achievement" | "specific_current_responsibility" | "specific_role_insight",
    "draft_p1_first_sentence": "the actual first sentence — must include a SPECIFIC anchor (a number, a named project, a named recent decision, a concrete activity). Generic role description is banned."
  },
  "jd_integration_sentence": "the sentence in P2 that explicitly names a SPECIFIC JD function/team/process/named-responsibility (e.g. 'the Release and Follow-Up function at JLR', 'FP&A at Acme', 'the Customer Success role') and lists EXACTLY 3 concrete JD-named responsibilities the candidate has parallel work for. HARD CAPS: total sentence ≤ 35 words; exactly 3 list items (NOT 4); each item ≤ 8 words. The required pattern shape is: 'A large part of my current role mirrors what [the named JD function/team] [at Company] handles: [item], [item], and [item].' Pick the THREE strongest JD-named responsibilities — never include a fourth. The subject MUST be the candidate or the candidate's role — NEVER 'the role focuses on X' or '[Company]'s focus on Y'. Mandatory for direct_relevance letters; for honest_bridge letters it's the parallel-work establishing sentence at P2 opening.",
  "company_name": "the target company's name as it should appear in the letter body (must appear at least once in the JD-integration sentence or P2/P3, NEVER in P1 sentence one)",
  "p2_theme": "one short phrase naming what P2 will cover",
  "p2_achievements": [
    { "source": "skill" | "cv" | "employer_summary", "employer": "Company Name", "description": "the concrete achievement in one sentence", "jd_relevance": "why this matches the JD specifically", "attribution": "solo" | "collaborative" | "supportive" }
  ],
  "p3_strategy": "second_employer" | "distinct_theme_same_employer",
  "p3_achievements": [ ...same shape as p2_achievements... ],
  "hook": null OR { "type": "jd_named_function" | "jd_named_system" | "company_initiative" | "candidate_connection", "integration_location": "p2" | "p3", "description": "what hook to weave in (one sentence max)" },
  "motivation_to_carry": null (when no pivot) OR "the candidate's motivation/desire as a short phrase the writer should communicate through the letter, but never quote verbatim",
  "degree_placement": "p1_after_anchor" | "p3_end" | "omit",
  "closing_shape": "F1" | "F2" | "F3" | "F4" | "W1" | "W2" | "W3" | "W4" | "C1" | "C2" | "C3" | "C4"
}

KEY DECISION RULES:

OPENING STRATEGY:
- direct_relevance: candidate's current role is a clean direct match for the target. Default for well-suited roles.
- honest_bridge: candidate is pivoting to a different role/sector. Use whenever pivot context is provided.
- role_insight: rare. Only when the candidate has a specific genuine insight about what this role demands.

NARRATIVE ANCHOR (most important choice — read carefully):
The draft_p1_first_sentence is the actual first sentence of the cover letter. Write it well.

LENGTH CAP: the draft_p1_first_sentence MUST be 35 words or fewer. Do NOT cram multiple achievements + ongoing duties into one sentence. ONE specific moment/achievement OR one focused current-responsibility statement. If you find yourself joining clauses with "while simultaneously" or "alongside that" inside the anchor sentence — split them. The anchor is ONE thing, said well.

DEDUPLICATION RULE: if the narrative anchor describes a specific named project/system/migration (e.g. supplier performance tracker, courier migration, ERP build), that SAME achievement MUST NOT appear in p2_achievements. Pick a DIFFERENT achievement for the P2 lead. Example: if anchor = supplier tracking system, P2 achievements should NOT include the supplier tracking system again. Pick from the candidate's other achievements (ERP, courier migration, stock-discrepancy work, etc).

BAD anchors (banned — generic role description): "As a Supply Chain Analyst at X, I work daily with sales and demand data..."
GOOD anchors (specific moment/decision/number drawn from candidate's profile).

ANCHOR SELECTION RULE — CRITICAL:
The anchor must be the candidate's achievement that DIRECTLY MATCHES THE JD'S TOP REQUIREMENT, not the candidate's most impressive achievement overall. These are often different. Steps:
1. Read the JD and identify its TOP 2-3 specific requirements / named methodologies / named responsibilities.
2. From the candidate's profile, find which achievement MOST DIRECTLY demonstrates work in that area.
3. That achievement is the anchor — even if it's not the candidate's flashiest accomplishment.

Example: for a JLR Supply Chain Analyst role where the JD names Release and Follow-Up function (on-time delivery, inventory accuracy, supplier performance), the strongest anchor is the candidate's stock-discrepancy / supplier-performance / courier-migration work — NOT a separate ERP-build project that's impressive but doesn't match the JD's headline duties.
Example: for a Customer Success role focusing on enterprise account retention, the strongest anchor is a specific customer escalation / renewal recovery story — NOT a tools-building project the candidate is proud of.

For pivots: the anchor MUST be a moment that demonstrates the work pattern named in the candidate's motivation. Pick the achievement most aligned with the SLICE of work the candidate enjoys, AND that maps to the target role.

GOOD anchor examples (note the pattern: specific moment + concrete outcome + number where possible):
- "Last quarter I migrated my company to a new courier partner: ran the data analysis, built the business case, executed the switch, and cut our delivery spend roughly 12 percent."
- "Six months ago I rebuilt the supplier performance tracking system at my company, replacing a manual spreadsheet process with an automated tool that has since recovered three refund claims worth around £4k each."
- "For the past year I've been the sole supply chain analyst at a growing product business, managing procurement across multiple overseas suppliers and resolving the kind of stock discrepancies and shipment issues that would otherwise stall production."

JD-RELEVANCE RANKING:
Read the JD's top 3-5 specific requirements / named methodologies / key responsibilities. Rank the candidate's achievements by direct match. P2 must lead with the strongest 2-3 matches. For pivots, prioritise achievements that demonstrate the WORK PATTERN the candidate wants to do more of.

ACHIEVEMENT DIVERSITY RULE — CRITICAL FOR P2:
When the JD spans MULTIPLE distinct categories of work (e.g. "stock accuracy" + "supplier performance" + "process improvement" + "reporting"), P2 must include at least one achievement from EACH major category if the candidate has matching evidence. Do NOT cluster all P2 achievements in one category and skip the others. Specifically:
- If the candidate has a process-improvement / migration / transformation story (e.g. switching vendors, redesigning a process, building a new system from a manual one) AND the JD lists process improvement / lean principles / continuous improvement / cost reduction as criteria — that achievement MUST appear in P2.
- If the JD has a "drive supplier performance" or similar relationship-management responsibility AND the candidate has a supplier-coordination achievement — include it.
- Never let one strong achievement category crowd out another that the JD explicitly lists.

Worked example: for a JLR Supply Chain Analyst role where the JD lists (a) inventory accuracy, (b) supplier performance, (c) process improvement, (d) data systems integrity — P2 should include the candidate's stock-discrepancy work (a), supplier-performance tracker (b), courier-migration story (c), AND the ERP collaboration (d). All four are JD-relevant categories. Don't pick three of (a)+(b)+(d) and skip (c).

ATTRIBUTION HONESTY:
- "solo": candidate clearly led/built/executed alone — profile says so explicitly
- "collaborative": candidate worked with a named other person (manager, director, team)
- "supportive": candidate supported a project led by others
The writer respects this attribution exactly. Never inflate.

P3 STRATEGY:
- second_employer: preferred default if candidate has a second employer (internship/previous role) with relevant achievements
- distinct_theme_same_employer: only if second employer has minimal relevant material

HOOK:
- Include only if there's a specific hookable item in the JD (named function, named system, named scheme) AND the candidate has matching evidence in their profile.
- Skip (null) if no natural fit. Better no hook than a forced one.

MOTIVATION_TO_CARRY:
- For pivots: distill the candidate's motivation from pivot context into a short framing phrase. The writer will weave the SPIRIT of this into the letter without copying words.
- For non-pivots: null.

DEGREE PLACEMENT:
- p3_end: preferred default for early-career candidates (under ~3 years post-graduation) with notable degrees. Cleanest chronology.
- p1_after_anchor: rarely. Only if it strengthens the opening without making P1 awkward.
- omit: mid/senior candidates (3+ years experience).

CLOSING SHAPE — pick one:
- F1: "I would welcome the opportunity to discuss how my skills and experience align with this role in further detail." (default for professional/balanced tone)
- F2: "I would welcome the chance to discuss this role and how my background fits in more depth."
- F3: "I would be glad to discuss how I could contribute to the [named function or 'team'] further."
- F4: "I would value the opportunity to discuss this role and the work involved in more detail."
- W1: "I'd welcome the chance to take this further."
- W2: "Looking forward to discussing the role with the team."
- W3: "Glad to discuss the [named function/team] role further whenever convenient."
- W4: "Available for a call at any time that works for you."
- C1-C4: ONLY for explicitly conversational tone or genuinely informal employer (startup, creative agency)

Tone setting for this candidate: "${tone}". For "formal" or "balanced" tone, default to F1-F4. For "conversational", consider C1-C4.

CRITICAL CONSTRAINTS:
- Never invent achievements not in the profile / CV.
- Never invent abstract qualities the candidate hasn't claimed.
- Use the exact employer names from work history.
- For "collaborative" achievements, the description must name the collaborator (e.g. "with the company director").

OUTPUT: only the JSON object. No preamble, no markdown fences.`;

  const userPrompt = `JOB DESCRIPTION:
${input.jobDescription}

CANDIDATE WORK HISTORY:
${formatWorkHistoryForContext(input.employers)}

CANDIDATE SKILLS / ACHIEVEMENTS:
${formatSkillsForContext(input.skills, input.employers)}

CANDIDATE CV:
${input.cvContent.slice(0, 4000)}

${input.pivotContext?.trim() ? `PIVOT MOTIVATION:\n${input.pivotContext}\n` : ""}
${input.anythingToAdd?.trim() ? `CANDIDATE NOTES:\n${input.anythingToAdd}\n` : ""}
${input.companyResearch?.trim() ? `COMPANY RESEARCH:\n${input.companyResearch}\n` : ""}

Output the JSON plan now.`;

  try {
    const result = await callAI({
      task: "cover-letter",
      systemPrompt,
      prompt: userPrompt,
      userPreference: input.taskPrefs["cover-letter"],
      connectedProviders: input.keys,
    });

    const text = result.text.trim();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error("[planCoverLetter] no JSON object found in output");
      return null;
    }

    const plan = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as CoverLetterPlan;

    // Sanity check — required fields present
    if (!plan.opening_strategy || !plan.narrative_anchor?.draft_p1_first_sentence || !Array.isArray(plan.p2_achievements) || !plan.closing_shape) {
      console.error("[planCoverLetter] plan missing required fields:", plan);
      return null;
    }

    return plan;
  } catch (e) {
    console.error("[planCoverLetter] failed:", e);
    return null;
  }
}

// Stage 2 — WRITE: produces prose using the plan + few-shot examples.
function buildWriteSystemPrompt({
  plan,
  profile,
  cvContent,
  skills,
  employers,
  pivotContext,
  anythingToAdd,
  companyResearch,
  clPrefs,
  writingExamples,
}: {
  plan: CoverLetterPlan;
  profile: Awaited<ReturnType<typeof getProfile>>;
  cvContent: string;
  skills: Awaited<ReturnType<typeof getSkills>>;
  employers: Awaited<ReturnType<typeof getEmployers>>;
  pivotContext?: string;
  anythingToAdd?: string;
  companyResearch: string;
  clPrefs: CoverLetterPrefs;
  writingExamples: Awaited<ReturnType<typeof getWritingExamples>>;
}): string {
  const tone = profile.tone ?? "balanced";
  const toneGuide =
    tone === "formal" ? "Write in a formal, structured, professional tone." :
    tone === "conversational" ? "Write in a warm, direct, conversational tone — confident but human." :
    "Write in a clear, confident, professional-but-human tone.";

  const salutation = clPrefs.salutation || "Dear Hiring Manager";
  const usePivotExample = !!pivotContext?.trim() || plan.opening_strategy === "honest_bridge";

  const example = usePivotExample ? EXAMPLE_LETTER_PIVOT : EXAMPLE_LETTER_DIRECT_RELEVANCE;
  const exampleLabel = usePivotExample ? "EXAMPLE — career pivot scenario" : "EXAMPLE — direct-relevance scenario";

  const userWritingStyle = writingExamples.length > 0
    ? `\nCANDIDATE'S OWN WRITING STYLE (study for natural voice; do NOT copy banned patterns even if they appear here):\n${writingExamples.map((e, i) => `Sample ${i + 1}:\n${e.content.slice(0, 500)}`).join("\n\n")}\n`
    : "";

  const alwaysMentionSection = clPrefs.always_mention?.trim()
    ? `\nALWAYS INCLUDE: ${clPrefs.always_mention}`
    : "";

  const neverDoSection = clPrefs.never_do?.trim()
    ? `\nNEVER INCLUDE: ${clPrefs.never_do}`
    : "";

  const extraToneSection = clPrefs.extra_tone_notes?.trim()
    ? `\nADDITIONAL TONE NOTES: ${clPrefs.extra_tone_notes}`
    : "";

  return `You write the prose of a cover letter, executing a plan that has already made the strategic choices. Match the voice of the example below.

${exampleLabel} (the candidate is FICTIONAL — match the VOICE/STRUCTURE/SPECIFICITY, never copy specific numbers, projects, employers, or content from the example):

${example}

NO-COPY RULE — STRICT: do NOT copy any specific words, phrases, status descriptors, or framings from the example beyond the structural pattern. This includes:
- Status descriptors ("sole", "lead", "senior", "junior") — only use what's in the candidate's profile
- Sector descriptors ("60-person manufacturing business", "healthcare startup", "Series B client") — only use what's in the candidate's profile
- Specific numbers (£180k, 11 days, 14 to 4) — never invent numbers; only use ones from the candidate's profile/CV
- Specific projects ("product profitability dashboard", "13-week cash flow forecast", "patient onboarding flow")
- Anchor sentence wording — match the SHAPE (specific recent moment + concrete outcome) but write the candidate's own anchor in the candidate's own factual language
The candidate's letter must use the candidate's actual employer name, role title, achievements, and numbers — drawn ONLY from the plan, profile, and CV provided below.

NOW WRITE THE ACTUAL CANDIDATE'S COVER LETTER.

PLAN (follow exactly):
${JSON.stringify(plan, null, 2)}

CANDIDATE PROFILE (for fact verification — only use facts present here, never invent):
- Name: ${profile.full_name ?? ""}
- Sign-off: ${profile.sign_off ?? "Kind regards"}
- Tone: ${tone}

WORK HISTORY:
${formatWorkHistoryForContext(employers)}

SKILLS / ACHIEVEMENTS (each tagged to its employer):
${formatSkillsForContext(skills, employers)}

CV (additional context):
${cvContent.slice(0, 4000)}

${pivotContext?.trim() ? `PIVOT MOTIVATION (use as framing signal — DO NOT copy phrases verbatim into the letter):\n${pivotContext}\n` : ""}
${anythingToAdd?.trim() ? `CANDIDATE NOTES (high-priority context):\n${anythingToAdd}\n` : ""}
${companyResearch ? `COMPANY RESEARCH:\n${companyResearch}\n` : ""}
${userWritingStyle}${alwaysMentionSection}${neverDoSection}${extraToneSection}

WRITING RULES:
- ${toneGuide}
- 250-380 words, exactly 3 (or rarely 4) paragraphs plus a one-sentence closing on its own line.
- P1 starts with the plan's draft_p1_first_sentence (you may polish it but keep the specific anchor and concrete content).
- P2 leads with a JD-integration sentence whose subject is the candidate or the candidate's role — never the role/company/their focus.
- Every concrete activity statement must match the attribution in the plan: "collaborative" achievements name the collaborator ("with the company director"), "solo" claims only when the plan says so.
- Use specific numbers/dates/names from the plan and profile; never invent.
- Closing line uses the plan's closing_shape with the named role / function substituted in (do NOT name the role title + company together — say "this role" or "the [named function]").
- Sign off: "${profile.sign_off ?? "Kind regards"}," on its own line, then "${profile.full_name ?? ""}" on the next line.

HARD BANS (these are non-negotiable, regardless of what the example contains):
1. Em-dashes (—) and double hyphens (--) banned anywhere. Use commas, semicolons, or new sentences.
2. First-person throughout. Never refer to candidate by name in the letter body.
3. Subject of every sentence must be the candidate or the candidate's specific concrete work. NEVER the JD items, the role's responsibilities, "the company's focus", "[Company]'s commitment", or "the work at [Company]". If you find yourself writing "[Company]'s focus on X is Y" or "[JD items] map to what I do" or "[role] centres on X" — STOP and rewrite with the candidate as subject.
4. Never explicitly draw parallels: "X is the same as Y", "this is the same discipline as Y", "X mirrors / maps to / aligns with / runs on the same fundamentals as Y", "this is what a [role] does". Show the work; the reader draws the parallel. EXCEPTION: the plan's jd_integration_sentence uses the validated "A large part of my current role mirrors what [function] handles: [3 items]" pattern, which IS allowed because its subject is the candidate's role not the JD; use that sentence as written or near-as.
5. Never write self-characterising summary sentences: "[work] required me to [abstract qualities]", "[X] gave me a grounding in Y", "[X] is embedded in how I work", "[X] shaped how I approach Y", "I have a [strong/deep/detailed] understanding of [Y]", "having [X], I have a [Y] understanding of [Z]". State concrete facts, never abstract self-claims about understanding/grounding/grasp.
6. Never use abstract positioning verbs that talk ABOUT the candidate's work in summary: "[X] sits at the centre of [Y]", "[X] is the core of [Y]", "[X] is at the heart of [Y]", "[X] centres on [Y]", "[X] has centred on [Y]", "[my work] sits at the intersection of [A] and [B]". Describe the work directly — never position it abstractly.
7. Never inflate audience: "the director" stays "the director", not "senior stakeholders" or "senior leadership" or "internal decision-makers" (the last is a slight inflation when source says "the director and team"). Use the actual audience named in the profile.
8. Never use the fast-learner pivot ("foundations are there", "natural next step", "quick study").
9. Never bolt on a separate why-this-company paragraph. If a hook is in the plan, integrate it as a 1-2 sentence reference inside an existing paragraph.
10. The plan's company_name MUST appear at least once in the letter body (not in P1 sentence one) — typically inside the jd_integration_sentence or near a P2/P3 reference. Never let the company go unnamed.
11. NAMED-PRODUCT ACCURACY: when the candidate's profile names a specific product/system/initiative (e.g. "AI-powered sales training", "Airtable-based ERP system", "automated supplier performance tracking system"), use that EXACT name. Do NOT genericize: "AI-powered sales training" must NOT become "AI-powered tools" or "AI tools". "Airtable-based ERP" must NOT become "the ERP system" without the Airtable specificity. The named product is part of the candidate's evidence — generic versions are weaker.
12. NO ACHIEVEMENT DUPLICATION: if a specific achievement (a named system, a specific project, a specific migration) is mentioned in the narrative anchor (P1), it MUST NOT be re-described as a separate sentence in P2. Each concrete achievement appears in the letter at most once. Do not write filler bridge sentences like "The supplier tracking system I built creates a structured, data-driven record..." after already mentioning it in P1.
13. ${clPrefs.include_header ? `Do NOT add contact details (phone, email, LinkedIn) after the name.` : `Do NOT add a contact details header at the top.`}

OUTPUT: Start with "${salutation}," on its own line, then a blank line, then P1. End with the sign-off and name on separate lines. No preamble, no commentary, no markdown.`;
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

  // ARCHITECTURE NOTE: the plan-then-write architecture was attempted (commits
  // 6852be0 to 53fafe8) but introduced too much variance — gains in some
  // letters, regressions in others (mega-sentences, P1 banned shapes, achievement
  // duplication). For SaaS shipping we need consistent quality over potential
  // peaks. Reverted to single-pass. The plan/write helpers are retained as dead
  // code in case we revisit with a more constrained architecture.

  const systemPrompt = buildSystemPrompt({ profile, cvContent: cv.content, skills, employers, writingExamples, companyResearch, clPrefs });

  const userPrompt = `Write a cover letter for this role:

JOB DESCRIPTION:
${input.jobDescription}

${input.pivotContext?.trim() ? `CAREER PIVOT — the candidate is flagged as deliberately moving into a different role type. The text below is their MOTIVATION/INTENT for the move — NOT a list of achievements to copy into the letter. Use it as a FRAMING SIGNAL: it tells you (a) which target role/function to write toward, (b) which slice of the candidate's current work is most relevant for this pivot. The letter should: use the Honest Bridge opening (show parallel work without naming the gap or apologising), prioritise achievements from the candidate's profile that match the slice of work named in the motivation, and treat this pivot context as guidance — not as content. DO NOT copy phrases from this motivation into the letter. DO NOT say "I am moving from X to Y" or "transitioning from X to Y". If the motivation is vague ("I want a change"), ignore it entirely and silently. Override the CV personal statement's stated career direction with this framing.\n\nMOTIVATION:\n${input.pivotContext}` : ""}
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
    systemPrompt: "You are an expert cover letter editor. Apply the requested changes and return the complete updated letter. Preserve the overall structure and quality. " +
      "PRESERVE REQUIRED ELEMENTS even when fulfilling shortening/editing requests: " +
      "(a) The target company's name MUST remain in the letter body (not just the closing). " +
      "(b) The closing must continue to reference 'this role' or the named function/team — never strip role-specificity to make the closing shorter. " +
      "(c) If the original letter has a JD-integration sentence at the start of P2 (e.g. 'A large part of my current role mirrors what the X function handles: [items]'), preserve it unless the user explicitly asks to remove it. " +
      "HARD FORMATTING RULES: (1) The em-dash character (—) must not appear anywhere in your output — not once. Use a comma, colon, or new sentence instead. This is non-negotiable. (2) No double hyphens (--). (3) No editorializing or commentary. (4) Banned phrases: team player, passionate about, proven track record, excited to apply, I look forward to hearing from you, from day one, sits at the core of, is at the heart of, is at the core of, [X] not just [Y] (emphasis-via-negation), Spearheaded, Demonstrated ability to. " +
      "CRITICAL OUTPUT RULE: your response must begin IMMEDIATELY with the letter greeting (e.g. 'Dear Hiring Team,') — no preamble, no explanation, no commentary before or after the letter. If you choose not to incorporate something, do so silently.",
    prompt: `Original cover letter:\n\n${input.originalLetter}\n\nRefinement request: ${input.refinementRequest}\n\nReturn the complete updated cover letter, preserving all required elements (company-name-in-body, role-specific closing, JD-integration sentence) even while applying the requested change.`,
    userPreference: taskPrefs["cover-letter"],
    connectedProviders: keys,
  });

  // Safety strip — remove any AI commentary before the greeting, then sanitise
  const text = result.text.trim();
  const greetingMatch = text.match(/(Dear\s+\S)/);
  const stripped = greetingMatch ? text.slice(text.indexOf(greetingMatch[0])) : text;
  const signOff = profile.sign_off ?? "Kind regards";
  const fullName = profile.full_name ?? "";

  // Critic pass on the refined output — same as generation. Catches any
  // banned patterns introduced during refinement.
  const revised = await reviseCoverLetter(
    stripped,
    taskPrefs["cover-letter"],
    keys,
    signOff,
    fullName,
  );

  const cleaned = ensureNameAfterSignOff(
    fixSignOff(sanitiseLetter(revised), signOff, fullName),
    signOff,
    fullName
  );

  return { text: cleaned, provider: result.provider };
}

// ── Pivot context suggestion ──────────────────────────────────────────────────

export async function suggestPivotContext(input: {
  jobDescription: string;
  draft?: string;
  cvId?: string;
}): Promise<{ text?: string; error?: string }> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    const [profile, allCVs, skills, employers, taskPrefs, keys] = await Promise.all([
      getProfile(), getCVs(), getSkills(), getEmployers(), getTaskPreferences(), getApiKeyValues(),
    ]);

    if (Object.keys(keys).length === 0) {
      return { error: "No AI provider connected. Add an API key in Settings." };
    }

    const cv = input.cvId
      ? allCVs.find((c) => c.id === input.cvId)
      : allCVs.find((c) => c.is_default) ?? allCVs[0];

    if (!cv) {
      return { error: "No CV found. Upload your CV in My Profile first." };
    }

    const employerLookup = new Map(employers.map((e) => [e.id, e]));
    const skillsText = skills.length > 0
      ? skills.map((s) => {
          const tags = (s.employer_ids ?? [])
            .map((id) => employerLookup.get(id)?.company_name)
            .filter(Boolean);
          const attribution = tags.length > 0 ? ` [from: ${tags.join(", ")}]` : " [general]";
          return `- ${s.polished_text || s.raw_text}${attribution}`;
        }).join("\n")
      : "None.";

    const employerLines = employers.length > 0
      ? employers.map((e) => `- ${e.role_title} at ${e.company_name} (${e.start_date} → ${e.is_current ? "present" : (e.end_date ?? "?")})`).join("\n")
      : "None.";

    const result = await callAI({
      task: "cover-letter",
      userPreference: taskPrefs["cover-letter"],
      connectedProviders: keys,
      systemPrompt:
        "You write the 'pivot context' for a cover letter generator. This is a SHORT (50-100 word) first-person paragraph capturing the candidate's MOTIVATION for moving into the target role — not a list of achievements. " +
        "WHAT THIS IS FOR: the cover letter generator already has the candidate's full profile, work history, skills, and CV. It will pick relevant achievements automatically using JD-relevance ranking. The pivot context provides the ONE thing the system can't infer from the profile: WHY the candidate wants this kind of work and WHICH SLICE of their current work they find most engaging. The motivation. The intent. " +
        "REQUIRED CONTENT: " +
        "(1) Name the target role / function clearly (e.g. 'I want to move into B2B sales', 'I want to work in product management'). " +
        "(2) Identify the SPECIFIC SLICE of the candidate's current work they find most engaging and want to do more of — the work pattern that draws them toward this pivot. Examples: 'the relationship-building and persuasion side', 'the system-design and tool-building side', 'the analytical work that turns data into decisions'. This is grounded in profile activity but framed as preference / motivation, not as an achievement list. " +
        "(3) Optionally: a one-line direction signal — what about the target sector / role / company specifically attracts them. Only if it can be said concretely without flattery. " +
        "DO NOT LIST ACHIEVEMENTS. The cover letter generator handles that from the profile. Listing achievements here is duplicating work and bloats the input. " +
        "DO NOT REPEAT SKILLS. The system already knows the skills. " +
        "DO NOT INVENT MOTIVATION. If the candidate's draft says 'I want to move into sales', use that motivation. If no draft is provided, infer a motivation that's CONSISTENT with their profile activity (e.g. heavy stakeholder management → 'I find the relationship-building side most engaging') but do NOT fabricate emotional claims ('I'm passionate about X'). " +
        "FACT DISCIPLINE: never invent abstract qualities ('commercial instincts', 'solution-shaping', 'business acumen', 'strategic vision' — banned unless explicitly in profile). Never inflate audience ('senior stakeholders' banned for small-business roles). Never stretch achievements (e.g. 'conversion rate test on product samples' is NOT 'understanding what moves a prospect to decision'). " +
        "ROLE-AS-SUBJECT BAN: never write sentences whose subject is the role/company/work-at-company, listing JD items and claiming alignment ('[Company]'s focus on X is exactly what I want', 'X mirrors / maps to / aligns with what this role demands'). Subject must be the candidate. " +
        "SELF-CHARACTERISING SUMMARY BAN: never write '[abstract quality] is embedded in how I work', 'X has shaped how I approach Y', 'that experience gave me a grounding in Z'. State concrete facts and stop. " +
        "BANNED FRAMINGS: 'I'm transitioning from X to Y', 'I'm pivoting from X', 'while my background is in X', 'although I don't have direct experience in X', any apologetic framing for the pivot. Frame as 'I want to move into X' followed by motivation. Never explain the gap. " +
        "BANNED PHRASES: 'passionate about', 'driven by', 'thrive in', 'best-in-class', 'world-class', 'results-oriented', 'proven track record', 'demonstrated ability to', 'strategic mindset', 'cross-functional excellence', 'meaningful product set', 'commercial instincts', 'solution-shaping', 'meaningful impact', 'genuinely changes', 'consequential work'. Sound like a real person. " +
        "OUTPUT: just the motivation paragraph. 50-100 words. No preamble, no explanation, no achievement list.",
      prompt: `TARGET JOB DESCRIPTION:
${input.jobDescription.slice(0, 4000)}

CANDIDATE WORK HISTORY:
${employerLines}

CANDIDATE SKILLS / ACHIEVEMENTS:
${skillsText}

CANDIDATE CV (background):
${cv.content.slice(0, 3000)}

${input.draft?.trim() ? `CANDIDATE'S DRAFT (preserve their voice and intent, expand with profile-grounded specifics):\n${input.draft.trim()}\n` : ""}

Write the pivot context paragraph now.`,
    });

    const text = result.text.trim().replace(/^["'`]|["'`]$/g, "");
    if (!text || text.length < 40) {
      return { error: "Couldn't generate a useful suggestion. Try writing a short draft yourself first, even one line." };
    }
    return { text };
  } catch (e) {
    console.error("[suggestPivotContext] failed:", e);
    return { error: e instanceof Error ? e.message : "Suggestion failed. Try again or write your own pivot context." };
  }
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
