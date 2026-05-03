"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Loader2, Sparkles, Lightbulb, Search } from "lucide-react";
import { addSkill, addEmployer } from "@/app/actions/profile";
import {
  saveMasterProfile,
  generateMasterProfile,
  getProfileBuilderPrefill,
  suggestDistinctiveAngles,
  type ProfileBuilderPrefill,
} from "@/app/actions/cv-tailoring";

type CareerStage =
  | "working"
  | "self_employed"
  | "founder"
  | "student"
  | "between"
  | "returner"
  | "other";

interface WizardAnswers {
  stage: CareerStage | null;
  // Identity (adapts by stage)
  jobTitle?: string;
  companyOrSector?: string;
  // Self-employed / freelance
  freelanceDiscipline?: string;
  freelanceYears?: string;
  freelanceSector?: string;
  // Founder
  businessName?: string;
  businessDoes?: string;
  businessFoundedYear?: string;
  // Student / grad
  degreeSubject?: string;
  university?: string;
  graduationYear?: string;
  // Between / returner
  lastJobTitle?: string;
  lastJobSector?: string;
  timeOut?: string;
  // Other (free-text)
  otherSituation?: string;
  // Achievement
  achievement?: string;
  achievementScale?: string;
  achievementOutcome?: string;
  // Multi-select of supporting headline achievements (in addition to the main one)
  supportingAchievements?: string[];
  // Distinctive
  distinctive?: string;
  // Education (always optional)
  educationToInclude?: string;
  educationPlacement?: "lead" | "close" | "skip";
  // Catch-all
  anythingElse?: string;
}

interface Props {
  onClose: () => void;
  // Called with the generated Master Profile summary after the wizard finishes.
  // Lets the parent set the textarea state directly, avoiding the router.refresh()
  // race that left the textarea empty when the wizard closed.
  onComplete?: (summary: string) => void;
}

const STAGE_LABELS: Record<CareerStage, string> = {
  working: "Currently in a job (employed)",
  self_employed: "Self-employed, freelance, or contractor",
  founder: "Running my own business / startup",
  student: "Studying or recent graduate (incl. apprentices, placement years)",
  between: "Between jobs",
  returner: "Returning after a break (caregiving, illness, sabbatical, etc.)",
  other: "Something else — describe my situation",
};

