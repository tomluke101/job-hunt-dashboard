"use client";

// One Master Profile, fully editable in place.
// Owns its name, summary, source/updated metadata, and per-Master exclusions.
// Save handles both upserting a fresh Master AND deleting (empty summary +
// existing master = delete). Default toggle, regenerate, delete-confirm all
// in this component so the parent list stays simple.

import { useState, useTransition, useEffect } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldOff,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  saveMaster,
  deleteMaster,
  setDefaultMaster,
  generateMasterProfile,
  setMasterExclusions,
  getMasterProfileById,
  scanProfileText,
  type MasterProfile,
  type ProfileScanIssue,
} from "@/app/actions/cv-tailoring";

interface Props {
  master: MasterProfile;
  // Called after any DB mutation so the parent list refetches.
  onChange: () => void;
}

export default function MasterCard({ master, onChange }: Props) {
  const [nameDraft, setNameDraft] = useState(master.name);
  const [summaryDraft, setSummaryDraft] = useState(master.summary);
  const [exclusionsDraft, setExclusionsDraft] = useState<string[]>(master.exclusions);
  const [exclusionInput, setExclusionInput] = useState("");
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isMakingDefault, startMakeDefault] = useTransition();
  const [isGenerating, startGenerate] = useTransition();
  const [isSavingExclusions, startSaveExclusions] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);

  // Inline quality scan — runs on summaryDraft (debounced 600ms after typing
  // stops). Surfaces tricolons, em-dashes, banned vocab, missing anchors,
  // excluded phrases, etc. as a collapsible warning row beneath the textarea
  // so the user knows what's wrong before they save.
  const [scanIssues, setScanIssues] = useState<ProfileScanIssue[]>([]);
  const [scanIssuesOpen, setScanIssuesOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    const text = summaryDraft.trim();
    if (!text) {
      setScanIssues([]);
      return;
    }
    setIsScanning(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await scanProfileText({
          text,
          exclusions: exclusionsDraft,
        });
        if (cancelled) return;
        setScanIssues(r.issues);
      } finally {
        if (!cancelled) setIsScanning(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [summaryDraft, exclusionsDraft]);

  const isDirty =
    nameDraft.trim() !== master.name ||
    summaryDraft.trim() !== master.summary;
  const exclusionsDirty =
    JSON.stringify(exclusionsDraft) !== JSON.stringify(master.exclusions);
  const wordCount = summaryDraft.trim().split(/\s+/).filter(Boolean).length;
  const lastUpdated = master.updated_at
    ? new Date(master.updated_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  function handleSave() {
    setError(null);
    const trimmedSummary = summaryDraft.trim();
    const trimmedName = nameDraft.trim() || "My Master";
    if (!trimmedSummary) {
      setError("Profile is empty. Use Delete if you want to remove this Master.");
      return;
    }
    startSave(async () => {
      const nextSource: "manual" | "generated" | "edited" =
        master.summary === trimmedSummary && master.name === trimmedName
          ? master.source
          : "edited";
      const r = await saveMaster({
        id: master.id,
        name: trimmedName,
        summary: trimmedSummary,
        source: nextSource,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      onChange();
    });
  }

  function handleDelete() {
    setError(null);
    startDelete(async () => {
      const r = await deleteMaster(master.id);
      if (r.error) {
        setError(r.error);
        return;
      }
      onChange();
    });
  }

  function handleMakeDefault() {
    setError(null);
    startMakeDefault(async () => {
      const r = await setDefaultMaster(master.id);
      if (r.error) {
        setError(r.error);
        return;
      }
      onChange();
    });
  }

  function startStageCycle() {
    setGenerationStage("Reading your skills, work history, and CV…");
    return [
      setTimeout(() => setGenerationStage("Drafting with AI…"), 4000),
      setTimeout(() => setGenerationStage("Checking quality rules…"), 14000),
      setTimeout(() => setGenerationStage("Polishing — almost done…"), 22000),
    ];
  }

  function handleGenerate() {
    setError(null);
    const stageTimers = startStageCycle();
    startGenerate(async () => {
      try {
        const result = await generateMasterProfile({});
        if (result.error) {
          setError(result.error);
          return;
        }
        if (!result.summary) {
          setError("Generation returned no Profile.");
          return;
        }
        // Save into THIS Master (don't create a new one).
        await saveMaster({
          id: master.id,
          name: nameDraft.trim() || master.name,
          summary: result.summary,
          source: "generated",
        });
        // Refetch this Master to pick up the persisted version.
        const fresh = await getMasterProfileById(master.id);
        if (fresh) setSummaryDraft(fresh.summary);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2500);
        onChange();
      } finally {
        for (const t of stageTimers) clearTimeout(t);
        setGenerationStage(null);
      }
    });
  }

  function addExclusion() {
    const t = exclusionInput.trim();
    if (!t) return;
    if (exclusionsDraft.some((e) => e.toLowerCase() === t.toLowerCase())) {
      setExclusionInput("");
      return;
    }
    if (exclusionsDraft.length >= 50) return;
    setExclusionsDraft([...exclusionsDraft, t]);
    setExclusionInput("");
  }

  function removeExclusion(index: number) {
    setExclusionsDraft(exclusionsDraft.filter((_, i) => i !== index));
  }

  function saveExclusions() {
    setError(null);
    startSaveExclusions(async () => {
      const r = await setMasterExclusions(master.id, exclusionsDraft);
      if (r.error) {
        setError(r.error);
        return;
      }
      onChange();
    });
  }

  return (
    <div
      className={`rounded-2xl border bg-white p-5 space-y-3 transition-shadow ${
        master.is_default
          ? "border-blue-300 shadow-sm"
          : "border-slate-200 shadow-sm"
      }`}
    >
      {/* Header — name input + default badge + delete */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">
            Name
          </label>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            disabled={isSaving || isDeleting || isGenerating}
            placeholder="e.g. Supply Chain Analyst"
            className="w-full text-base font-semibold text-slate-900 border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-400 focus:outline-none px-0 py-0.5 disabled:opacity-50"
          />
        </div>
        <div className="flex items-center gap-2">
          {master.is_default ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700">
              <Star size={10} className="fill-blue-500 text-blue-500" /> Default
            </span>
          ) : (
            <button
              onClick={handleMakeDefault}
              disabled={isMakingDefault}
              className="text-[11px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
              title="Make this the default Master used when no other matches the JD"
            >
              {isMakingDefault ? (
                <>
                  <Loader2 size={10} className="animate-spin" /> Setting…
                </>
              ) : (
                <>
                  <Star size={10} /> Make default
                </>
              )}
            </button>
          )}
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1 text-[11px]">
              <span className="text-rose-700 font-medium">Delete?</span>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="text-[11px] font-medium px-2 py-1 rounded-md border border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 disabled:opacity-40"
              >
                {isDeleting ? "…" : "Yes"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
                className="text-[11px] font-medium px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={isSaving || isDeleting}
              className="text-[11px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-500 hover:text-rose-700 hover:border-rose-200 hover:bg-rose-50 transition-colors disabled:opacity-40"
              title="Delete this Master"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Summary textarea */}
      <div className="relative">
        <textarea
          value={summaryDraft}
          onChange={(e) => setSummaryDraft(e.target.value)}
          disabled={isSaving || isDeleting || isGenerating}
          placeholder="Click Generate to draft from your skills, work history, and CV. Or paste/type your own."
          rows={6}
          className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed font-serif disabled:opacity-50 placeholder-slate-300"
        />
        {isGenerating && (
          <div className="absolute inset-0 rounded-xl bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Loader2 size={20} className="text-blue-600 animate-spin" />
            <div className="text-xs font-medium text-slate-700">
              {generationStage ?? "Building your Master Profile…"}
            </div>
          </div>
        )}
      </div>

      {/* Status + Save / Generate row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-slate-400">
          {wordCount} words
          {lastUpdated && (
            <>
              {" · "}saved {lastUpdated}
              {master.source === "generated" && " (AI generated)"}
              {master.source === "edited" && " (edited)"}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerate}
            disabled={isSaving || isDeleting || isGenerating}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
            title="Regenerate this Master from your FactBase"
          >
            {isGenerating ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Generating…
              </>
            ) : master.summary ? (
              <>
                <RefreshCw size={12} /> Regenerate
              </>
            ) : (
              <>
                <Sparkles size={12} /> Generate
              </>
            )}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || isDeleting || isGenerating || !isDirty}
            className={`text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
              savedFlash
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {isSaving ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Saving…
              </>
            ) : savedFlash ? (
              <>
                <Check size={12} /> Saved
              </>
            ) : (
              <>
                <Save size={12} /> Save
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Inline quality scan — surfaces issues like tricolons, em-dashes,
          banned vocab, excluded phrases as user types. Collapsible so the
          card stays tidy when there are many issues. */}
      {scanIssues.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
          <button
            onClick={() => setScanIssuesOpen((v) => !v)}
            className="w-full text-left text-[11px] font-medium text-amber-900 hover:text-amber-950 inline-flex items-center gap-1.5"
          >
            {scanIssuesOpen ? (
              <ChevronUp size={11} />
            ) : (
              <ChevronDown size={11} />
            )}
            <AlertTriangle size={11} />
            {scanIssues.length} quality issue{scanIssues.length === 1 ? "" : "s"} flagged
            <span className="ml-1 font-normal text-amber-700/80">
              — {Array.from(new Set(scanIssues.map((i) => i.rule))).slice(0, 4).join(", ")}
              {Array.from(new Set(scanIssues.map((i) => i.rule))).length > 4 ? "…" : ""}
            </span>
          </button>
          {scanIssuesOpen && (
            <ul className="mt-2 space-y-1.5">
              {scanIssues.map((issue, i) => (
                <li key={i} className="text-[11px] text-amber-900 leading-relaxed flex items-start gap-1.5">
                  <span className="shrink-0 inline-block px-1.5 py-0.5 rounded bg-amber-200 text-amber-950 font-semibold text-[10px]">
                    {issue.rule}
                  </span>
                  <span>{issue.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {isScanning && scanIssues.length === 0 && summaryDraft.trim().length > 40 && (
        <div className="text-[10px] text-slate-400 inline-flex items-center gap-1">
          <Loader2 size={9} className="animate-spin" /> checking quality…
        </div>
      )}

      {/* Per-Master exclusions, collapsible */}
      <div className="pt-2 border-t border-slate-100">
        <button
          onClick={() => setExclusionsOpen((v) => !v)}
          className="text-[11px] font-medium text-slate-500 hover:text-slate-900 inline-flex items-center gap-1.5"
        >
          {exclusionsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          <ShieldOff size={11} />
          Exclusions ({exclusionsDraft.length})
          <span className="text-slate-400 font-normal">
            — phrases the AI must never include in this Profile
          </span>
        </button>
        {exclusionsOpen && (
          <div className="mt-3 space-y-2">
            {exclusionsDraft.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {exclusionsDraft.map((item, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-rose-200 bg-rose-50 text-rose-900"
                  >
                    <ShieldOff size={10} />
                    <span>{item}</span>
                    <button
                      onClick={() => removeExclusion(i)}
                      className="text-rose-400 hover:text-rose-700"
                      aria-label={`Remove ${item}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={exclusionInput}
                onChange={(e) => setExclusionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExclusion();
                  }
                }}
                placeholder="e.g. a tool name, an old role, a specific claim"
                className="flex-1 text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300"
              />
              <button
                onClick={addExclusion}
                disabled={!exclusionInput.trim() || exclusionsDraft.length >= 50}
                className="text-xs font-medium inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                <Plus size={11} /> Add
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[11px] text-slate-400">
                {exclusionsDraft.length} / 50
              </div>
              <button
                onClick={saveExclusions}
                disabled={isSavingExclusions || !exclusionsDirty}
                className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors disabled:opacity-40"
              >
                {isSavingExclusions ? (
                  <>
                    <Loader2 size={12} className="animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    <Pencil size={12} /> Save exclusions
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
