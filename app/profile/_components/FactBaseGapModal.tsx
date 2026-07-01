"use client";

// Pre-generation gap-filling modal. Runs before Master Profile generation
// when the FactBase coverage is medium/low. Shows the AI's targeted questions,
// captures 1-2 sentence answers, and feeds them back into generation as
// wizardContext. Optionally persists answers to user_skills so future
// generations benefit too.
//
// The bar: feels like a 60-second coaching session, not a form. Each question
// explains why the evidence matters. Examples seed the user's thinking
// without forcing them into a template.

import { useEffect, useState, useTransition } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Sparkles,
  Wand2,
  X,
  ShieldCheck,
} from "lucide-react";
import {
  elaborateGapAnswer,
  type FactBaseGapResult,
} from "@/app/actions/cv-tailoring";

interface Props {
  gapResult: FactBaseGapResult;
  // True while the parent is running pre-flight gap detection. Modal renders
  // a loading state instead of the questions until detection lands.
  isDetecting?: boolean;
  // Called when the user submits. Payload includes per-question answers
  // (skipped questions are omitted), and whether to persist to user_skills.
  onSubmit: (payload: {
    answers: Array<{ question: string; answer: string }>;
    persistToSkills: boolean;
  }) => Promise<void> | void;
  // Called when the user dismisses the modal. They can still proceed with
  // generation via the "Skip and generate anyway" button on the modal — the
  // parent decides whether to call onSubmit (with empty answers) or just
  // close.
  onClose: () => void;
  // Set true to disable the form during generation (after user submits, the
  // parent kicks off the generation pipeline — we keep the modal open with
  // a generating spinner so the user knows their answers are being used).
  isGenerating?: boolean;
  // Optional — when set, surfaces the target family in the career-changer
  // warning banner so the user sees exactly what role family we've assessed
  // their FactBase against. Also passed to the Elaborate server action so
  // the AI knows what register to elaborate the answer toward.
  targetRoleFamily?: string;
  // Optional — base CV id used by the Elaborate action to load FactBase
  // context. Defaults to the user's primary CV server-side when omitted.
  cvId?: string;
}