export default function ProfileBuilderWizard({ onClose, onComplete }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<WizardAnswers>({ stage: null });
  const [isGenerating, startGenerate] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<ProfileBuilderPrefill | null>(null);

  const totalSteps = 6;

  // Pull existing data on mount so we can pre-fill fields and surface suggestions
  useEffect(() => {
    getProfileBuilderPrefill().then(setPrefill).catch(() => {
      // non-fatal
    });
  }, []);

  // When the user picks "currently in a job" and we have existing employer data,
  // pre-fill the title + company fields automatically.
  useEffect(() => {
    if (!prefill) return;
    if (answers.stage === "working") {
      setAnswers((a) => ({
        ...a,
        jobTitle: a.jobTitle ?? prefill.currentJobTitle ?? "",
        companyOrSector: a.companyOrSector ?? prefill.currentCompany ?? "",
      }));
    }
  }, [answers.stage, prefill]);

  function update<K extends keyof WizardAnswers>(key: K, value: WizardAnswers[K]) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  function next() {
    setStep((s) => Math.min(s + 1, totalSteps));
  }

  function back() {
    setStep((s) => Math.max(s - 1, 1));
  }

  // ── Validation per step ────────────────────────────────────────────────
  function canAdvance(): boolean {
    switch (step) {
      case 1:
        return answers.stage !== null;
      case 2:
        if (answers.stage === "working") {
          // Only job title strictly required. Company/sector is helpful but optional.
          return !!answers.jobTitle?.trim();
        }
        if (answers.stage === "self_employed") {
          return !!(answers.freelanceDiscipline?.trim() && answers.freelanceSector?.trim());
        }
        if (answers.stage === "founder") {
          return !!(answers.businessName?.trim() && answers.businessDoes?.trim());
        }
        if (answers.stage === "student") {
          return !!(answers.degreeSubject?.trim() && answers.university?.trim());
        }
        if (answers.stage === "between" || answers.stage === "returner") {
          return !!(answers.lastJobTitle?.trim() && answers.lastJobSector?.trim());
        }
        if (answers.stage === "other") {
          return !!answers.otherSituation?.trim();
        }
        return false;
      case 3:
        return !!answers.achievement?.trim();
      case 4:
        return true; // distinctive is optional
      case 5:
        return true; // education is optional
      case 6:
        return true; // anything else is optional
      default:
        return false;
    }
  }

  // ── Final generation ────────────────────────────────────────────────────
  async function handleFinish() {
    setError(null);
    startGenerate(async () => {
      try {
        // 1. Save wizard answers as Skills + Work History entries so the
        //    FactBase reflects them.
        // De-dupe against existing prefill skills — if the user picked an
        //  EXISTING saved achievement as their primary in Step 3, we don't
        //  want to re-add it (creates duplicates in the Skills section).
        const existingSkillTexts = new Set(
          (prefill?.existingSkills ?? []).map((s) => s.text.trim().toLowerCase())
        );
        const skillsToAdd: string[] = [];
        const seenInWizard = new Set<string>();
        const enqueueSkill = (raw: string) => {
          const cleaned = raw.trim();
          if (!cleaned) return;
          const key = cleaned.toLowerCase();
          if (existingSkillTexts.has(key)) return; // already in user's Skills
          if (seenInWizard.has(key)) return;        // dedupe within this wizard run
          seenInWizard.add(key);
          skillsToAdd.push(cleaned);
        };

        if (answers.achievement?.trim()) {
          // Only ADD a new skill if either (a) the achievement is freshly typed
          // (not a verbatim selection of an existing skill) OR (b) the user
          // added meaningful scale/outcome metadata that the existing skill
          // didn't already capture.
          const baseAchievement = answers.achievement.trim();
          const isExistingPick = existingSkillTexts.has(baseAchievement.toLowerCase());
          const hasExtraScale = !!answers.achievementScale?.trim();
          const hasExtraOutcome = !!answers.achievementOutcome?.trim();

          if (!isExistingPick) {
            // Freshly typed — save the composed version with its scale/outcome.
            let composed = baseAchievement;
            if (hasExtraScale) composed += ` (scale: ${answers.achievementScale!.trim()})`;
            if (hasExtraOutcome) composed += ` — outcome: ${answers.achievementOutcome!.trim()}`;
            enqueueSkill(composed);
          } else if (hasExtraScale || hasExtraOutcome) {
            // Existing skill selected, but user added scale/outcome.
            // Save the metadata as a separate, scoped Skills row tied to that
            // achievement so we don't lose it but also don't duplicate.
            const meta: string[] = [];
            if (hasExtraScale) meta.push(`scale ${answers.achievementScale!.trim()}`);
            if (hasExtraOutcome) meta.push(`outcome ${answers.achievementOutcome!.trim()}`);
            enqueueSkill(`Context for "${baseAchievement.slice(0, 80)}${baseAchievement.length > 80 ? "…" : ""}": ${meta.join("; ")}`);
          }
          // else: existing skill picked with no new metadata → don't re-add.
        }
        if (answers.distinctive?.trim()) {
          enqueueSkill(`Distinctive context: ${answers.distinctive.trim()}`);
        }
        if (answers.anythingElse?.trim()) {
          enqueueSkill(answers.anythingElse.trim());
        }
        if (answers.educationToInclude?.trim()) {
          enqueueSkill(`Education: ${answers.educationToInclude.trim()}`);
        }
        if (answers.stage === "other" && answers.otherSituation?.trim()) {
          enqueueSkill(`Current situation: ${answers.otherSituation.trim()}`);
        }

        for (const s of skillsToAdd) {
          await addSkill(s);
        }

        // 2. Save Work History entry — adapts to each stage.
        const today = new Date().toISOString().slice(0, 7);
        if (answers.stage === "working" && answers.jobTitle && answers.companyOrSector) {
          await addEmployer({
            company_name: answers.companyOrSector.trim(),
            role_title: answers.jobTitle.trim(),
            start_date: today,
            is_current: true,
            employment_type: "full-time",
          });
        } else if (answers.stage === "self_employed" && answers.freelanceDiscipline && answers.freelanceSector) {
          await addEmployer({
            company_name: `Self-employed (${answers.freelanceSector.trim()})`,
            role_title: answers.freelanceDiscipline.trim(),
            start_date: today,
            is_current: true,
            employment_type: "freelance",
            summary: answers.freelanceYears ? `${answers.freelanceYears.trim()} of self-employed work` : null,
          });
        } else if (answers.stage === "founder" && answers.businessName && answers.businessDoes) {
          await addEmployer({
            company_name: answers.businessName.trim(),
            role_title: "Founder",
            start_date: answers.businessFoundedYear?.match(/\d{4}/)?.[0]
              ? `${answers.businessFoundedYear.match(/\d{4}/)![0]}-01`
              : today,
            is_current: true,
            employment_type: "founder",
            summary: answers.businessDoes.trim(),
          });
        } else if (
          (answers.stage === "between" || answers.stage === "returner") &&
          answers.lastJobTitle &&
          answers.lastJobSector
        ) {
          await addEmployer({
            company_name: answers.lastJobSector.trim(),
            role_title: answers.lastJobTitle.trim(),
            start_date: today,
            is_current: false,
            employment_type: "full-time",
            summary: answers.stage === "returner" && answers.timeOut
              ? `Last role before a career break of ${answers.timeOut.trim()}`
              : "Most recent role",
          });
        }

        // 3. Generate the Master Profile from the now-populated FactBase.
        const result = await generateMasterProfile({});
        if (result.error) {
          setError(result.error);
          return;
        }
        if (result.summary) {
          await saveMasterProfile({
            summary: result.summary,
            source: "generated",
          });
          // Hand the fresh summary to the parent FIRST so the textarea
          // populates immediately. router.refresh() updates the saved-time
          // metadata async — it's no longer load-bearing for the textarea.
          onComplete?.(result.summary);
        }

        router.refresh();
        onClose();
      } catch (e) {
        console.error("[ProfileBuilderWizard] generation failed:", e);
        setError(e instanceof Error ? e.message : "Failed to build Profile.");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg">Build my Master Profile</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Step {step} of {totalSteps} · 5 minutes
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1">
            <X size={18} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-slate-100 shrink-0">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${(step / totalSteps) * 100}%` }}
          />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {step === 1 && <Step1Stage answers={answers} update={update} />}
          {step === 2 && <Step2Identity answers={answers} update={update} prefill={prefill} />}
          {step === 3 && <Step3Achievement answers={answers} update={update} prefill={prefill} />}
          {step === 4 && <Step4Distinctive answers={answers} update={update} prefill={prefill} />}
          {step === 5 && <Step5Education answers={answers} update={update} />}
          {step === 6 && <Step6Anything answers={answers} update={update} />}
        </div>

        {/* Footer */}
        {error && (
          <div className="px-6 py-3 bg-rose-50 border-t border-rose-200 text-xs text-rose-900 shrink-0">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl shrink-0">
          <button
            onClick={back}
            disabled={step === 1 || isGenerating}
            className="text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-30"
          >
            <ChevronLeft size={14} /> Back
          </button>

          {step < totalSteps ? (
            <button
              onClick={next}
              disabled={!canAdvance()}
              className={`text-sm font-medium inline-flex items-center gap-1.5 px-4 py-2 rounded-lg transition-colors ${
                canAdvance()
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed"
              }`}
            >
              Next <ChevronRight size={14} />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              disabled={isGenerating}
              className="text-sm font-medium inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-40"
            >
              {isGenerating ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Building Profile…
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Build my Profile
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step 1 — Career Stage ──────────────────────────────────────────────────

function Step1Stage({
  answers,
  update,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          Which describes you right now?
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Pick the closest one — we&apos;ll adapt the questions to your situation.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(Object.keys(STAGE_LABELS) as CareerStage[]).map((stage) => (
          <button
            key={stage}
            onClick={() => update("stage", stage)}
            className={`text-left text-sm px-4 py-3 rounded-xl border transition-colors ${
              answers.stage === stage
                ? "border-blue-500 bg-blue-50 text-blue-900"
                : "border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50"
            }`}
          >
            {STAGE_LABELS[stage]}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Step 2 — Identity (adapts by stage) ────────────────────────────────────

function Step2Identity({
  answers,
  update,
  prefill,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
  prefill: ProfileBuilderPrefill | null;
}) {
  if (answers.stage === "working") {
    const hasPrefill = !!(prefill?.currentJobTitle || prefill?.currentCompany);
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your current role</h3>
          <p className="text-xs text-slate-500 mt-1">
            {hasPrefill
              ? "Pre-filled from your saved Work History — edit if anything's wrong."
              : "Job title is required. Company/sector is helpful but optional."}
          </p>
        </div>
        <Field
          label="Job title *"
          placeholder="e.g. Supply Chain Analyst, Software Engineer, Marketing Manager"
          value={answers.jobTitle ?? ""}
          onChange={(v) => update("jobTitle", v)}
        />
        <Field
          label="Company / what does the business do? (optional)"
          placeholder="e.g. UK consumer goods business · B2B SaaS startup · Skip if you'd rather not say"
          value={answers.companyOrSector ?? ""}
          onChange={(v) => update("companyOrSector", v)}
        />
      </div>
    );
  }
  if (answers.stage === "self_employed") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your work</h3>
          <p className="text-xs text-slate-500 mt-1">
            What you do, who you do it for, how long you&apos;ve been doing it.
          </p>
        </div>
        <Field
          label="Discipline / what kind of work?"
          placeholder="e.g. Brand designer · Tax consultant · Plumbing contractor · Editorial writer"
          value={answers.freelanceDiscipline ?? ""}
          onChange={(v) => update("freelanceDiscipline", v)}
        />
        <Field
          label="Sector / typical clients"
          placeholder="e.g. Tech startups · UK SMEs · Construction · Charities and NGOs"
          value={answers.freelanceSector ?? ""}
          onChange={(v) => update("freelanceSector", v)}
        />
        <Field
          label="How long have you been doing this?"
          placeholder="e.g. 3 years · since 2022 · ~6 months"
          value={answers.freelanceYears ?? ""}
          onChange={(v) => update("freelanceYears", v)}
        />
      </div>
    );
  }
  if (answers.stage === "founder") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your business</h3>
          <p className="text-xs text-slate-500 mt-1">
            What it does, when you started, where you are now.
          </p>
        </div>
        <Field
          label="Business name (or your role title)"
          placeholder="e.g. Founder of [Business] · Co-founder & CTO · Owner-Director"
          value={answers.businessName ?? ""}
          onChange={(v) => update("businessName", v)}
        />
        <Field
          label="What does the business do?"
          placeholder="e.g. D2C skincare brand · B2B SaaS for accountants · Bricks & mortar coffee shop"
          value={answers.businessDoes ?? ""}
          onChange={(v) => update("businessDoes", v)}
        />
        <Field
          label="When did you start it?"
          placeholder="e.g. 2023 · 18 months ago"
          value={answers.businessFoundedYear ?? ""}
          onChange={(v) => update("businessFoundedYear", v)}
        />
      </div>
    );
  }
  if (answers.stage === "student") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your studies</h3>
          <p className="text-xs text-slate-500 mt-1">
            Your degree, course, or apprenticeship — and the institution.
          </p>
        </div>
        <Field
          label="Course / degree subject"
          placeholder="e.g. Economics BA · Software Engineering MEng · Level 3 Engineering Apprenticeship"
          value={answers.degreeSubject ?? ""}
          onChange={(v) => update("degreeSubject", v)}
        />
        <Field
          label="Institution / employer (for apprenticeships)"
          placeholder="e.g. University of Bristol · Imperial College London · Rolls-Royce apprenticeship"
          value={answers.university ?? ""}
          onChange={(v) => update("university", v)}
        />
        <Field
          label="Year you finish (or finished)"
          placeholder="e.g. 2025 · ongoing"
          value={answers.graduationYear ?? ""}
          onChange={(v) => update("graduationYear", v)}
        />
      </div>
    );
  }
  if (answers.stage === "between" || answers.stage === "returner") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your most recent role</h3>
          <p className="text-xs text-slate-500 mt-1">
            {answers.stage === "returner"
              ? "Last job you held before the break."
              : "The most recent job you held."}
          </p>
        </div>
        <Field
          label="Job title"
          placeholder="e.g. Senior Auditor · Operations Manager · Designer"
          value={answers.lastJobTitle ?? ""}
          onChange={(v) => update("lastJobTitle", v)}
        />
        <Field
          label="Sector / what did the business do?"
          placeholder="e.g. Big 4 audit · Logistics · D2C consumer brand"
          value={answers.lastJobSector ?? ""}
          onChange={(v) => update("lastJobSector", v)}
        />
        {answers.stage === "returner" && (
          <Field
            label="How long has it been since you last worked? (Optional — skip if you'd rather not say.)"
            placeholder="e.g. 18 months · 2 years · a few years"
            value={answers.timeOut ?? ""}
            onChange={(v) => update("timeOut", v)}
          />
        )}
      </div>
    );
  }
  // other — free-text
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">Tell me about your situation</h3>
        <p className="text-xs text-slate-500 mt-1">
          Describe where you are now in a couple of sentences. We&apos;ll adapt everything from your answer.
        </p>
      </div>
      <ExamplePanel
        examples={[
          "Currently doing a 12-month industrial placement at Rolls-Royce as part of my engineering degree",
          "Running a part-time consulting practice while completing an MBA",
          "Recently left the military after 8 years, looking to move into operations",
          "Volunteer board member at a charity while figuring out my next paid step",
          "Caregiver for an elderly parent for the last 2 years; doing some tutoring on the side",
          "Working two part-time roles — one in retail, one as a personal trainer",
        ]}
      />
      <textarea
        value={answers.otherSituation ?? ""}
        onChange={(e) => update("otherSituation", e.target.value)}
        placeholder="Describe your current situation in your own words..."
        rows={4}
        className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
      />
    </div>
  );
}

// ── Step 3 — Achievement ───────────────────────────────────────────────────

function Step3Achievement({
  answers,
  update,
  prefill,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
  prefill: ProfileBuilderPrefill | null;
}) {
  const existingSkills = prefill?.existingSkills ?? [];
  const hasExisting = existingSkills.length > 0;

  // Sector-relevant fallback examples — filtered by detected role/sector keywords
  const fallbackExamples = pickRelevantExamples(answers);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          Tell me about something significant — built, fixed, designed, won, or learned
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          One specific thing. Don&apos;t be modest — anything counts.
        </p>
      </div>

      {hasExisting && (
        <SavedAchievementsPicker
          skills={existingSkills}
          primary={answers.achievement}
          supporting={answers.supportingAchievements ?? []}
          onSetPrimary={(text) => update("achievement", text)}
          onToggleSupporting={(text) => {
            const supporting = answers.supportingAchievements ?? [];
            const next = supporting.includes(text)
              ? supporting.filter((t) => t !== text)
              : [...supporting, text];
            update("supportingAchievements", next);
          }}
        />
      )}

      <ExamplePanel
        title={hasExisting ? "Other ideas (in case nothing above fits)" : "Examples for inspiration"}
        examples={fallbackExamples}
      />
      <textarea
        value={answers.achievement ?? ""}
        onChange={(e) => update("achievement", e.target.value)}
        placeholder="What did you do?"
        rows={3}
        className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
      />
      <Field
        label="How big was it? (rough scale — money, people, volume, time, geography)"
        placeholder="e.g. about £40k · roughly 12 suppliers · doubled in 6 months · across 3 sites"
        value={answers.achievementScale ?? ""}
        onChange={(v) => update("achievementScale", v)}
      />
      <Field
        label="What changed because of it?"
        placeholder="e.g. saved £X · cut Y hours per week · faster delivery · fewer customer complaints"
        value={answers.achievementOutcome ?? ""}
        onChange={(v) => update("achievementOutcome", v)}
      />
    </div>
  );
}

// ── Step 4 — Distinctive ───────────────────────────────────────────────────

function Step4Distinctive({
  answers,
  update,
  prefill,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
  prefill: ProfileBuilderPrefill | null;
}) {
  const candidates = prefill?.distinctiveCandidates ?? [];
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  const [isSuggesting, startSuggest] = useTransition();
  const [suggestError, setSuggestError] = useState<string | null>(null);

  function fetchSuggestions() {
    setSuggestError(null);
    startSuggest(async () => {
      const result = await suggestDistinctiveAngles({
        jobTitle: answers.jobTitle,
        companyOrSector: answers.companyOrSector,
        achievement: answers.achievement,
        achievementScale: answers.achievementScale,
      });
      if (result.error) {
        setSuggestError(result.error);
        return;
      }
      setAiSuggestions(result.suggestions);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          What makes your situation distinctive?
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Something another candidate doing your role probably wouldn&apos;t have. Totally OK to skip — many strong Profiles lean on scope and outcome instead.
        </p>
      </div>

      <button
        type="button"
        onClick={fetchSuggestions}
        disabled={isSuggesting}
        className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
      >
        {isSuggesting ? (
          <>
            <Loader2 size={12} className="animate-spin" /> Thinking…
          </>
        ) : (
          <>
            <Sparkles size={12} /> Help me — what&apos;s distinctive about my situation?
          </>
        )}
      </button>

      {suggestError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {suggestError}
        </div>
      )}

      {aiSuggestions.length > 0 && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
          <div className="text-xs font-semibold text-emerald-900 mb-2 inline-flex items-center gap-1">
            <Sparkles size={11} /> AI suggestions based on your data — pick one or skip
          </div>
          <div className="space-y-1">
            {aiSuggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => update("distinctive", s)}
                className={`block w-full text-left text-xs px-3 py-1.5 rounded-md border transition-colors ${
                  answers.distinctive === s
                    ? "border-emerald-500 bg-white text-emerald-900"
                    : "border-emerald-100 bg-white/70 text-slate-700 hover:bg-white hover:border-emerald-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-emerald-900/70 mt-2">
            None fit? You can skip this step entirely — the Profile generator handles missing distinctive claims gracefully.
          </p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <div className="text-xs font-semibold text-blue-900 mb-2 inline-flex items-center gap-1">
            <Lightbulb size={11} /> From your saved Skills — looks like one of these might apply:
          </div>
          <div className="space-y-1">
            {candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => update("distinctive", c)}
                className={`block w-full text-left text-xs px-3 py-1.5 rounded-md border transition-colors ${
                  answers.distinctive === c
                    ? "border-blue-400 bg-white text-blue-900"
                    : "border-blue-100 bg-white/70 text-slate-700 hover:bg-white hover:border-blue-200"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <ExamplePanel
        title={candidates.length > 0 ? "Other angles to consider" : "Examples"}
        examples={[
          "I'm the only person doing this role at the company",
          "I built the function from scratch when there was nothing",
          "I report directly to the CEO / CFO",
          "I'm part of a 3-person founding team",
          "I'm the most senior X in my office",
          "I work across both [function A] and [function B]",
          "I've been promoted twice in 18 months",
          "I'm the only graduate in a team of 10 senior people",
        ]}
      />
      <textarea
        value={answers.distinctive ?? ""}
        onChange={(e) => update("distinctive", e.target.value)}
        placeholder="What's distinctive about your situation? (Optional — skip if nothing comes to mind)"
        rows={3}
        className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
      />
    </div>
  );
}

// ── Step 5 — Education ─────────────────────────────────────────────────────

function Step5Education({
  answers,
  update,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">Education — anything to include?</h3>
        <p className="text-xs text-slate-500 mt-1">
          Optional. Mention only if it adds value (degree class, named uni, A-level grades for finance/MBB roles).
          Skip without worry.
        </p>
      </div>
      <textarea
        value={answers.educationToInclude ?? ""}
        onChange={(e) => update("educationToInclude", e.target.value)}
        placeholder={`e.g. "First-Class BSc Economics from LSE, top of cohort" · "MBA from INSEAD" · "AAA at A-level: Maths, Further Maths, Physics"`}
        rows={3}
        className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
      />
      {answers.educationToInclude?.trim() && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500">Where should it sit in your Profile?</p>
          <div className="grid grid-cols-3 gap-2">
            {([
              ["lead", "Open the Profile"],
              ["close", "Sit at the close"],
              ["skip", "Don't include"],
            ] as const).map(([val, label]) => (
              <button
                key={val}
                onClick={() => update("educationPlacement", val)}
                className={`text-xs px-3 py-2 rounded-lg border transition-colors ${
                  answers.educationPlacement === val
                    ? "border-blue-500 bg-blue-50 text-blue-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 6 — Anything Else ─────────────────────────────────────────────────

function Step6Anything({
  answers,
  update,
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          Anything else recruiters should know?
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Optional. Skills you&apos;re proud of, side projects, certifications, languages, anything we&apos;ve missed.
        </p>
      </div>
      <ExamplePanel
        examples={[
          "Fluent in 3 languages (English, French, Mandarin)",
          "Built and maintain an open-source library with 2k GitHub stars",
          "Side project: ran a Substack on supply-chain economics for 18 months",
          "AWS Solutions Architect certified",
          "Volunteered as a STEM mentor for 2 years",
        ]}
      />
      <textarea
        value={answers.anythingElse ?? ""}
        onChange={(e) => update("anythingElse", e.target.value)}
        placeholder="Anything else? (Optional)"
        rows={3}
        className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
      />
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-500 mb-1 block">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
      />
    </div>
  );
}

// Aesthetic, scalable picker for the user's saved achievements. Supports any
// quantity (3 or 300) without becoming a wall: search + chip selection +
// progressive disclosure ("show all"). The user's selections appear pinned at
// the top with clear primary (★) / supporting (✓) treatments, so picks stay
// visible even after filtering.
function SavedAchievementsPicker({
  skills,
  primary,
  supporting,
  onSetPrimary,
  onToggleSupporting,
}: {
  skills: Array<{ id: string; text: string }>;
  primary: string | undefined;
  supporting: string[];
  onSetPrimary: (text: string) => void;
  onToggleSupporting: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const totalTagged = (primary ? 1 : 0) + supporting.length;
  const canAddSupporting = totalTagged < 3;

  // Build the working list: selections pinned first, then the rest.
  const selectedIds = new Set<string>();
  const selectedSkills: typeof skills = [];
  if (primary) {
    const found = skills.find((s) => s.text === primary);
    if (found) {
      selectedSkills.push(found);
      selectedIds.add(found.id);
    }
  }
  for (const t of supporting) {
    const found = skills.find((s) => s.text === t);
    if (found && !selectedIds.has(found.id)) {
      selectedSkills.push(found);
      selectedIds.add(found.id);
    }
  }
  const others = skills.filter((s) => !selectedIds.has(s.id));

  const q = query.trim().toLowerCase();
  const filteredOthers = q.length > 0
    ? others.filter((s) => s.text.toLowerCase().includes(q))
    : others;

  const COLLAPSED_LIMIT = 6;
  const visibleOthers = showAll || q.length > 0
    ? filteredOthers
    : filteredOthers.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = filteredOthers.length - visibleOthers.length;

  const renderRow = (s: { id: string; text: string }) => {
    const isPrimary = primary === s.text;
    const isSupporting = supporting.includes(s.text);
    return (
      <div key={s.id} className="flex gap-1">
        <button
          type="button"
          onClick={() => onSetPrimary(s.text)}
          className={`flex-1 text-left text-xs px-3 py-1.5 rounded-md border transition-colors leading-relaxed ${
            isPrimary
              ? "border-blue-500 bg-white text-blue-900 font-medium shadow-sm"
              : "border-blue-100 bg-white/70 text-slate-700 hover:bg-white hover:border-blue-200"
          }`}
        >
          {isPrimary && <span className="mr-1">★</span>}
          <span className="line-clamp-2">{s.text}</span>
        </button>
        {!isPrimary && (
          <button
            type="button"
            disabled={!isSupporting && !canAddSupporting}
            onClick={() => onToggleSupporting(s.text)}
            className={`shrink-0 self-start text-[10px] px-2 py-1.5 rounded-md border transition-colors ${
              isSupporting
                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 disabled:opacity-30 disabled:cursor-not-allowed"
            }`}
            title={isSupporting ? "Remove from supporting" : "Tag as supporting headline material"}
          >
            {isSupporting ? "✓ supporting" : "+ supporting"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-semibold text-blue-900 inline-flex items-center gap-1">
          <Lightbulb size={11} /> Your saved achievements
          <span className="ml-1 text-[10px] font-normal text-blue-900/60">
            ({skills.length})
          </span>
        </div>
        <div className="text-[11px] text-blue-900/70">
          {totalTagged}/3 tagged
        </div>
      </div>

      <p className="text-[11px] text-blue-900/70">
        Pick the ONE to lead with (★). Tag up to 2 more as supporting (✓).
      </p>

      {skills.length > COLLAPSED_LIMIT && (
        <div className="relative">
          <Search
            size={11}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-blue-900/40"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search achievements…"
            className="w-full text-xs pl-7 pr-3 py-1.5 rounded-md border border-blue-200 bg-white/80 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-blue-900/30"
          />
        </div>
      )}

      {selectedSkills.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-900/60">
            Your picks
          </div>
          <div className="space-y-1">{selectedSkills.map(renderRow)}</div>
        </div>
      )}

      {visibleOthers.length > 0 && (
        <div className="space-y-1">
          {selectedSkills.length > 0 && (
            <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-900/60">
              {q.length > 0 ? `Matches (${filteredOthers.length})` : "Pick from"}
            </div>
          )}
          <div className="space-y-1 max-h-[260px] overflow-y-auto pr-1 -mr-1">
            {visibleOthers.map(renderRow)}
          </div>
        </div>
      )}

      {q.length === 0 && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[11px] font-medium text-blue-700 hover:text-blue-900"
        >
          Show {hiddenCount} more →
        </button>
      )}
      {q.length === 0 && showAll && filteredOthers.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="text-[11px] font-medium text-blue-700 hover:text-blue-900"
        >
          Show fewer
        </button>
      )}
      {q.length > 0 && filteredOthers.length === 0 && (
        <div className="text-[11px] text-blue-900/60 italic">
          No matches. Try a different word, or paste your own achievement below.
        </div>
      )}
    </div>
  );
}

function ExamplePanel({ examples, title }: { examples: string[]; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium"
      >
        <Lightbulb size={11} /> {open ? `Hide ${title ?? "examples"}` : title ?? "Show examples"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 list-disc pl-5 text-slate-600">
          {examples.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Filter the example pool to ones relevant to the user's stated role/sector,
// so they see 4-5 close matches rather than 16 strangers' achievements.
function pickRelevantExamples(answers: WizardAnswers): string[] {
  const role = (answers.jobTitle ?? answers.lastJobTitle ?? "").toLowerCase();
  const company = (
    answers.companyOrSector ??
    answers.lastJobSector ??
    answers.freelanceSector ??
    answers.businessDoes ??
    ""
  ).toLowerCase();
  const blob = `${role} ${company}`;

  // Pool keyed by sector/role tag
  const pool: Array<{ tags: string[]; example: string }> = [
    // Supply chain / procurement / operations
    { tags: ["supply", "procurement", "ops", "logistics", "operations", "buyer", "warehouse"], example: "Built a supplier scorecard from scratch that recovered £40k in refunds on damaged stock" },
    { tags: ["supply", "procurement", "ops", "logistics"], example: "Switched courier provider after analysing performance data, cut delivery costs 18%" },
    { tags: ["procurement", "buyer", "category"], example: "Negotiated supplier MOQ reductions across 4 vendors, freeing £40k of working capital" },
    // Finance / banking
    { tags: ["finance", "audit", "banking", "investment", "accounting"], example: "Rebuilt the month-end reconciliation pipeline, cutting close cycle from 9 to 4 days" },
    { tags: ["finance", "audit", "investment"], example: "Modelled a £1.2bn carve-out used in the IC paper; deal closed +12% to bid" },
    // Tech / engineering
    { tags: ["engineer", "developer", "swe", "software", "devops", "data"], example: "Shipped the user-facing checkout for a 1.4M-user fintech, sub-200ms at 3x peak" },
    { tags: ["engineer", "developer", "data"], example: "Migrated the data pipeline to Snowflake, cutting daily run from 4h to 22min" },
    // Marketing / brand
    { tags: ["marketing", "brand", "content", "comms", "social"], example: "Ran the 2024 flagship campaign across UK and Ireland, lifting brand-aided recall 18 points" },
    { tags: ["marketing", "growth", "performance"], example: "Drove paid-acquisition CAC down 32% by restructuring the keyword strategy" },
    // Consulting / strategy
    { tags: ["consult", "strategy", "advisory"], example: "Led a £1.8m diligence workstream for a PE buy-side, deal closed to plan" },
    // Sales
    { tags: ["sales", "bd", "account", "client"], example: "Closed £450k of net-new ARR in my first 12 months, 140% of quota" },
    // HR / people
    { tags: ["hr", "people", "talent", "recruit"], example: "Rolled out a new performance-review framework to 240 employees in 8 weeks" },
    // Healthcare / clinical
    { tags: ["nurse", "clinical", "doctor", "health", "care", "nhs"], example: "Designed a triage protocol that cut average waiting time on shift from 90 to 45 minutes" },
    // Education / teaching
    { tags: ["teach", "education", "tutor", "lecturer", "academic"], example: "Designed a new key-stage curriculum module adopted across 4 partner schools" },
    // Retail / hospitality / customer service
    { tags: ["retail", "store", "hospitality", "customer", "service"], example: "Rebalanced the rota at peak, lifting Saturday revenue 18% across 12 weeks" },
    // Trades / construction
    { tags: ["construction", "site", "project manager", "trade", "engineer"], example: "Brought a £1.2m fit-out in 6% under budget by switching one supplier mid-project" },
    // Founder / self-employed
    { tags: ["founder", "owner", "self-employed", "freelance", "director"], example: "Bootstrapped my D2C business to £400k revenue in year 2 with no outside funding" },
    // Creative / design
    { tags: ["design", "creative", "ux", "ui", "art"], example: "Redesigned the onboarding flow, lifting D7 retention from 22% to 38%" },
    // Generic strong fallbacks
    { tags: ["*"], example: "Set up an automated reporting pipeline that replaced 6 hours of manual work each week" },
    { tags: ["*"], example: "Spotted a recurring billing error and recovered £20k in overcharges" },
    { tags: ["*"], example: "Trained a new team of 5, shortening onboarding from 3 months to 4 weeks" },
  ];

  const matched = pool.filter((p) => p.tags.some((t) => t === "*" || blob.includes(t))).map((p) => p.example);
  // Dedupe + cap to 5
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of matched) {
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
      if (out.length >= 5) break;
    }
  }
  return out.length > 0 ? out : pool.filter((p) => p.tags.includes("*")).map((p) => p.example).slice(0, 4);
}
