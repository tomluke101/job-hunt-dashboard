"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Save, RefreshCw, Loader2, Check, AlertCircle, Wand2, Trash2 } from "lucide-react";
import {
  saveMasterProfile,
  generateMasterProfile,
  getMasterProfile,
  deleteMasterProfile,
  type MasterProfile,
} from "@/app/actions/cv-tailoring";
import ProfileBuilderWizard, { type WizardAnswers } from "./ProfileBuilderWizard";

interface Props {
  initial: MasterProfile | null;
}

export default function MasterProfileSection({ initial }: Props) {
  const router = useRouter();
  // Local source of truth for the master profile. Initialised from server data
  // and updated imperatively after every mutation. We deliberately don't sync
  // back to the `initial` prop — that path proved racy with router.refresh()
  // + useTransition, which left the textarea empty after the wizard closed.
  const [master, setMaster] = useState<MasterProfile | null>(initial);
  const [draft, setDraft] = useState<string>(initial?.summary ?? "");
  const [savedId, setSavedId] = useState(false);
  const [isGenerating, startGenerate] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, startDelete] = useTransition();

  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  const isDirty = draft !== (master?.summary ?? "");
  const lastUpdated = master?.updated_at
    ? new Date(master.updated_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  function startStageCycle() {
    setGenerationStage("Reading your skills, work history, and CV…");
    return [
      setTimeout(() => setGenerationStage("Drafting your Profile with AI…"), 4000),
      setTimeout(() => setGenerationStage("Checking quality rules…"), 14000),
      setTimeout(() => setGenerationStage("Polishing — almost done…"), 22000),
      setTimeout(() => setGenerationStage("Final pass…"), 32000),
    ];
  }

  function handleGenerate() {
    setError(null);
    setWarnings([]);
    setSavedId(false);
    const stageTimers = startStageCycle();
    startGenerate(async () => {
      try {
        const result = await generateMasterProfile({});
        if (result.error) {
          setError(result.error);
          if (result.warnings) setWarnings(result.warnings);
          return;
        }
        if (result.summary) {
          // Persist immediately so a refresh won't lose it.
          await saveMasterProfile({ summary: result.summary, source: "generated" });
          // Re-fetch from server — canonical source.
          const fresh = await getMasterProfile();
          if (fresh?.summary) {
            setDraft(fresh.summary);
            setMaster(fresh);
          } else {
            setDraft(result.summary);
            setMaster({
              user_id: master?.user_id ?? "",
              summary: result.summary,
              source: "generated",
              factbase_hash: master?.factbase_hash ?? null,
              updated_at: new Date().toISOString(),
            });
          }
          if (result.warnings) setWarnings(result.warnings);
          router.refresh(); // best-effort sync of other parts of the page
        }
      } finally {
        for (const t of stageTimers) clearTimeout(t);
        setGenerationStage(null);
      }
    });
  }

  function handleDelete() {
    setError(null);
    startDelete(async () => {
      const result = await deleteMasterProfile();
      if (result.error) {
        setError(result.error);
        return;
      }
      setMaster(null);
      setDraft("");
      setSavedId(false);
      setConfirmDelete(false);
      setWarnings([]);
      router.refresh();
    });
  }

  function handleSave() {
    if (!draft.trim()) return;
    setError(null);
    startSave(async () => {
      const trimmed = draft.trim();
      const nextSource: "manual" | "generated" | "edited" = master?.summary === trimmed
        ? master.source
        : "edited";
      const result = await saveMasterProfile({ summary: trimmed, source: nextSource });
      if (result.error) {
        setError(result.error);
        return;
      }
      setMaster({
        user_id: master?.user_id ?? "",
        summary: trimmed,
        source: nextSource,
        factbase_hash: master?.factbase_hash ?? null,
        updated_at: new Date().toISOString(),
      });
      setSavedId(true);
      router.refresh();
      setTimeout(() => setSavedId(false), 2500);
    });
  }

  // Wizard submits its answers here. We run generation directly so the draft
  // state is owned by THIS component — no cross-component state sync, no
  // skill/employer pollution. Returns ok/error so the wizard can decide
  // whether to close.
  async function handleWizardSubmit(answers: WizardAnswers): Promise<{ ok: boolean; error?: string }> {
    setError(null);
    setWarnings([]);
    setSavedId(false);
    const stageTimers = startStageCycle();
    try {
      const result = await generateMasterProfile({ wizardContext: answers });
      if (result.error) {
        setError(result.error);
        if (result.warnings) setWarnings(result.warnings);
        return { ok: false, error: result.error };
      }
      if (!result.summary) {
        return { ok: false, error: "Generation returned no Profile." };
      }
      await saveMasterProfile({ summary: result.summary, source: "generated" });

      // Re-fetch from server — server is the canonical source. This eliminates
      // any timing/batching uncertainty about whether setDraft "took".
      const fresh = await getMasterProfile();
      if (fresh?.summary) {
        setDraft(fresh.summary);
        setMaster(fresh);
      } else {
        // fallback (extreme edge): use what we generated
        setDraft(result.summary);
        setMaster({
          user_id: master?.user_id ?? "",
          summary: result.summary,
          source: "generated",
          factbase_hash: master?.factbase_hash ?? null,
          updated_at: new Date().toISOString(),
        });
      }

      if (result.warnings) setWarnings(result.warnings);
      setSavedId(true);
      setTimeout(() => setSavedId(false), 2500);
      router.refresh();
      return { ok: true };
    } finally {
      for (const t of stageTimers) clearTimeout(t);
      setGenerationStage(null);
    }
  }

  // Belt-and-braces backup: when the wizard closes, ensure we have the latest
  // server-side master in local state. Even if the in-flight handleWizardSubmit
  // somehow failed to set draft, this catches it.
  const prevWizardOpen = useRef(false);
  useEffect(() => {
    if (prevWizardOpen.current && !wizardOpen) {
      // Wizard just closed. Re-fetch from server.
      (async () => {
        try {
          const fresh = await getMasterProfile();
          if (fresh?.summary) {
            setMaster(fresh);
            // Only overwrite draft if it's empty or matches the previous
            // saved value (i.e. user hasn't manually edited it post-wizard).
            setDraft((current) => {
              if (!current.trim()) return fresh.summary;
              if (current === master?.summary) return fresh.summary;
              return current;
            });
          }
        } catch (e) {
          console.error("[MasterProfileSection] post-wizard refetch failed:", e);
        }
      })();
    }
    prevWizardOpen.current = wizardOpen;
  }, [wizardOpen, master?.summary]);

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
          disabled={isGenerating || isSaving || generationStage !== null}
          className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed font-serif disabled:opacity-50 placeholder-slate-300"
        />
        {(isGenerating || generationStage !== null) && (
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
              {master?.source === "generated" && " (AI generated)"}
              {master?.source === "edited" && " (edited)"}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {master?.summary && (
            confirmDelete ? (
              <span className="inline-flex items-center gap-1 text-xs">
                <span className="text-rose-700 font-medium">Delete saved Profile?</span>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="text-xs font-medium px-2 py-1 rounded-md border border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 disabled:opacity-40"
                >
                  {isDeleting ? (
                    <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Deleting…</span>
                  ) : "Yes, delete"}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={isDeleting}
                  className="text-xs font-medium px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={isGenerating || isSaving || isDeleting}
                className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-rose-700 hover:border-rose-200 hover:bg-rose-50 transition-colors disabled:opacity-40"
                title="Delete the saved Master Profile"
              >
                <Trash2 size={13} /> Delete
              </button>
            )
          )}
          <button
            onClick={() => setWizardOpen(true)}
            disabled={isGenerating || isSaving || isDeleting}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
            title="Build your Master Profile via a 5-minute guided flow"
          >
            <Wand2 size={13} /> Build with help
          </button>
          <button
            onClick={handleGenerate}
            disabled={isGenerating || isSaving || isDeleting}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
            title="Generate a fresh Master Profile from your current skills, work history, and CV"
          >
            {isGenerating ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Generating…
              </>
            ) : master?.summary ? (
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
            disabled={isGenerating || isSaving || isDeleting || !draft.trim() || !isDirty}
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
          onSubmit={handleWizardSubmit}
        />
      )}
    </div>
  );
}
