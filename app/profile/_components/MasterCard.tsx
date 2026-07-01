"use client";

// One Master Profile, fully editable in place.
// Owns its name, summary, and source/updated metadata. Exclusions live at the
// user level (Profile Exclusions section), not per-Master, so they apply
// globally across every Profile the AI generates.
// Save handles both upserting a fresh Master AND deleting (empty summary +
// existing master = delete). Default toggle, regenerate, delete-confirm all
// in this component so the parent list stays simple.

import { useState, useTransition, useEffect } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Briefcase,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import {
  saveMaster,
  deleteMaster,
  setDefaultMaster,
  generateMasterProfile,
  getMasterProfileById,
  scanProfileText,
  detectMasterFactBaseGaps,
  saveGapAnswersAsSkills,
  type MasterProfile,
  type ProfileScanIssue,
  type FactBaseGapResult,
} from "@/app/actions/cv-tailoring";
import FactBaseGapModal from "./FactBaseGapModal";
import ProfileStrengthCard from "./ProfileStrengthCard";

interface Props {
  master: MasterProfile;
  // Called after any DB mutation so the parent list refetches.
  onChange: () => void;
}

// Old blank-Master placeholder content — created before the empty-Master fix
// landed. Treat as "really empty" so the user gets a clean textarea and the
// scanner / picker behaves correctly.
const LEGACY_PLACEHOLDER =
  "Type or paste your Profile here, or click Generate to draft from your FactBase.";

