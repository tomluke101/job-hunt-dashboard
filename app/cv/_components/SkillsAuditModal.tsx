"use client";

// Pre-flight Skills audit modal for the CV Builder.
//
// Renders when the system has detected JD-required skills MISSING from the
// user's FactBase / Skills Library, OR vague items in the user's current
// Skills section that could be specified with named tools.
//
// UX optimised for SPEED:
//   - Tickboxes for missing JD skills (one-click each)
//   - Tickboxes for vague-item specifications (Claude Code, ChatGPT, etc.)
//   - One free-text field for anything else
//   - "Skip and tailor anyway" escape hatch
//   - Submit persists answers to user_skills Library AND passes them as
//     wizardContext to the current tailor call
//
// Friction budget: 30 seconds end-to-end. NOT essay questions like the
// Profile gap modal — this is the "JD asks for these, tick what you have"
// flow Tom asked for.

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import type { SkillsMatchResult } from "@/app/actions/cv-tailoring";

interface Props {
  matchResult: SkillsMatchResult;
  isAuditing?: boolean;
  isGenerating?: boolean;
  // User's submitted answers when they click "Tailor". Includes:
  //   - confirmedSkills: tickbox-selected items from the missing-JD-skills list
  //   - vagueSpecifications: tickbox-selected items per vague item
  //   - additionalSkills: free-text additions (one per line)
  //   - persistToLibrary: whether to save confirmed skills to user_skills
  onSubmit: (payload: {
    confirmedSkills: string[];
    vagueSpecifications: Array<{ vagueItem: string; specifics: string[] }>;
    additionalSkills: string[];
    persistToLibrary: boolean;
  }) => void;
  onClose: () => void;
}

