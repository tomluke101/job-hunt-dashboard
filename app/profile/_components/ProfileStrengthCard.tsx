"use client";

// Post-generation Profile strength assessment — honest score + realistic
// conversion ceiling + actionable improvement suggestions.
//
// Layout: compact by default. Top-level collapse hides everything below the
// score badge + one-line reason. Within the expanded view, each
// improvement shows TITLE only by default with a click-to-expand for the
// full detail. Keeps the card scannable without flooding the page.

import { useEffect, useState, useTransition } from "react";
import {
  AlertCircle,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  assessProfileStrength,
  type ProfileStrengthResult,
} from "@/app/actions/cv-tailoring";

interface Props {
  profile: string;
  targetRoleFamily?: string | null;
  targetSector?: string | null;
  cvId?: string;
  autoRun?: boolean;
}

export default function ProfileStrengthCard({
  profile,
  targetRoleFamily,
  targetSector,
  cvId,
  autoRun = true,
}: Props) {
  const [result, setResult] = useState<ProfileStrengthResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAssessing, startAssess] = useTransition();
  const [assessedFor, setAssessedFor] = useState<string>("");
  // Top-level collapse — default CLOSED so the card stays out of the way.
  // User clicks the score header to expand and read the assessment + see
  // improvement suggestions. Keeps the Profile page tight.
  const [expanded, setExpanded] = useState(false);
  // Per-improvement expand state. Key = improvement index, value = true if
  // detail is shown. Default closed; user clicks the title to reveal.
  const [openImprovements, setOpenImprovements] = useState<Record<number, boolean>>({});

  function runAssessment() {
    if (!profile.trim()) return;
    setError(null);
    startAssess(async () => {
      const r = await assessProfileStrength({
        profile,
        targetRoleFamily: targetRoleFamily ?? null,
        targetSector: targetSector ?? null,
        cvId,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      if (r.result) {
        setResult(r.result);
        setAssessedFor(profile);
        setOpenImprovements({});
      }
    });
  }

  useEffect(() => {
    if (!autoRun) return;
    if (!profile.trim()) return;
    if (profile === assessedFor) return;
    runAssessment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, autoRun]);

  // Initial state — nothing assessed yet, autoRun off.
  if (!result && !isAssessing && !error) {
    return (
      <button
        onClick={runAssessment}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
      >
        <Sparkles size={12} /> Assess this Profile&apos;s strength
      </button>
    );
  }

  if (isAssessing) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 inline-flex items-center gap-2 text-xs text-slate-600">
        <Loader2 size={12} className="animate-spin text-blue-600" />
        Assessing Profile strength
        {targetRoleFamily?.trim() ? (
          <>
            {" "}for{" "}
            <span className="font-semibold">{targetRoleFamily.trim()}</span>
          </>
        ) : null}
        …
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2 text-xs text-rose-900 flex items-start gap-2">
        <AlertCircle size={14} className="text-rose-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Strength assessment failed</div>
          <div className="mt-0.5">{error}</div>
          <button
            onClick={runAssessment}
            className="text-rose-700 underline-offset-2 hover:underline font-medium mt-1"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const bandConfig = {
    weak: {
      label: "Weak",
      bg: "bg-rose-50/70 border-rose-200",
      text: "text-rose-900",
      accent: "text-rose-700",
      scoreBg: "bg-rose-600",
    },
    moderate: {
      label: "Moderate",
      bg: "bg-amber-50/70 border-amber-200",
      text: "text-amber-900",
      accent: "text-amber-700",
      scoreBg: "bg-amber-500",
    },
    competitive: {
      label: "Competitive",
      bg: "bg-blue-50/70 border-blue-200",
      text: "text-blue-900",
      accent: "text-blue-700",
      scoreBg: "bg-blue-600",
    },
    strong: {
      label: "Strong",
      bg: "bg-emerald-50/70 border-emerald-200",
      text: "text-emerald-900",
      accent: "text-emerald-700",
      scoreBg: "bg-emerald-600",
    },
  }[result.band];

  const impactConfig = {
    high: {
      label: "High impact",
      icon: <Zap size={9} />,
      cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
    },
    medium: {
      label: "Medium",
      icon: <TrendingUp size={9} />,
      cls: "bg-blue-100 text-blue-800 border-blue-200",
    },
    low: {
      label: "Polish",
      icon: <ArrowUp size={9} />,
      cls: "bg-slate-100 text-slate-700 border-slate-200",
    },
  };

  return (
    <div className={`rounded-xl border ${bandConfig.bg} overflow-hidden`}>
      {/* Header — always visible. Clickable to expand/collapse the body. */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left hover:bg-black/[0.02] transition-colors"
      >
        <div
          className={`shrink-0 w-9 h-9 rounded-lg ${bandConfig.scoreBg} text-white flex flex-col items-center justify-center leading-none`}
          title={`Strength score${
            targetRoleFamily?.trim() ? ` for ${targetRoleFamily.trim()}` : ""
          }`}
        >
          <div className="text-base font-bold">{result.score}</div>
          <div className="text-[7px] uppercase tracking-wider opacity-80">
            /10
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-[10px] font-bold uppercase tracking-wider ${bandConfig.accent}`}>
            {bandConfig.label} fit
            {targetRoleFamily?.trim() ? (
              <>
                {" "}for{" "}
                <span className="font-semibold">{targetRoleFamily.trim()}</span>
              </>
            ) : null}
          </div>
          {result.reason && (
            <p
              className={`text-xs leading-snug mt-0.5 ${bandConfig.text} ${
                expanded ? "" : "truncate"
              }`}
              title={!expanded ? result.reason : undefined}
            >
              {result.reason}
            </p>
          )}
        </div>
        <div className={`shrink-0 ${bandConfig.accent}`}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {/* Expanded body — conversion ceiling + improvements. */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-200/40">
          {result.conversionCeiling && (
            <div className="pt-3 pb-2">
              <div
                className={`text-[10px] font-bold uppercase tracking-wider mb-1 inline-flex items-center gap-1 ${bandConfig.accent}`}
              >
                <Target size={10} /> Where it converts
              </div>
              <p className={`text-xs leading-relaxed ${bandConfig.text}`}>
                {result.conversionCeiling}
              </p>
            </div>
          )}

          {result.improvements.length > 0 && (
            <div className="pt-2 mt-1 border-t border-slate-200/40">
              <div
                className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 inline-flex items-center gap-1 ${bandConfig.accent}`}
              >
                <Sparkles size={10} /> What would push this higher
              </div>
              <ul className="space-y-1">
                {result.improvements.map((imp, i) => {
                  const ic = impactConfig[imp.impact];
                  const isOpen = !!openImprovements[i];
                  return (
                    <li key={i}>
                      <button
                        onClick={() =>
                          setOpenImprovements((s) => ({ ...s, [i]: !isOpen }))
                        }
                        className="w-full text-left flex items-start gap-2 text-xs text-slate-800 leading-relaxed hover:bg-black/[0.02] rounded-md px-1.5 py-1 transition-colors"
                      >
                        <span
                          className={`shrink-0 inline-flex items-center gap-1 text-[8px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded border ${ic.cls} mt-0.5`}
                        >
                          {ic.icon} {ic.label}
                        </span>
                        <span className="flex-1 min-w-0 font-medium">
                          {imp.title}
                        </span>
                        <span className="shrink-0 text-slate-400 mt-0.5">
                          {isOpen ? (
                            <ChevronUp size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                        </span>
                      </button>
                      {isOpen && imp.detail && (
                        <div className="ml-[60px] mt-0.5 mb-1 pl-2 border-l-2 border-slate-200/80 text-xs text-slate-700 leading-relaxed">
                          {imp.detail}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="pt-2 mt-1 flex justify-end">
            <button
              onClick={runAssessment}
              className={`text-[10px] font-medium ${bandConfig.accent} hover:underline underline-offset-2`}
              title="Re-run assessment after editing the Profile"
            >
              Re-assess
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
