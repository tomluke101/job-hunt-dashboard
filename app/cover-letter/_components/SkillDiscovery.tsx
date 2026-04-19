"use client";

import { useState, useTransition } from "react";
import { Sparkles, Check, ChevronDown, ChevronUp, X, Loader2, Plus, BookOpen } from "lucide-react";
import { refineCoverLetter, type SkillGap } from "@/app/actions/cover-letters";
import { addSkill, polishSkillText } from "@/app/actions/profile";

interface Answer {
  yes: boolean;
  context: string;
}

interface Props {
  gaps: SkillGap[];
  jobDescription: string;
  currentLetter: string;
  onLetterUpdated: (text: string, provider: string) => void;
  onDisable: () => void;
}

export default function SkillDiscovery({ gaps, jobDescription, currentLetter, onLetterUpdated, onDisable }: Props) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(
    Object.fromEntries(gaps.map((g) => [g.id, { yes: false, context: "" }]))
  );
  const [expanded, setExpanded] = useState(true);
  const [isUpdating, startUpdate] = useTransition();
  const [updated, setUpdated] = useState(false);

  // Save-to-profile state per gap
  const [savedIds, setSavedIds]         = useState<Set<string>>(new Set());
  const [skippedIds, setSkippedIds]     = useState<Set<string>>(new Set());
  const [polishingId, setPolishingId]   = useState<string | null>(null);
  const [polishedTexts, setPolishedTexts] = useState<Record<string, string>>({});
  const [savingId, setSavingId]         = useState<string | null>(null);
  const [, startSaving]                 = useTransition();

  const yesAnswers = gaps.filter((g) => answers[g.id]?.yes && answers[g.id]?.context.trim());
  const anyAnswered = yesAnswers.length > 0;

  // All yes-answers either saved or skipped
  const saveActionsDone = yesAnswers.length > 0 && yesAnswers.every(
    (g) => savedIds.has(g.id) || skippedIds.has(g.id)
  );

  function setYes(id: string, val: boolean) {
    setAnswers((a) => ({ ...a, [id]: { ...a[id], yes: val } }));
  }

  function setContext(id: string, val: string) {
    setAnswers((a) => ({ ...a, [id]: { ...a[id], context: val } }));
  }

  function handleUpdate() {
    if (!anyAnswered) return;
    const additions = yesAnswers
      .map((g) => `- ${g.skill}: ${answers[g.id].context.trim()}`)
      .join("\n");

    startUpdate(async () => {
      const result = await refineCoverLetter({
        originalLetter: currentLetter,
        refinementRequest: `Incorporate the following additional experience into the letter naturally — weave it in where it strengthens the case, don't force it or announce it:\n${additions}`,
        jobDescription,
      });
      onLetterUpdated(result.text, result.provider);
      setUpdated(true);
    });
  }

  async function handlePolishAndSave(gap: SkillGap) {
    const raw = answers[gap.id].context.trim();
    if (!raw) return;
    setPolishingId(gap.id);
    try {
      const polished = await polishSkillText(raw);
      setPolishedTexts((p) => ({ ...p, [gap.id]: polished }));
      setSavingId(gap.id);
      startSaving(async () => {
        await addSkill(raw, polished);
        setSavedIds((s) => new Set([...s, gap.id]));
        setSavingId(null);
      });
    } finally {
      setPolishingId(null);
    }
  }

  function handleSaveAsIs(gap: SkillGap) {
    const raw = answers[gap.id].context.trim();
    if (!raw) return;
    setSavingId(gap.id);
    startSaving(async () => {
      await addSkill(raw);
      setSavedIds((s) => new Set([...s, gap.id]));
      setSavingId(null);
    });
  }

  if (gaps.length === 0) return null;

  return (
    <div className={`rounded-2xl border shadow-sm overflow-hidden ${updated && !saveActionsDone ? "border-blue-300 ring-2 ring-blue-100" : "border-blue-200"}`}>
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 transition-colors border-b border-blue-100"
      >
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <Sparkles size={14} className="text-white" />
          </div>
          <div className="text-left">
            <p className="font-semibold text-slate-900 text-sm">
              {updated && !saveActionsDone
                ? `Save ${yesAnswers.length} new skill${yesAnswers.length !== 1 ? "s" : ""} to your profile`
                : `We spotted ${gaps.length} thing${gaps.length !== 1 ? "s" : ""} in this JD you haven't mentioned`}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {updated && !saveActionsDone
                ? "Each skill you save makes future cover letters stronger — takes 10 seconds"
                : "Answer these quick questions to strengthen your letter"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!updated && (
            <button
              onClick={(e) => { e.stopPropagation(); onDisable(); }}
              className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded hover:bg-white/60 transition-colors"
            >
              Turn off
            </button>
          )}
          {expanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="bg-white p-6 space-y-5">

          {/* ── Phase 1: Q&A (before update) ── */}
          {!updated && (
            <>
              {gaps.map((gap) => {
                const ans = answers[gap.id];
                return (
                  <div key={gap.id} className="space-y-2">
                    <p className="text-sm font-medium text-slate-800">{gap.question}</p>
                    <p className="text-xs text-slate-400 italic">From JD: "{gap.jd_context}"</p>

                    {!ans.yes ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setYes(gap.id, true)}
                          className="text-sm font-medium px-4 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setYes(gap.id, false)}
                          className="text-sm font-medium px-4 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 transition-colors"
                        >
                          Skip
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Check size={10} /> Yes
                          </span>
                          <button onClick={() => setYes(gap.id, false)} className="text-slate-400 hover:text-slate-600">
                            <X size={12} />
                          </button>
                        </div>
                        <textarea
                          autoFocus
                          value={ans.context}
                          onChange={(e) => setContext(gap.id, e.target.value)}
                          placeholder={`Tell us briefly — e.g. "Created weekly PowerPoint reports for senior stakeholders at Siemens covering KPIs across 12 markets"`}
                          rows={2}
                          className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                <p className="text-xs text-slate-400">Only skills you answer "Yes" to will be added.</p>
                <button
                  onClick={handleUpdate}
                  disabled={!anyAnswered || isUpdating}
                  className="flex items-center gap-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-5 py-2 rounded-xl transition-colors"
                >
                  {isUpdating ? (
                    <><Loader2 size={14} className="animate-spin" /> Updating letter…</>
                  ) : (
                    <><Sparkles size={14} /> Update my cover letter</>
                  )}
                </button>
              </div>
            </>
          )}

          {/* ── Phase 2: Save to profile (after update) ── */}
          {updated && (
            <>
              {saveActionsDone ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600 font-medium py-2">
                  <Check size={16} />
                  Done — your profile is now stronger for future applications
                </div>
              ) : (
                <>
                  <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700 leading-relaxed">
                    <span className="font-semibold">Your cover letter has been updated.</span> Now save these skills to your profile — the AI will use them automatically in every future letter, getting sharper with every application.
                  </div>

                  <div className="space-y-3">
                    {yesAnswers.map((gap) => {
                      const isSaved   = savedIds.has(gap.id);
                      const isSkipped = skippedIds.has(gap.id);
                      const isPolishing = polishingId === gap.id;
                      const isSavingThis = savingId === gap.id;
                      const polished = polishedTexts[gap.id];

                      if (isSkipped) return null;

                      return (
                        <div key={gap.id} className={`rounded-xl border p-4 transition-all ${isSaved ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">{gap.skill}</p>
                              <p className="text-sm text-slate-700 leading-relaxed">{polished || answers[gap.id].context}</p>
                              {polished && (
                                <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
                                  <Sparkles size={10} /> AI-polished version
                                </p>
                              )}
                            </div>

                            {isSaved ? (
                              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-100 px-2.5 py-1 rounded-full shrink-0">
                                <Check size={11} /> Saved
                              </span>
                            ) : (
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  onClick={() => handlePolishAndSave(gap)}
                                  disabled={isPolishing || isSavingThis}
                                  className="flex items-center gap-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
                                >
                                  {isPolishing || isSavingThis ? (
                                    <><Loader2 size={11} className="animate-spin" /> {isPolishing ? "Polishing…" : "Saving…"}</>
                                  ) : (
                                    <><Sparkles size={11} /> Polish + Save</>
                                  )}
                                </button>
                                <button
                                  onClick={() => handleSaveAsIs(gap)}
                                  disabled={isPolishing || isSavingThis}
                                  className="text-xs text-slate-500 hover:text-slate-700 font-medium px-2.5 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 bg-white transition-colors"
                                >
                                  Save as-is
                                </button>
                                <button
                                  onClick={() => setSkippedIds((s) => new Set([...s, gap.id]))}
                                  className="text-slate-300 hover:text-slate-500 transition-colors"
                                  title="Skip"
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <BookOpen size={12} className="text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-400">Saved skills appear in your <a href="/profile" className="text-blue-500 hover:underline">Skills & Experience</a> and are used in every future cover letter.</p>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