export default function SkillsAuditModal({
  matchResult,
  isAuditing = false,
  isGenerating = false,
  onSubmit,
  onClose,
}: Props) {
  // Tick state for each missing JD skill. Default: unchecked. User explicitly
  // ticks the ones they DO have (with honest evidence).
  const [confirmedMissing, setConfirmedMissing] = useState<Record<string, boolean>>({});
  // Tick state for each vague-item's suggested specifications. Keyed by
  // "vagueItem|specific" for unique-per-row identity.
  const [confirmedSpecifics, setConfirmedSpecifics] = useState<Record<string, boolean>>({});
  // Free-text additions — one per line, parsed on submit.
  const [additionalText, setAdditionalText] = useState("");
  // Persist toggle — defaults FALSE so users don't accidentally pollute
  // their Skills Library with JD-specific terms (e.g. "SPEEDY" only matters
  // for JLR) or duplicates. Library should be curated by the user
  // intentionally via the Profile page, OR opt in here when the confirmed
  // skills are genuinely transferable across applications.
  const [persistToLibrary, setPersistToLibrary] = useState(false);
  // Per-section collapse state.
  const [missingOpen, setMissingOpen] = useState(true);
  const [vagueOpen, setVagueOpen] = useState(true);
  const [matchedOpen, setMatchedOpen] = useState(false);
  const [isSubmitting, startSubmit] = useTransition();

  // When the matchResult changes (modal opened with fresh data), reset state.
  useEffect(() => {
    setConfirmedMissing({});
    setConfirmedSpecifics({});
    setAdditionalText("");
  }, [matchResult]);

  const disabled = isSubmitting || isGenerating || isAuditing;

  const tickedMissingCount = useMemo(
    () => Object.values(confirmedMissing).filter(Boolean).length,
    [confirmedMissing]
  );
  const tickedSpecificsCount = useMemo(
    () => Object.values(confirmedSpecifics).filter(Boolean).length,
    [confirmedSpecifics]
  );
  const additionalCount = additionalText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;
  const totalTicked = tickedMissingCount + tickedSpecificsCount + additionalCount;

  const bandConfig = {
    high: {
      label: "Strong fit",
      bg: "bg-emerald-50/70 border-emerald-200",
      text: "text-emerald-900",
      accent: "text-emerald-700",
      scoreBg: "bg-emerald-600",
    },
    medium: {
      label: "Partial fit",
      bg: "bg-amber-50/70 border-amber-200",
      text: "text-amber-900",
      accent: "text-amber-700",
      scoreBg: "bg-amber-500",
    },
    low: {
      label: "Limited fit",
      bg: "bg-rose-50/70 border-rose-200",
      text: "text-rose-900",
      accent: "text-rose-700",
      scoreBg: "bg-rose-600",
    },
  }[matchResult.matchBand];

  function handleSubmit(skipAll: boolean) {
    const confirmedSkills = skipAll
      ? []
      : Object.entries(confirmedMissing)
          .filter(([, v]) => v)
          .map(([k]) => k);
    const vagueSpecifications = skipAll
      ? []
      : matchResult.vague
          .map((v) => ({
            vagueItem: v.vagueItem,
            specifics: v.specifySuggestions.filter(
              (s) => confirmedSpecifics[`${v.vagueItem}|${s}`]
            ),
          }))
          .filter((v) => v.specifics.length > 0);
    const additionalSkills = skipAll
      ? []
      : additionalText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
    startSubmit(() => {
      onSubmit({
        confirmedSkills,
        vagueSpecifications,
        additionalSkills,
        persistToLibrary,
      });
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-blue-500 shrink-0" />
              <h2 className="text-lg font-bold text-slate-900">
                Quick Skills check before tailoring
              </h2>
            </div>
            <button
              onClick={onClose}
              disabled={disabled}
              className="text-slate-400 hover:text-slate-700 disabled:opacity-40"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Match score badge — honest read on JD-vs-FactBase alignment */}
          <div className="mt-3 flex items-center gap-3">
            <div
              className={`shrink-0 w-10 h-10 rounded-lg ${bandConfig.scoreBg} text-white flex flex-col items-center justify-center leading-none`}
            >
              <div className="text-base font-bold">{matchResult.matchScore}</div>
              <div className="text-[7px] uppercase tracking-wider opacity-80">
                /100
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div
                className={`text-[10px] font-bold uppercase tracking-wider ${bandConfig.accent}`}
              >
                {bandConfig.label}: JD-vs-FactBase match
              </div>
              <p className={`text-xs leading-snug mt-0.5 ${bandConfig.text}`}>
                {matchResult.matched.length} of{" "}
                {matchResult.matched.length + matchResult.missing.length} JD skills
                already supported by your evidence. Tick anything you actually have from the lists below — your CV will surface them.
              </p>
            </div>
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {isAuditing ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-600">
              <Loader2 size={28} className="text-blue-600 animate-spin mb-4" />
              <p className="text-sm font-medium">Analysing the JD against your FactBase…</p>
              <p className="text-xs text-slate-400 mt-1 max-w-md text-center">
                Cross-referencing every required and desirable skill against your work history, achievements, and saved Skills Library.
              </p>
            </div>
          ) : (
            <>
              {/* Missing JD skills — tickbox list */}
              {matchResult.missing.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/40 overflow-hidden">
                  <button
                    onClick={() => setMissingOpen((v) => !v)}
                    className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-amber-100/40 transition-colors"
                  >
                    <AlertCircle size={13} className="text-amber-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-amber-800">
                        JD asks for these — your FactBase doesn&apos;t show them
                      </div>
                      <p className="text-xs text-amber-900 mt-0.5">
                        Tick anything you genuinely have, even informally. Skip what doesn&apos;t apply. {tickedMissingCount} ticked.
                      </p>
                    </div>
                    {missingOpen ? (
                      <ChevronUp size={14} className="text-amber-700 shrink-0" />
                    ) : (
                      <ChevronDown size={14} className="text-amber-700 shrink-0" />
                    )}
                  </button>
                  {missingOpen && (
                    <div className="px-3 pb-3 pt-1 space-y-1.5">
                      {matchResult.missing.map((skill) => (
                        <label
                          key={skill}
                          className={`flex items-start gap-2 text-xs cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
                            confirmedMissing[skill]
                              ? "bg-emerald-50 border border-emerald-200"
                              : "bg-white border border-amber-200 hover:bg-amber-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={!!confirmedMissing[skill]}
                            onChange={(e) =>
                              setConfirmedMissing((s) => ({
                                ...s,
                                [skill]: e.target.checked,
                              }))
                            }
                            disabled={disabled}
                            className="mt-0.5 shrink-0 disabled:opacity-40"
                          />
                          <span
                            className={`flex-1 min-w-0 leading-relaxed ${
                              confirmedMissing[skill]
                                ? "text-emerald-900 font-medium"
                                : "text-slate-800"
                            }`}
                          >
                            {skill}
                          </span>
                          {confirmedMissing[skill] && (
                            <Check size={12} className="text-emerald-600 shrink-0 mt-0.5" />
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Vague items — specify with named tools from FactBase */}
              {matchResult.vague.length > 0 && (
                <div className="rounded-xl border border-blue-200 bg-blue-50/40 overflow-hidden">
                  <button
                    onClick={() => setVagueOpen((v) => !v)}
                    className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-blue-100/40 transition-colors"
                  >
                    <Sparkles size={13} className="text-blue-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-blue-800">
                        Specify your tools (replaces vague items)
                      </div>
                      <p className="text-xs text-blue-900 mt-0.5">
                        Tick the named tools you actually use. {tickedSpecificsCount} ticked.
                      </p>
                    </div>
                    {vagueOpen ? (
                      <ChevronUp size={14} className="text-blue-700 shrink-0" />
                    ) : (
                      <ChevronDown size={14} className="text-blue-700 shrink-0" />
                    )}
                  </button>
                  {vagueOpen && (
                    <div className="px-3 pb-3 pt-1 space-y-3">
                      {matchResult.vague.map((v) => (
                        <div key={v.vagueItem}>
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-700 mb-1">
                            Current: &quot;{v.vagueItem}&quot; → specify
                          </div>
                          <div className="space-y-1">
                            {v.specifySuggestions.map((s) => {
                              const key = `${v.vagueItem}|${s}`;
                              return (
                                <label
                                  key={key}
                                  className={`flex items-start gap-2 text-xs cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
                                    confirmedSpecifics[key]
                                      ? "bg-emerald-50 border border-emerald-200"
                                      : "bg-white border border-blue-200 hover:bg-blue-50"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={!!confirmedSpecifics[key]}
                                    onChange={(e) =>
                                      setConfirmedSpecifics((s) => ({
                                        ...s,
                                        [key]: e.target.checked,
                                      }))
                                    }
                                    disabled={disabled}
                                    className="mt-0.5 shrink-0 disabled:opacity-40"
                                  />
                                  <span
                                    className={`flex-1 min-w-0 leading-relaxed ${
                                      confirmedSpecifics[key]
                                        ? "text-emerald-900 font-medium"
                                        : "text-slate-800"
                                    }`}
                                  >
                                    {s}
                                  </span>
                                  {confirmedSpecifics[key] && (
                                    <Check size={12} className="text-emerald-600 shrink-0 mt-0.5" />
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Free-text additions */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-700 mb-1">
                  Anything else? (one skill per line, optional)
                </div>
                <p className="text-xs text-slate-600 mb-2">
                  Specific tools, methodologies, certifications, or projects from your experience that you want on this CV.
                </p>
                <textarea
                  value={additionalText}
                  onChange={(e) => setAdditionalText(e.target.value)}
                  disabled={disabled}
                  placeholder={"e.g. SAP IBP\nOTIF tracking\nClaude Code (CV automation)"}
                  rows={3}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300 disabled:opacity-50"
                />
                {additionalCount > 0 && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    {additionalCount} item{additionalCount === 1 ? "" : "s"} to add
                  </p>
                )}
              </div>

              {/* Matched skills — informational collapse */}
              {matchResult.matched.length > 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 overflow-hidden">
                  <button
                    onClick={() => setMatchedOpen((v) => !v)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-emerald-100/30 transition-colors"
                  >
                    <Target size={12} className="text-emerald-600 shrink-0" />
                    <span className="flex-1 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                      {matchResult.matched.length} JD skills already in your evidence
                    </span>
                    {matchedOpen ? (
                      <ChevronUp size={12} className="text-emerald-700 shrink-0" />
                    ) : (
                      <ChevronDown size={12} className="text-emerald-700 shrink-0" />
                    )}
                  </button>
                  {matchedOpen && (
                    <div className="px-3 pb-2 pt-0.5 space-y-1">
                      {matchResult.matched.map((m, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 text-[11px] text-emerald-900"
                        >
                          <Check size={10} className="text-emerald-600 shrink-0 mt-0.5" />
                          <span className="flex-1 min-w-0">
                            <span className="font-medium">{m.jdSkill}</span>
                            <span className="text-emerald-700/70 ml-1">
                              — {m.librarySource}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Persist toggle — OFF by default so users don't pollute
                  their Library with JD-specific terms or duplicates. */}
              <label className="flex items-start gap-2 text-xs text-slate-700 leading-relaxed cursor-pointer pt-2 border-t border-slate-100">
                <input
                  type="checkbox"
                  checked={persistToLibrary}
                  onChange={(e) => setPersistToLibrary(e.target.checked)}
                  disabled={disabled}
                  className="mt-0.5 disabled:opacity-40"
                />
                <span>
                  <span className="font-semibold">Also save these to my Skills Library</span>{" "}
                  (off by default — only tick if these skills are transferable across future applications, not JD-specific terms like &quot;SPEEDY&quot; or &quot;SSDS&quot;).
                </span>
              </label>
            </>
          )}
        </div>

        {/* Footer — actions */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs text-slate-500">
            {totalTicked} item{totalTicked === 1 ? "" : "s"} to add
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSubmit(true)}
              disabled={disabled}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 disabled:opacity-40"
            >
              Skip and tailor anyway
            </button>
            <button
              onClick={() => handleSubmit(false)}
              disabled={disabled || isAuditing}
              className="text-xs font-semibold inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {isSubmitting || isGenerating ? (
                <>
                  <Loader2 size={11} className="animate-spin" /> Tailoring…
                </>
              ) : (
                <>
                  <Check size={11} /> Tailor with these skills
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