function CoverageBadge({ score }: { score: FactBaseGapResult["coverageScore"] }) {
  const styles = {
    high: "bg-emerald-50 border-emerald-200 text-emerald-700",
    medium: "bg-amber-50 border-amber-200 text-amber-700",
    low: "bg-rose-50 border-rose-200 text-rose-700",
  };
  const label = {
    high: "Strong",
    medium: "Partial",
    low: "Thin",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${styles[score]}`}
    >
      <ShieldCheck size={10} />
      FactBase coverage: {label[score]}
    </span>
  );
}

export default function FactBaseGapModal({
  gapResult,
  isDetecting = false,
  onSubmit,
  onClose,
  isGenerating = false,
  targetRoleFamily = "",
  cvId,
}: Props) {
  // Per-question answer state + skip toggle.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [persistToSkills, setPersistToSkills] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  // Per-question Elaborate state. Keyed by question id, value is true while
  // the AI is fleshing out the user's fragment. Lets users type a few rough
  // words and have the AI expand them into a CV-grade answer — the biggest
  // friction-reducer for users who won't write A+ essay answers.
  const [elaborating, setElaborating] = useState<Record<string, boolean>>({});
  const [elaborateError, setElaborateError] = useState<Record<string, string>>({});

  // Pre-fill answers with AI's suggested draft (drawn from FactBase). Users
  // can accept as-is, edit, or replace — but the heavy lifting of crafting
  // a plausible answer is already done. Massive friction reduction vs the
  // user composing 3 answers from scratch.
  useEffect(() => {
    const prefill: Record<string, string> = {};
    for (const q of gapResult.questions) {
      if (q.suggestedAnswer && q.suggestedAnswer.trim()) {
        prefill[q.id] = q.suggestedAnswer;
      }
    }
    setAnswers(prefill);
    setSkipped({});
    setError(null);
  }, [gapResult]);

  // Elaborate handler — user types a few rough words, this calls the AI to
  // flesh them out into a polished 1-2 sentence answer using FactBase
  // context. The result replaces the textarea content. Truth Contract holds:
  // the AI is told not to add claims the user didn't make.
  async function handleElaborate(q: FactBaseGapResult["questions"][number]) {
    const fragment = (answers[q.id] ?? "").trim();
    if (!fragment) return;
    setElaborateError((e) => ({ ...e, [q.id]: "" }));
    setElaborating((s) => ({ ...s, [q.id]: true }));
    try {
      const r = await elaborateGapAnswer({
        questionText: q.text,
        userFragment: fragment,
        cvId,
        targetRoleFamily: targetRoleFamily || null,
      });
      if (r.error) {
        setElaborateError((e) => ({ ...e, [q.id]: r.error ?? "Elaborate failed." }));
        return;
      }
      if (r.elaborated) {
        setAnswers((a) => ({ ...a, [q.id]: r.elaborated! }));
      }
    } catch (e) {
      setElaborateError((er) => ({
        ...er,
        [q.id]: e instanceof Error ? e.message : "Elaborate failed.",
      }));
    } finally {
      setElaborating((s) => ({ ...s, [q.id]: false }));
    }
  }

  const answeredCount = gapResult.questions.filter(
    (q) => !skipped[q.id] && (answers[q.id] ?? "").trim().length > 0
  ).length;
  const allAnsweredOrSkipped = gapResult.questions.every(
    (q) => skipped[q.id] || (answers[q.id] ?? "").trim().length > 0
  );

  function handleSubmit(skipAll: boolean) {
    setError(null);
    const payload = {
      answers: skipAll
        ? []
        : gapResult.questions
            .filter((q) => !skipped[q.id])
            .map((q) => ({
              question: q.text,
              answer: (answers[q.id] ?? "").trim(),
            }))
            .filter((a) => a.answer.length > 0),
      persistToSkills: skipAll ? false : persistToSkills,
    };
    startSubmit(async () => {
      try {
        await onSubmit(payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Submission failed.");
      }
    });
  }

  const disabled = isSubmitting || isGenerating;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-slate-900 text-lg inline-flex items-center gap-2">
              <Sparkles size={16} className="text-blue-500" />
              Strengthen your Profile evidence
            </h2>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              {!isDetecting && <CoverageBadge score={gapResult.coverageScore} />}
              {gapResult.reason && !isDetecting && (
                <span className="text-xs text-slate-500">{gapResult.reason}</span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={disabled}
            className="text-slate-400 hover:text-slate-700 p-1 disabled:opacity-30 shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isDetecting ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-600">
              <Loader2 size={28} className="text-blue-600 animate-spin mb-4" />
              <p className="text-sm font-medium">Analysing your FactBase…</p>
              <p className="text-xs text-slate-400 mt-1 max-w-md text-center">
                Checking whether your work history, skills, and achievements
                hold enough evidence to support a strong Master Profile.
              </p>
            </div>
          ) : (
            <>
              {/* Career-changer warning. Surfaces when the gap detector
                  classified the FactBase fit for the target family as
                  "transferable" (some bridges exist) or "minimal" (essentially
                  no overlap). The user gets an honest read on what the Profile
                  will look like and three options: continue with career-
                  changer framing, add evidence via gap questions, or
                  reconsider. The Profile generator forces the CAREER-CHANGER
                  template downstream so the output reflects the pivot
                  honestly. */}
              {(gapResult.factbaseFitForFamily === "transferable" ||
                gapResult.factbaseFitForFamily === "minimal") && (
                <div
                  className={`mb-4 rounded-xl border p-4 ${
                    gapResult.factbaseFitForFamily === "minimal"
                      ? "border-rose-200 bg-rose-50/60"
                      : "border-amber-200 bg-amber-50/60"
                  }`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <AlertCircle
                      size={14}
                      className={`mt-0.5 shrink-0 ${
                        gapResult.factbaseFitForFamily === "minimal"
                          ? "text-rose-600"
                          : "text-amber-600"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-xs font-bold uppercase tracking-wider ${
                          gapResult.factbaseFitForFamily === "minimal"
                            ? "text-rose-800"
                            : "text-amber-800"
                        }`}
                      >
                        {gapResult.factbaseFitForFamily === "minimal"
                          ? "Career change — minimal FactBase overlap"
                          : "Career change — transferable evidence only"}
                      </div>
                      <p
                        className={`text-xs leading-relaxed mt-1 ${
                          gapResult.factbaseFitForFamily === "minimal"
                            ? "text-rose-900"
                            : "text-amber-900"
                        }`}
                      >
                        {targetRoleFamily ? (
                          <>
                            You&apos;re targeting{" "}
                            <span className="font-semibold">{targetRoleFamily}</span>
                            , but your FactBase has{" "}
                            {gapResult.factbaseFitForFamily === "minimal"
                              ? "essentially no direct evidence"
                              : "no direct evidence (only transferable skills)"}{" "}
                            for that field.
                          </>
                        ) : (
                          <>
                            Your FactBase has{" "}
                            {gapResult.factbaseFitForFamily === "minimal"
                              ? "essentially no direct evidence"
                              : "no direct evidence (only transferable skills)"}{" "}
                            for the target family.
                          </>
                        )}{" "}
                        The system will produce a <strong>career-changer Profile</strong>{" "}
                        that explicitly frames the pivot and leads with the
                        transferable skills you DO have — not a confident-
                        sounding Profile pretending you&apos;ve done this work
                        before.{" "}
                        {gapResult.factbaseFitForFamily === "minimal" ? (
                          <>
                            Realistic conversion to interview is{" "}
                            <strong>low</strong> for senior roles; better for
                            graduate / training-contract entry points open to
                            pivots. Consider whether this is the right target,
                            or add specific evidence below.
                          </>
                        ) : (
                          <>
                            Conversion depends on the role&apos;s seniority and
                            openness to career-changers. Strongest below
                            director-level for roles that value analytical
                            structure + transferable skills.
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  {gapResult.transferableAngles.length > 0 && (
                    <div className="mt-3 pl-6">
                      <div
                        className={`text-[10px] font-semibold uppercase tracking-wider mb-1 ${
                          gapResult.factbaseFitForFamily === "minimal"
                            ? "text-rose-700"
                            : "text-amber-700"
                        }`}
                      >
                        Transferable angles we&apos;ll lead with
                      </div>
                      <ul
                        className={`text-xs space-y-0.5 ${
                          gapResult.factbaseFitForFamily === "minimal"
                            ? "text-rose-900"
                            : "text-amber-900"
                        }`}
                      >
                        {gapResult.transferableAngles.map((a, i) => (
                          <li key={i}>• {a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-600 leading-relaxed mb-4">
                {gapResult.factbaseFitForFamily === "transferable" ||
                gapResult.factbaseFitForFamily === "minimal"
                  ? "Answering these questions surfaces specific bridges from your existing work to the target field. The more you can add, the stronger the career-changer pitch — one or two sentences each is enough. Skip anything that doesn't apply."
                  : "Your FactBase is a bit light in places — answering these quick questions gives the AI stronger material to work with. One or two sentences each is enough. Skip anything that doesn't apply."}
              </p>

              {gapResult.gaps.length > 0 && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-1">
                    Gaps detected
                  </div>
                  <ul className="text-xs text-amber-900 space-y-0.5">
                    {gapResult.gaps.map((g, i) => (
                      <li key={i}>• {g}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-4">
                {gapResult.questions.map((q, i) => {
                  const isSkipped = !!skipped[q.id];
                  return (
                    <div
                      key={q.id}
                      className={`rounded-xl border p-4 transition-colors ${
                        isSkipped
                          ? "border-slate-200 bg-slate-50/60"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                            Question {i + 1}
                          </div>
                          <div
                            className={`text-sm leading-relaxed ${
                              isSkipped ? "text-slate-400" : "text-slate-800"
                            }`}
                          >
                            {q.text}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            setSkipped((s) => ({ ...s, [q.id]: !s[q.id] }))
                          }
                          disabled={disabled}
                          className={`text-[10px] font-medium px-2 py-1 rounded-md border transition-colors shrink-0 disabled:opacity-40 ${
                            isSkipped
                              ? "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                              : "border-slate-200 bg-white text-slate-400 hover:text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          {isSkipped ? "Un-skip" : "Skip"}
                        </button>
                      </div>
                      {!isSkipped && (
                        <>
                          {q.suggestedAnswer && (answers[q.id] ?? "") === q.suggestedAnswer ? (
                            <div className="mb-1.5 flex items-center justify-between gap-2 flex-wrap">
                              <div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                                <Wand2 size={10} /> Drafted from your FactBase
                                <span className="text-slate-400 font-normal normal-case tracking-normal ml-1">
                                  — accept, edit, or write your own
                                </span>
                              </div>
                              <button
                                onClick={() =>
                                  setAnswers((a) => ({ ...a, [q.id]: "" }))
                                }
                                disabled={disabled}
                                className="text-[10px] text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline disabled:opacity-40"
                                title="Clear the draft and type your own answer"
                              >
                                Clear draft
                              </button>
                            </div>
                          ) : (
                            // No FactBase signal for this gap — explicit hint
                            // so the user knows the empty textarea is BY DESIGN,
                            // not a system failure. We don't pre-fill here
                            // because guessing would be fabrication.
                            !q.suggestedAnswer && (
                              <div className="mb-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                                <AlertCircle size={10} /> No FactBase signal yet
                                <span className="text-slate-400 font-normal normal-case tracking-normal ml-1">
                                  — please type your honest answer (or skip if it doesn&apos;t apply)
                                </span>
                              </div>
                            )
                          )}
                          <textarea
                            value={answers[q.id] ?? ""}
                            onChange={(e) =>
                              setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                            }
                            disabled={disabled || elaborating[q.id]}
                            placeholder={q.example ? `e.g. ${q.example}` : "Your answer (1-2 sentences)…"}
                            rows={3}
                            className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300 disabled:opacity-50 ${
                              q.suggestedAnswer && (answers[q.id] ?? "") === q.suggestedAnswer
                                ? "border-blue-200 bg-blue-50/30"
                                : "border-slate-200"
                            }`}
                          />
                          {/* Elaborate-with-AI button — for users who type a
                              short / rough answer and want it fleshed out
                              into proper CV register. Disabled when textarea
                              is empty. Truth Contract: the AI is told not to
                              add claims the user didn't make. */}
                          <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
                            <button
                              onClick={() => handleElaborate(q)}
                              disabled={
                                disabled ||
                                elaborating[q.id] ||
                                !(answers[q.id] ?? "").trim()
                              }
                              className="text-[10px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                              title={
                                (answers[q.id] ?? "").trim()
                                  ? "Type a few rough words and click — the AI fleshes it out into a polished version, drawn from your FactBase"
                                  : "Type a few words first, then click to flesh out"
                              }
                            >
                              {elaborating[q.id] ? (
                                <>
                                  <Loader2 size={10} className="animate-spin" /> Elaborating…
                                </>
                              ) : (
                                <>
                                  <Wand2 size={10} /> Elaborate with AI
                                </>
                              )}
                            </button>
                            {elaborateError[q.id] && (
                              <span className="text-[10px] text-rose-700 inline-flex items-center gap-1">
                                <AlertCircle size={10} /> {elaborateError[q.id]}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {gapResult.questions.length === 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-900">
                  Your FactBase already has strong coverage. No gap questions to
                  ask — proceed straight to generation.
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-slate-100">
                <label className="flex items-start gap-2 text-xs text-slate-700 leading-relaxed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={persistToSkills}
                    onChange={(e) => setPersistToSkills(e.target.checked)}
                    disabled={disabled}
                    className="mt-0.5 shrink-0 accent-blue-600 disabled:opacity-50"
                  />
                  <span>
                    <span className="font-semibold">
                      Save these answers to my Skills
                    </span>{" "}
                    <span className="text-slate-500">
                      so every future Profile and CV generation benefits from
                      this evidence — not just this one. You can edit or
                      remove them from the Skills section later.
                    </span>
                  </span>
                </label>
              </div>

              {error && (
                <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
                  <AlertCircle size={11} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!isDetecting && (
          <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-between gap-3 flex-wrap shrink-0">
            <div className="text-[11px] text-slate-500">
              {gapResult.questions.length > 0 && (
                <>
                  {answeredCount} of {gapResult.questions.length} answered
                  {Object.values(skipped).filter(Boolean).length > 0 && (
                    <>
                      {" · "}
                      {Object.values(skipped).filter(Boolean).length} skipped
                    </>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleSubmit(true)}
                disabled={disabled}
                className="text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
              >
                Skip and generate anyway
              </button>
              <button
                onClick={() => handleSubmit(false)}
                disabled={
                  disabled ||
                  (gapResult.questions.length > 0 && answeredCount === 0)
                }
                className="text-xs font-semibold inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                title={
                  gapResult.questions.length > 0 && answeredCount === 0
                    ? "Answer at least one question first, or use 'Skip and generate anyway'"
                    : undefined
                }
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Generating Profile…
                  </>
                ) : isSubmitting ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    <Check size={12} />
                    {allAnsweredOrSkipped && answeredCount > 0
                      ? "Generate Profile with my answers"
                      : "Generate Profile"}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
