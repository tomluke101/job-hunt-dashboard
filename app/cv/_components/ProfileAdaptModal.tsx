"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Loader2, X, Check, AlertCircle, Sparkles } from "lucide-react";
import { adaptMasterForCV, saveMasterProfile } from "@/app/actions/cv-tailoring";
import { computeWordDiff, type DiffToken } from "@/lib/cv/word-diff";

interface Props {
  jdText: string;
  cvId?: string;
  companyName?: string;
  roleName?: string;
  // Optional — which Master to adapt. Falls back to the user's default if
  // not specified.
  masterId?: string;
  // Called when the user accepts the adapted Profile to use it for THIS CV
  // only. The parent updates tailored.summary.
  onAccept: (adapted: string) => void;
  // Called when the modal is closed without accepting.
  onClose: () => void;
}

interface AdaptResult {
  master: string;
  adapted: string;
  warnings: string[];
  unchanged: boolean;
}

export default function ProfileAdaptModal({
  jdText,
  cvId,
  companyName,
  roleName,
  masterId,
  onAccept,
  onClose,
}: Props) {
  const [phase, setPhase] = useState<"running" | "review" | "error">("running");
  const [result, setResult] = useState<AdaptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, startRun] = useTransition();
  const [isSavingMaster, startSaveMaster] = useTransition();
  const [savedMasterFlash, setSavedMasterFlash] = useState(false);

  // Run adaptation immediately on mount. Guard against multiple invocations
  // if the component re-mounts in StrictMode (dev) or under React 19's
  // double-effect pattern.
  const hasRunRef = useRef(false);
  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    startRun(async () => {
      const r = await adaptMasterForCV({
        jdText,
        cvId,
        companyName,
        roleName,
        masterId,
      });
      if (r.error) {
        setError(r.error);
        setPhase("error");
        return;
      }
      if (!r.master || !r.adapted) {
        setError("Adaptation returned no result.");
        setPhase("error");
        return;
      }
      setResult({
        master: r.master,
        adapted: r.adapted,
        warnings: r.warnings,
        unchanged: !!r.unchanged,
      });
      setPhase("review");
    });
    // Intentionally empty deps — we want this to run exactly once on mount.
    // Inputs are passed via props and are stable for the modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAcceptForCV() {
    if (!result) return;
    onAccept(result.adapted);
    onClose();
  }

  function handleSaveAsMaster() {
    if (!result) return;
    startSaveMaster(async () => {
      const r = await saveMasterProfile({
        summary: result.adapted,
        source: "edited",
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      setSavedMasterFlash(true);
      // Also apply to the current CV.
      onAccept(result.adapted);
      // Slight delay so the user sees the success state, then close.
      setTimeout(() => onClose(), 800);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg inline-flex items-center gap-2">
              <Sparkles size={16} className="text-blue-500" /> Adapt Profile to this JD
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              JD-emphasis adaptation for{" "}
              {companyName || roleName ? (
                <span className="font-medium text-slate-700">
                  {[roleName, companyName].filter(Boolean).join(" @ ")}
                </span>
              ) : (
                "the job description"
              )}
              . Universal anchors (employer brands, role titles, degree) preserved; S2 + S3 may surface different FactBase claims to match JD weight.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isRunning || isSavingMaster}
            className="text-slate-400 hover:text-slate-700 p-1 disabled:opacity-30"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {phase === "running" && (
            <div className="flex flex-col items-center justify-center py-12 text-slate-600">
              <Loader2 size={28} className="text-blue-600 animate-spin mb-4" />
              <p className="text-sm font-medium">
                Adapting your Master Profile to the JD…
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Scoring FactBase claims against JD weight, then re-emphasising S2 + S3 around the strongest matches. Universal anchors preserved.
              </p>
            </div>
          )}

          {phase === "error" && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
              <div className="flex items-start gap-2">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Couldn&apos;t adapt the Profile.</p>
                  <p className="text-rose-800 text-xs mt-1">{error}</p>
                </div>
              </div>
            </div>
          )}

          {phase === "review" && result && (
            <div className="space-y-4">
              {result.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
                  {result.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <AlertCircle size={11} className="mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.unchanged ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm">
                  <p className="font-medium text-slate-900 mb-1">No changes warranted</p>
                  <p className="text-slate-600 text-xs">
                    Your Master Profile&apos;s vocabulary already aligns with the JD. Nothing to adapt — your verbatim Master is the right Profile for this role.
                  </p>
                </div>
              ) : (
                <DiffPanel master={result.master} adapted={result.adapted} />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4 rounded-b-2xl shrink-0">
          {phase === "review" && result && !result.unchanged ? (
            <>
              <button
                onClick={onClose}
                disabled={isSavingMaster}
                className="text-sm font-medium text-slate-500 hover:text-slate-900 px-3 py-2 disabled:opacity-40"
              >
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveAsMaster}
                  disabled={isSavingMaster}
                  className={`text-sm font-medium inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border transition-colors ${
                    savedMasterFlash
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                  } disabled:opacity-40`}
                  title="Save the adapted version as your new Master Profile (overwrites your saved default)"
                >
                  {isSavingMaster ? (
                    <>
                      <Loader2 size={13} className="animate-spin" /> Saving…
                    </>
                  ) : savedMasterFlash ? (
                    <>
                      <Check size={13} /> Saved as Master
                    </>
                  ) : (
                    <>Save as new Master</>
                  )}
                </button>
                <button
                  onClick={handleAcceptForCV}
                  disabled={isSavingMaster}
                  className="text-sm font-semibold inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                >
                  <Check size={13} /> Use for this CV only
                </button>
              </div>
            </>
          ) : phase === "review" && result?.unchanged ? (
            <button
              onClick={onClose}
              className="ml-auto text-sm font-medium px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
            >
              Close
            </button>
          ) : phase === "error" ? (
            <button
              onClick={onClose}
              className="ml-auto text-sm font-medium px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
            >
              Close
            </button>
          ) : (
            <span className="text-xs text-slate-400">This usually takes 5-15 seconds.</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Side-by-side diff panel ─────────────────────────────────────────────────

function DiffPanel({ master, adapted }: { master: string; adapted: string }) {
  const diff = computeWordDiff(master, adapted);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
          Your Master (current)
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 text-sm leading-relaxed font-serif text-slate-900">
          {renderTokens(diff.left)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700 mb-1.5">
          Adapted for this JD
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4 text-sm leading-relaxed font-serif text-slate-900">
          {renderTokens(diff.right)}
        </div>
      </div>
    </div>
  );
}

function renderTokens(tokens: DiffToken[]) {
  return tokens.map((t, i) => {
    if (t.kind === "same") {
      return <span key={i}>{t.text}</span>;
    }
    if (t.kind === "removed") {
      return (
        <span
          key={i}
          className="bg-rose-100 text-rose-900 line-through decoration-rose-400 rounded px-0.5"
        >
          {t.text}
        </span>
      );
    }
    return (
      <span
        key={i}
        className="bg-emerald-100 text-emerald-900 rounded px-0.5 font-semibold"
      >
        {t.text}
      </span>
    );
  });
}
