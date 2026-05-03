"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Save, RefreshCw, Loader2, Check, AlertCircle } from "lucide-react";
import {
  saveMasterProfile,
  generateMasterProfile,
  type MasterProfile,
} from "@/app/actions/cv-tailoring";

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
    startGenerate(async () => {
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

      <div className="flex items-center justify-between gap-3">
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
        <div className="flex items-center gap-2">
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
    </div>
  );
}
