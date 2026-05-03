"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Loader2, Sparkles, Lightbulb } from "lucide-react";
import { addSkill, addEmployer } from "@/app/actions/profile";
import {
  saveMasterProfile,
  generateMasterProfile,
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

export default function ProfileBuilderWizard({ onClose }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<WizardAnswers>({ stage: null });
  const [isGenerating, startGenerate] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const totalSteps = 6;

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
          return !!(answers.jobTitle?.trim() && answers.companyOrSector?.trim());
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
        const skillsToAdd: string[] = [];

        if (answers.achievement?.trim()) {
          let composed = answers.achievement.trim();
          if (answers.achievementScale?.trim()) {
            composed += ` (scale: ${answers.achievementScale.trim()})`;
          }
          if (answers.achievementOutcome?.trim()) {
            composed += ` — outcome: ${answers.achievementOutcome.trim()}`;
          }
          skillsToAdd.push(composed);
        }
        if (answers.distinctive?.trim()) {
          skillsToAdd.push(`Distinctive context: ${answers.distinctive.trim()}`);
        }
        if (answers.anythingElse?.trim()) {
          skillsToAdd.push(answers.anythingElse.trim());
        }
        if (answers.educationToInclude?.trim()) {
          skillsToAdd.push(`Education: ${answers.educationToInclude.trim()}`);
        }
        if (answers.stage === "other" && answers.otherSituation?.trim()) {
          skillsToAdd.push(`Current situation: ${answers.otherSituation.trim()}`);
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
          {step === 2 && <Step2Identity answers={answers} update={update} />}
          {step === 3 && <Step3Achievement answers={answers} update={update} />}
          {step === 4 && <Step4Distinctive answers={answers} update={update} />}
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
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  if (answers.stage === "working") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="font-semibold text-slate-900 text-base">Tell me about your current role</h3>
          <p className="text-xs text-slate-500 mt-1">
            Two short answers — your job title and what the business does.
          </p>
        </div>
        <Field
          label="Job title"
          placeholder="e.g. Supply Chain Analyst, Software Engineer, Marketing Manager"
          value={answers.jobTitle ?? ""}
          onChange={(v) => update("jobTitle", v)}
        />
        <Field
          label="Company / what does the business do?"
          placeholder="e.g. UK consumer goods business · B2B SaaS startup · Top-3 UK supermarket"
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
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          Tell me about something significant — built, fixed, designed, won, or learned
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          One specific thing. Could be at work, in your studies, in a side project, in voluntary work,
          or while running your own business. Don&apos;t be modest — anything counts.
        </p>
      </div>
      <ExamplePanel
        examples={[
          // Working
          "Built a supplier tracker that recovered £40k in refunds on damaged stock",
          "Shipped a checkout redesign that lifted conversion by 14%",
          // Self-employed
          "Took a freelance design business from 0 to 12 retainer clients in 18 months",
          "Negotiated my way onto a £200k consulting framework as a sole-trader competing against agencies",
          // Founder
          "Bootstrapped my D2C skincare business to £400k revenue in year 2",
          "Hired my first 3 employees and set up the operating cadence as the technical co-founder",
          // Student
          "Led a 6-person student team to win a £10k national entrepreneurship competition",
          "Final-year project on supply-chain optimisation adopted by my placement employer",
          // Apprentice / placement
          "On placement at PwC, contributed to FTSE-250 audit engagements during reporting season",
          "Led the apprentice cohort&apos;s charity drive, raising £4k across the year",
          // Between jobs
          "In my last role, switched courier providers after analysing performance, cut costs 18%",
          // Returner
          "While caring for my parent, set up and ran a small online tutoring practice",
          "During my career break, completed a Google Data Analytics certification",
          // General
          "Set up an automated reporting pipeline that replaced 6 hours of manual work each week",
          "Trained a new team of 5 hires, shortening onboarding from 3 months to 4 weeks",
          "Volunteered as STEM mentor for 2 years; 4 of my mentees got into Russell Group universities",
        ]}
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
}: {
  answers: WizardAnswers;
  update: <K extends keyof WizardAnswers>(k: K, v: WizardAnswers[K]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-slate-900 text-base">
          What makes your situation distinctive?
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Something another candidate doing your role probably wouldn&apos;t have. Skip if nothing comes to mind.
        </p>
      </div>
      <ExamplePanel
        examples={[
          "I&apos;m the only person doing this role at the company",
          "I built the function from scratch when there was nothing",
          "I report directly to the CEO / CFO",
          "I&apos;m part of a 3-person founding team",
          "I&apos;m the most senior X in my office",
          "I work across both [function A] and [function B]",
          "I&apos;ve been promoted twice in 18 months",
          "I&apos;m the only graduate in a team of 10 senior people",
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

function ExamplePanel({ examples }: { examples: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium"
      >
        <Lightbulb size={11} /> {open ? "Hide examples" : "Show examples"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 list-disc pl-5 text-slate-600">
          {examples.map((e, i) => (
            <li key={i} dangerouslySetInnerHTML={{ __html: e }} />
          ))}
        </ul>
      )}
    </div>
  );
}
