"use client";

import { useState, useTransition, useEffect } from "react";
import { Sparkles, Check, X, Loader2 } from "lucide-react";
import { refineCoverLetter, type SkillGap } from "@/app/actions/cover-letters";
import { addSkill, polishSkillText } from "@/app/actions/profile";

type Level = "yes" | "sortof" | "no" | null;

interface Answer {
  level: Level;
  context: string;
  save: boolean;
}

interface Props {
  gaps: SkillGap[];
  jobDescription: string;
  currentLetter: string;
  onLetterUpdated: (text: string, provider: string) => void;
  onDisable: () => void;
  onClose: () => void;
}

export default function SkillDiscovery({ gaps, jobDescription, currentLetter, onLetterUpdated, onDisable, onClose }: Props) {
  const [isVisible, setIsVisible] = useState(false);
  const [answers, setAnswers] = useState<Record<string, Answer>>(
    Object.fromEntries(gaps.map((g) => [g.id, { level: null as Level, context: "", save: true }]))
  );
  const [isUpdating, startUpdate] = useTransition();
  const [done, setDone] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setIsVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  function close() {
    setIsVisible(false);
    setTimeout(onClose, 320);
  }

  const activeWithContext = gaps.filter(
    g => (answers[g.id]?.level === "yes" || answers[g.id]?.level === "sortof") && answers[g.id]?.context.trim()
  );
  const toSaveCount = activeWithContext.filter(g => answers[g.id].save).length;

  function setLevel(id: string, level: Level) {
    setAnswers(a => ({ ...a, [id]: { ...a[id], level } }));
  }

  function setContext(id: string, val: string) {
    setAnswers(a => ({ ...a, [id]: { ...a[id], context: val } }));
  }

  function toggleSave(id: string) {
    setAnswers(a => ({ ...a, [id]: { ...a[id], save: !a[id].save } }));
  }

  function handleStrengthen() {
    if (!activeWithContext.length) return;
    startUpdate(async () => {
      const additions = activeWithContext
        .map(g => `- ${g.skill} (${answers[g.id].level === "sortof" ? "adjacent experience" : "direct experience"}): ${answers[g.id].context.trim()}`)
        .join("\n");

      const updatePromise = refineCoverLetter({
        originalLetter: currentLetter,
        refinementRequest: `Weave in the following experience naturally. For "direct experience" mention it with confidence; for "adjacent experience" draw the parallel without overclaiming:\n${additions}`,
        jobDescription,
      });

      const toSave = activeWithContext.filter(g => answers[g.id].save);
      const savePromises = toSave.map(async g => {
        const raw = answers[g.id].context.trim();
        try {
          const polished = await polishSkillText(raw);
          await addSkill(raw, polished);
        } catch {
          await addSkill(raw);
        }
      });

      const [result] = await Promise.all([updatePromise, Promise.allSettled(savePromises)]);
      onLetterUpdated(result.text, result.provider);
      setSavedCount(toSave.length);
      setDone(true);
      setTimeout(close, 2200);
    });
  }

  if (gaps.length === 0) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/40 z-40 transition-opacity duration-300 ${isVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={close}
      />

      {/* Bottom sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 transition-transform duration-300 ease-out ${isVisible ? "translate-y-0" : "translate-y-full"}`}
      >
        <div className="bg-white rounded-t-3xl shadow-2xl max-h-[78vh] flex flex-col">

          {/* Drag handle */}
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="w-10 h-1 bg-slate-200 rounded-full" />
          </div>

          {/* Header */}
          <div className="px-6 pt-3 pb-4 flex items-start justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shrink-0">
                <Sparkles size={16} className="text-white" />
              </div>
              <div>
                <h2 className="font-bold text-slate-900 text-base">
                  {done
                    ? "Letter strengthened"
                    : `We spotted ${gaps.length} hidden strength${gaps.length !== 1 ? "s" : ""}`}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {done
                    ? savedCount > 0
                      ? `${savedCount} skill${savedCount !== 1 ? "s" : ""} saved to your profile — every future letter just got smarter`
                      : "Your letter has been updated"
                    : "30 seconds · strengthens this letter and every future one"}
                </p>
              </div>
            </div>
            {!done && (
              <button onClick={close} className="text-slate-400 hover:text-slate-600 mt-0.5 transition-colors">
                <X size={18} />
              </button>
            )}
          </div>

          {/* Done state */}
          {done && (
            <div className="px-6 pb-8 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center shrink-0">
                <Check size={18} className="text-emerald-600" />
              </div>
              <p className="text-sm text-emerald-700 font-medium">
                {savedCount > 0
                  ? `Your profile now knows about ${savedCount} new skill${savedCount !== 1 ? "s" : ""}. The more you apply, the smarter this gets.`
                  : "Your cover letter has been updated."}
              </p>
            </div>
          )}

          {/* Skills + footer */}
          {!done && (
            <>
              <div className="flex-1 overflow-y-auto px-6 space-y-3 pb-2">
                {gaps.map(gap => {
                  const ans = answers[gap.id];
                  const isActive = ans.level === "yes" || ans.level === "sortof";
                  const isDismissed = ans.level === "no";

                  return (
                    <div
                      key={gap.id}
                      className={`rounded-2xl border p-4 transition-all duration-200 ${
                        isDismissed
                          ? "opacity-40 border-slate-100 bg-slate-50"
                          : isActive
                          ? "border-blue-200 bg-blue-50/40"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <p className="text-sm font-semibold text-slate-800 mb-1">{gap.question}</p>
                      <p className="text-xs text-slate-400 italic mb-3">From the JD: &ldquo;{gap.jd_context}&rdquo;</p>

                      {!isActive && !isDismissed && (
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={() => setLevel(gap.id, "yes")}
                            className="text-sm font-semibold px-4 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors"
                          >
                            I&apos;ve done this
                          </button>
                          <button
                            onClick={() => setLevel(gap.id, "sortof")}
                            className="text-sm font-semibold px-4 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors"
                          >
                            Sort of
                          </button>
                          <button
                            onClick={() => setLevel(gap.id, "no")}
                            className="text-sm font-medium px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-400 hover:bg-slate-50 transition-colors"
                          >
                            I haven&apos;t
                          </button>
                        </div>
                      )}

                      {isDismissed && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">Skipped</span>
                          <button
                            onClick={() => setLevel(gap.id, null)}
                            className="text-xs text-blue-500 hover:underline"
                          >
                            undo
                          </button>
                        </div>
                      )}

                      {isActive && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1 ${
                              ans.level === "yes"
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-amber-100 text-amber-700"
                            }`}>
                              <Check size={10} />
                              {ans.level === "yes" ? "I've done this" : "Sort of"}
                            </span>
                            <button
                              onClick={() => setLevel(gap.id, null)}
                              className="text-slate-300 hover:text-slate-500 transition-colors"
                            >
                              <X size={12} />
                            </button>
                          </div>

                          <textarea
                            autoFocus
                            value={ans.context}
                            onChange={e => setContext(gap.id, e.target.value)}
                            placeholder={
                              ans.level === "yes"
                                ? `e.g. "Built weekly Excel reports at Siemens tracking KPIs across 12 markets for the L&D team"`
                                : `e.g. "Covered comparable analysis in my degree — haven't used it professionally yet"`
                            }
                            rows={2}
                            className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300 bg-white"
                          />

                          <label className="flex items-center gap-2.5 cursor-pointer select-none">
                            <button
                              type="button"
                              onClick={() => toggleSave(gap.id)}
                              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${ans.save ? "bg-blue-500" : "bg-slate-200"}`}
                            >
                              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${ans.save ? "translate-x-4" : "translate-x-0.5"}`} />
                            </button>
                            <span className="text-xs text-slate-500">
                              Save to my profile{" "}
                              <span className="text-slate-400">— makes every future letter smarter</span>
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="px-6 pt-4 pb-6 border-t border-slate-100 shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={close}
                    className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={handleStrengthen}
                    disabled={!activeWithContext.length || isUpdating}
                    className="flex items-center gap-2 text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-6 py-3 rounded-2xl transition-colors shadow-sm"
                  >
                    {isUpdating ? (
                      <><Loader2 size={14} className="animate-spin" /> Strengthening…</>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        Strengthen my letter{toSaveCount > 0 ? ` + save ${toSaveCount}` : ""}
                      </>
                    )}
                  </button>
                </div>
                <p className="text-center text-xs text-slate-300">
                  Not finding this useful?{" "}
                  <button
                    onClick={onDisable}
                    className="underline hover:text-slate-400 transition-colors"
                  >
                    Turn off skill discovery
                  </button>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
