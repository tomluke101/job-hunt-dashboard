"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Save, RefreshCw, Loader2, Check, AlertCircle, Wand2 } from "lucide-react";
import {
  saveMasterProfile,
  generateMasterProfile,
  type MasterProfile,
} from "@/app/actions/cv-tailoring";
import ProfileBuilderWizard from "./ProfileBuilderWizard";

interface Props {
  initial: MasterProfile | null;
}

export default function MasterProfileSection({ initial }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<string>(initial?.summary ?? "");
  const [savedId, setSavedId] = useState(false);
  const [isGenerating, startGenerate] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);

  // Sync local draft when the server-side `initial` changes (e.g. after the
  // wizard finishes and triggers router.refresh() on the parent server component).
  // Without this, the textarea would still show whatever was here at mount.
  const lastInitialRef = useRef<string>(initial?.summary ?? "");
  useEffect(() => {
    const next = initial?.summary ?? "";
    if (next !== lastInitialRef.current && next !== draft) {
      // Only update if the user hasn't been editing — preserve their unsaved work.
      // Heuristic: if current draft equals the previous initial, they haven't edited.
      if (draft === lastInitialRef.current) {
        setDraft(next);
      }
    }
    lastInitialRef.current = next;
  }, [initial?.summary, draft]);

  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  const isDirty = draft !== (initial?.summary ?? "");
  const lastUpdated = initial?.updated_at
    ? new Date(initial.updated_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  function handleGenerate() {
    setError(null);
    setWarnings([]);
    setSavedId(false);
    setGenerationStage("Reading your skills, work history, and CV…");
    // Cycle through stage messages so the user sees forward motion across the
    // ~30s generation pipeline (factbase extract → AI draft → 15 scanners → up to
    // 2 rewrite passes).
    const stageTimers: ReturnType<typeof setTimeout>[] = [
      setTimeout(() => setGenerationStage("Drafting your Profile with AI…"), 4000),
      setTimeout(() => setGenerationStage("Checking 15 quality rules…"), 14000),
      setTimeout(() => setGenerationStage("Polishing — almost done…"), 22000),
    ];
    startGenerate(async () => {
      try {
        const result = await generateMasterProfile({});
        if (result.error) {
          setError(result.error);
          if (result.warnings) setWarnings(result.warnings);
          return;
        }
        if (result.summary) {
          setDraft(result.summary);
          if (result.warnings) setWarnings(result.warnings);
        }
      } finally {
        for (const t of stageTimers) clearTimeout(t);
        setGenerationStage(null);
      }
    });
  }

  function handleSave() {
    if (!draft.trim()) return;
    setError(null);
    startSave(async () => {
      const result = await saveMasterProfile({
        summary: draft.trim(),
        source: initial?.summary === draft ? initial.source : "edited",
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      setSavedId(true);
      router.refresh();
      setTimeout(() => setSavedId(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 leading-relaxed">
        Your canonical Profile — the strongest, sector-agnostic version of yourself. The CV
        generator uses this as the starting point for every application and tailors it to each
        job description. Generate once, edit freely, save permanently.
      </p>

      <div className="relative">
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSavedId(false);
          }}
          placeholder="Click Generate to draft your Master Profile from your skills, work history, and CV. Or paste/type your own."
          rows={8}
          disabled={isGenerating || isSaving}
          className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed font-serif disabled:opacity-50 placeholder-slate-300"
        />
        {isGenerating && (
          <div className="absolute inset-0 rounded-xl bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Loader2 size={20} className="text-blue-600 animate-spin" />
            <div className="text-xs font-medium text-slate-700">
              {generationStage ?? "Building your Master Profile…"}
            </div>
            <div className="text-[11px] text-slate-400">This usually takes 20-40 seconds.</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-slate-400">
          {wordCount} words
          {lastUpdated && (
            <>
              {" · "}saved {lastUpdated}
              {initial?.source === "generated" && " (AI generated)"}
              {initial?.source === "edited" && " (edited)"}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setWizardOpen(true)}
            disabled={isGenerating || isSaving}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
            title="Build your Master Profile via a 5-minute guided flow"
          >
            <Wand2 size={13} /> Build with help
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || isSaving}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
            title="Generate a fresh Master Profile from your current skills, work history, and CV"
          >
            {isGenerating ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Generating…
              </>
            ) : initial?.summary ? (
              <>
                <RefreshCw size={13} /> Regenerate
              </>
            ) : (
              <>
                <Sparkles size={13} /> Generate
              </>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={isGenerating || isSaving || !draft.trim() || !isDirty}
            className={`text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
              savedId
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {isSaving ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Saving…
              </>
            ) : savedId ? (
              <>
                <Check size={13} /> Saved
              </>
            ) : (
              <>
                <Save size={13} /> Save
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {error}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-0.5">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {wizardOpen && (
        <ProfileBuilderWizard
          onClose={() => setWizardOpen(false)}
          onComplete={(summary) => {
            setDraft(summary);
            setSavedId(true);
            setTimeout(() => setSavedId(false), 2500);
          }}
        />
      )}
    </div>
  );
}