export default function MasterCard({ master, onChange }: Props) {
  const initialSummary =
    master.summary?.trim() === LEGACY_PLACEHOLDER ? "" : master.summary;
  const [nameDraft, setNameDraft] = useState(master.name);
  const [summaryDraft, setSummaryDraft] = useState(initialSummary);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();
  const [isMakingDefault, startMakeDefault] = useTransition();
  const [isGenerating, startGenerate] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [generationStage, setGenerationStage] = useState<string | null>(null);

  // FactBase gap-detection state. Pre-flight check runs on FIRST generation
  // (when the Master is empty) and shows a modal with targeted questions if
  // FactBase coverage is medium/low. On regenerate, gap detection is skipped
  // — the user's already been through the wizardising step.
  const [gapModalOpen, setGapModalOpen] = useState(false);
  const [gapResult, setGapResult] = useState<FactBaseGapResult | null>(null);
  const [isDetectingGaps, setIsDetectingGaps] = useState(false);

  // Target-family edit state. Inline editor shown when user clicks the
  // target-family tag — they can change family or sector at any time.
  // Persists via saveMaster; the next generation / Adapt / gap-detection
  // call uses the updated family.
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetFamilyDraft, setTargetFamilyDraft] = useState(
    master.target_role_family ?? ""
  );
  const [targetSectorDraft, setTargetSectorDraft] = useState(
    master.target_sector ?? ""
  );
  const [isSavingTarget, startSaveTarget] = useTransition();

  // Inline quality scan — runs on summaryDraft (debounced 600ms after typing
  // stops). Surfaces tricolons, em-dashes, banned vocab, missing anchors,
  // excluded phrases, etc. as a collapsible warning row beneath the textarea
  // so the user knows what's wrong WHEN THEY EDIT — but stays HIDDEN when
  // the content is the unedited AI output. Rationale: any issue in unedited
  // AI output is a SYSTEM bug the critic loop should have caught; exposing
  // it to the user as "your Profile has quality issues" makes the SaaS look
  // broken. When the user edits the Profile manually, the panel re-appears
  // because then the issues are user-introduced and actionable.
  const [scanIssues, setScanIssues] = useState<ProfileScanIssue[]>([]);
  const [scanIssuesOpen, setScanIssuesOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  // Last AI-generated Profile text — used to gate the quality scan panel.
  // Updated on every successful generation. While summaryDraft === lastAiOutput,
  // the user hasn't edited the Profile and the panel stays hidden. Init from
  // master.source — when source is "generated", the persisted summary is
  // last-AI-output so the panel stays hidden until the user edits.
  const [lastAiOutput, setLastAiOutput] = useState<string>(
    master.source === "generated" ? initialSummary : ""
  );

  // One-shot cleanup of legacy placeholder content. Old "+ Add a blank Master"
  // saved the placeholder string as the row's actual summary; new ones save
  // empty. Detect the legacy state on mount and write empty to clean it up
  // silently — user doesn't need to take any action.
  useEffect(() => {
    if (master.summary?.trim() !== LEGACY_PLACEHOLDER) return;
    let cancelled = false;
    (async () => {
      const r = await saveMaster({
        id: master.id,
        name: master.name,
        summary: "",
        source: master.source,
        allowEmpty: true,
      });
      if (cancelled) return;
      if (!r.error) onChange();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.id]);

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
        const r = await scanProfileText({ text });
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
  }, [summaryDraft]);

  // "Server-state-equivalent" master.summary — placeholder is treated as
  // empty for dirty-checking, so saving an empty draft over a placeholder
  // counts as a meaningful change (and writes a real empty value).
  const effectiveServerSummary =
    master.summary?.trim() === LEGACY_PLACEHOLDER ? "" : master.summary;
  const isDirty =
    nameDraft.trim() !== master.name ||
    summaryDraft.trim() !== effectiveServerSummary.trim();
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

  // Persist target family + sector changes from the inline editor. The
  // saved fields drive every subsequent AI path on this Master.
  function handleSaveTarget() {
    setError(null);
    startSaveTarget(async () => {
      const r = await saveMaster({
        id: master.id,
        name: master.name,
        summary: master.summary || "",
        allowEmpty: true,
        targetRoleFamily: targetFamilyDraft.trim() || null,
        targetSector: targetSectorDraft.trim() || null,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      setEditingTarget(false);
      onChange();
    });
  }

  function handleCancelTargetEdit() {
    setTargetFamilyDraft(master.target_role_family ?? "");
    setTargetSectorDraft(master.target_sector ?? "");
    setEditingTarget(false);
  }

  function startStageCycle() {
    setGenerationStage("Reading your skills, work history, and CV…");
    return [
      setTimeout(() => setGenerationStage("Drafting with AI…"), 4000),
      setTimeout(() => setGenerationStage("Checking quality rules…"), 14000),
      setTimeout(() => setGenerationStage("Polishing — almost done…"), 22000),
    ];
  }

  // Core generation pipeline — takes optional gap answers, packs them as
  // wizardContext.anythingElse, calls generateMasterProfile, persists the
  // resulting summary into THIS Master row, optionally saves answers as a
  // Skill so they enrich every future generation. Used by both the gap-modal
  // submit path and the regenerate-without-gap-check path.
  async function runGenerationWithAnswers(
    answers: Array<{ question: string; answer: string }>,
    persistToSkills: boolean
  ): Promise<void> {
    const stageTimers = startStageCycle();
    try {
      const anythingElse =
        answers.length > 0
          ? answers
              .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
              .join("\n\n")
          : undefined;
      const result = await generateMasterProfile({
        wizardContext: anythingElse
          ? { stage: null, anythingElse }
          : undefined,
        // Master's target role family drives family-specific framing of
        // the AI output. NULL = sector-agnostic (current behaviour).
        targetRoleFamily: master.target_role_family,
        targetSector: master.target_sector,
        // Family-fit assessment from gap detection — when "transferable" or
        // "minimal" the Master prompt FORCES the career-changer template
        // (honest pivot framing instead of fake domain expertise). Passed
        // only when gap detection ran AND the user proceeded to generate.
        factbaseFitForFamily:
          gapResult?.factbaseFitForFamily ?? undefined,
        transferableAngles:
          gapResult?.transferableAngles ?? undefined,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (!result.summary) {
        setError("Generation returned no Profile.");
        return;
      }
      await saveMaster({
        id: master.id,
        name: nameDraft.trim() || master.name,
        summary: result.summary,
        source: "generated",
      });
      const fresh = await getMasterProfileById(master.id);
      if (fresh) {
        setSummaryDraft(fresh.summary);
        // Mark this exact text as the latest AI-generated output. The
        // quality-issues panel stays HIDDEN until the user actually edits
        // the Profile away from this baseline — issues in AI-generated
        // text are system bugs, not user-actionable improvements.
        setLastAiOutput(fresh.summary);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);

      // Persist gap answers as a Skill row so future FactBase extractions
      // pick them up. Fire-and-forget — failure here shouldn't block the
      // successful generation we just completed.
      if (persistToSkills && answers.length > 0) {
        saveGapAnswersAsSkills({ answers }).catch((e) =>
          console.warn("[MasterCard] saveGapAnswersAsSkills failed:", e)
        );
      }

      onChange();
    } finally {
      for (const t of stageTimers) clearTimeout(t);
      setGenerationStage(null);
    }
  }

  // Entry point — user clicked Generate on the Master card.
  // - First generation (Master summary empty): run pre-flight gap detection
  //   under a dedicated isDetectingGaps state (NOT inside startGenerate, so
  //   the textarea overlay can show "Checking FactBase…" without claiming
  //   we're generating yet). If coverage is medium/low, open the modal with
  //   targeted questions. If coverage is high, kick off generation directly
  //   — user sees one smooth spinner from click to result, no modal flash.
  // - Regenerate (Master already populated): skip gap detection. The user's
  //   been through this; they want a fresh take, not another questionnaire.
  function handleGenerate() {
    setError(null);
    const isFirstGeneration = !master.summary?.trim();

    if (!isFirstGeneration) {
      // Regenerate path — straight to generation.
      startGenerate(() => runGenerationWithAnswers([], false));
      return;
    }

    // First generation — preflight gap detection outside startGenerate so
    // isGenerating stays false until generation actually starts.
    setIsDetectingGaps(true);
    setGapResult(null);
    (async () => {
      try {
        const r = await detectMasterFactBaseGaps({
          // Pass target family so gap questions are framed for the specific
          // career direction this Master is being built toward. Without
          // this, a user adding a Consulting Master would get generic
          // "tell me about your achievements" questions instead of
          // consulting-specific "have you structured a hypothesis-driven
          // analysis?" ones.
          targetRoleFamily: master.target_role_family,
          targetSector: master.target_sector,
        });
        setIsDetectingGaps(false);
        if (r.error) {
          console.warn("[MasterCard] gap detection failed:", r.error);
          startGenerate(() => runGenerationWithAnswers([], false));
          return;
        }
        if (!r.result) return;

        // High coverage / no questions → straight to generation, no modal.
        if (
          r.result.coverageScore === "high" ||
          r.result.questions.length === 0
        ) {
          startGenerate(() => runGenerationWithAnswers([], false));
          return;
        }

        // Medium/low coverage with questions → open the modal. Generation
        // will run when the user submits.
        setGapResult(r.result);
        setGapModalOpen(true);
      } catch (e) {
        console.error("[MasterCard] gap pre-flight threw:", e);
        setIsDetectingGaps(false);
        startGenerate(() => runGenerationWithAnswers([], false));
      }
    })();
  }

  // User submitted gap answers (or hit "Skip and generate anyway" with empty
  // answers). Close the modal once generation completes so the success state
  // shows on the card, not behind a modal.
  async function handleGapSubmit(payload: {
    answers: Array<{ question: string; answer: string }>;
    persistToSkills: boolean;
  }): Promise<void> {
    return new Promise<void>((resolve) => {
      startGenerate(async () => {
        try {
          await runGenerationWithAnswers(payload.answers, payload.persistToSkills);
        } finally {
          setGapModalOpen(false);
          setGapResult(null);
          resolve();
        }
      });
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

      {/* Target role family — tag (read mode) or inline editor (edit mode).
          The family drives generation, gap detection, and Adapt for this
          Master. NULL family = sector-agnostic (current behaviour preserved). */}
      {editingTarget ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
            Target role family
            <span className="text-slate-400 font-normal normal-case tracking-normal ml-1">
              (drives AI framing of this Master)
            </span>
          </label>
          <input
            type="text"
            value={targetFamilyDraft}
            onChange={(e) => setTargetFamilyDraft(e.target.value)}
            disabled={isSavingTarget}
            placeholder="e.g. Consulting, Product Management, Investment Banking"
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300 disabled:opacity-50"
          />
          <input
            type="text"
            value={targetSectorDraft}
            onChange={(e) => setTargetSectorDraft(e.target.value)}
            disabled={isSavingTarget}
            placeholder="Sector (optional) — e.g. Financial services, FMCG, Tech"
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300 disabled:opacity-50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={handleCancelTargetEdit}
              disabled={isSavingTarget}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveTarget}
              disabled={isSavingTarget}
              className="text-[11px] font-semibold inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              {isSavingTarget ? (
                <>
                  <Loader2 size={10} className="animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Check size={10} /> Save target
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          {master.target_role_family ? (
            <button
              onClick={() => setEditingTarget(true)}
              disabled={isSaving || isDeleting || isGenerating}
              className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100 transition-colors disabled:opacity-40"
              title="Edit target role family / sector"
            >
              <Briefcase size={10} />
              <span className="font-semibold">{master.target_role_family}</span>
              {master.target_sector && (
                <span className="text-blue-700">· {master.target_sector}</span>
              )}
              <Pencil size={9} className="text-blue-500" />
            </button>
          ) : (
            <button
              onClick={() => setEditingTarget(true)}
              disabled={isSaving || isDeleting || isGenerating}
              className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-dashed border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors disabled:opacity-40"
              title="Set a target role family — unlocks family-specific AI framing"
            >
              <Briefcase size={10} />
              <span>No target family set</span>
              <Pencil size={9} />
            </button>
          )}
        </div>
      )}

      {/* Summary textarea */}
      <div className="relative">
        <textarea
          value={summaryDraft}
          onChange={(e) => setSummaryDraft(e.target.value)}
          disabled={isSaving || isDeleting || isGenerating || isDetectingGaps}
          placeholder="Click Generate to draft from your skills, work history, and CV. Or paste/type your own."
          rows={6}
          className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed font-serif disabled:opacity-50 placeholder-slate-300"
        />
        {(isGenerating || isDetectingGaps) && (
          <div className="absolute inset-0 rounded-xl bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none">
            <Loader2 size={20} className="text-blue-600 animate-spin" />
            <div className="text-xs font-medium text-slate-700">
              {isDetectingGaps
                ? "Checking your FactBase coverage…"
                : generationStage ?? "Building your Master Profile…"}
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
            disabled={isSaving || isDeleting || isGenerating || isDetectingGaps}
            className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
            title="Regenerate this Master from your FactBase"
          >
            {isDetectingGaps ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Checking…
              </>
            ) : isGenerating ? (
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
            disabled={isSaving || isDeleting || isGenerating || isDetectingGaps || !isDirty}
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
          card stays tidy when there are many issues.
          GATED: only shows when the user has edited the Profile away from
          the last AI-generated baseline. Issues in unedited AI output are
          system bugs the critic loop should have caught — exposing them
          to the user makes the SaaS look broken. */}
      {scanIssues.length > 0 && summaryDraft.trim() !== lastAiOutput.trim() && (
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

      {/* Post-generation Profile strength assessment. Honest score + realistic
          conversion ceiling + actionable improvement suggestions. Auto-runs
          when the Profile text changes (after generation completes); user
          can also re-run on demand. Only renders when the Profile is
          non-empty — empty Masters don't need scoring. */}
      {summaryDraft.trim().length > 60 && !isGenerating && (
        <ProfileStrengthCard
          profile={summaryDraft}
          targetRoleFamily={master.target_role_family ?? null}
          targetSector={master.target_sector ?? null}
          autoRun
        />
      )}

      {/* Pre-flight gap-detection modal. Opens when the user clicks Generate
          on an empty Master and the FactBase doesn't have enough evidence
          for a strong Profile. Closes automatically when generation
          completes. */}
      {gapModalOpen && (
        <FactBaseGapModal
          gapResult={
            gapResult ?? {
              coverageScore: "medium",
              reason: "",
              gaps: [],
              questions: [],
              factbaseFitForFamily: "strong",
              transferableAngles: [],
            }
          }
          isDetecting={isDetectingGaps}
          isGenerating={isGenerating}
          targetRoleFamily={master.target_role_family ?? undefined}
          onSubmit={handleGapSubmit}
          onClose={() => {
            // User dismissed the modal without submitting. Cancel — they can
            // click Generate again whenever ready. Don't auto-generate, that
            // would surprise them.
            if (!isGenerating) {
              setGapModalOpen(false);
              setGapResult(null);
              setIsDetectingGaps(false);
            }
          }}
        />
      )}
    </div>
  );
}
