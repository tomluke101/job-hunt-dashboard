"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Building2,
  Check,
  ChevronDown,
  ClipboardList,
  FileDown,
  FileText,
  Pencil,
  Printer,
  RotateCcw,
  Save,
  Sparkles,
  Loader2,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { tailorCV, refineTailoredCV, saveTailoredCV, getMasterProfileById, scoreMastersForJD, saveMaster, type MasterProfile, type MasterFitResult } from "@/app/actions/cv-tailoring";
import ProfileAdaptModal from "./ProfileAdaptModal";
import ProfileEditModal from "./ProfileEditModal";
import { updateApplication } from "@/app/actions/applications";
import type { Application } from "@/app/actions/applications";
import type { UserCV } from "@/app/actions/profile";
import type { TailoredCV } from "@/lib/cv/tailored-cv";
import type { SavedTailoredCV } from "@/app/actions/cv-tailoring";
import {
  cvFileBaseName,
  tailoredCVToPrintHtml,
  tailoredCVToWordHtml,
} from "@/lib/cv/export";
import TailoredCVView from "./TailoredCVView";

interface Props {
  applications: Application[];
  cvs: UserCV[];
  savedCVByApp?: Record<string, SavedTailoredCV>;
  masters: MasterProfile[];
}

export default function CVTailorClient({ applications, cvs, savedCVByApp = {}, masters }: Props) {
  const searchParams = useSearchParams();
  const preselectedAppId = searchParams.get("applicationId");
  const preloadedSaved = preselectedAppId ? savedCVByApp[preselectedAppId] : undefined;

  const [mode, setMode] = useState<"application" | "manual">(
    preselectedAppId ? "application" : "application"
  );
  const [selectedAppId, setSelectedAppId] = useState<string>(preselectedAppId ?? "");
  const [manualJD, setManualJD] = useState("");
  const [manualCompany, setManualCompany] = useState("");
  const [manualRole, setManualRole] = useState("");
  const [selectedCvId, setSelectedCvId] = useState<string>(
    cvs.find((c) => c.is_default)?.id ?? cvs[0]?.id ?? ""
  );
  // Pre-fill the JD textarea from the saved CV when restoring — so a refine
  // run after navigating from the tracker has the JD context it needs.
  const [inlineJd, setInlineJd] = useState(preloadedSaved?.jd_text ?? "");

  const [tailored, setTailored] = useState<TailoredCV | null>(preloadedSaved?.tailored_data ?? null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isTailoring, startTailor] = useTransition();
  const [tailorStage, setTailorStage] = useState<string | null>(null);
  const [refineText, setRefineText] = useState("");
  const [isRefining, startRefine] = useTransition();
  const [savedId, setSavedId] = useState<string | null>(preloadedSaved?.id ?? null);
  const [isSaving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  // Profile section actions (Phase 2 of Profile section).
  const [profileAdaptOpen, setProfileAdaptOpen] = useState(false);
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  const [isResettingProfile, startResetProfile] = useTransition();
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  // Master picker — defaults to user's default Master, can be switched per CV.
  // After fit-scoring runs, auto-selects the best-fit Master.
  const defaultMaster = masters.find((m) => m.is_default) ?? masters[0] ?? null;
  const [selectedMasterId, setSelectedMasterId] = useState<string>(defaultMaster?.id ?? "");
  const selectedMaster = masters.find((m) => m.id === selectedMasterId) ?? defaultMaster;

  // Fit-scoring state. Populated when user picks/pastes a JD with 2+ Masters.
  const [fitResult, setFitResult] = useState<MasterFitResult | null>(null);
  const [isScoringFit, setIsScoringFit] = useState(false);
  const [userOverrodeMaster, setUserOverrodeMaster] = useState(false);

  // Save-as-first-Master state for users with no saved Masters.
  const [isSavingAsMaster, startSaveAsMaster] = useTransition();
  const [savedAsMasterFlash, setSavedAsMasterFlash] = useState(false);
  const [saveMasterName, setSaveMasterName] = useState("");
  const [saveMasterError, setSaveMasterError] = useState<string | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const jdTextareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedApp = applications.find((a) => a.id === selectedAppId);
  const jobDescription =
    mode === "application"
      ? selectedApp?.job_description || inlineJd || ""
      : manualJD;
  const companyName = mode === "application" ? selectedApp?.company ?? "" : manualCompany;
  const roleName = mode === "application" ? selectedApp?.role ?? "" : manualRole;

  useEffect(() => {
    if (tailored && outputRef.current) {
      outputRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [tailored]);

  useEffect(() => {
    setInlineJd("");
    // JD context changed — invalidate fit-scoring state.
    setFitResult(null);
    setUserOverrodeMaster(false);
  }, [selectedAppId]);

  // Run fit-scoring when JD has been chosen / pasted, user has 2+ Masters,
  // and the user hasn't manually overridden the picker. Debounced so paste-
  // typed JDs don't trigger on every keystroke.
  useEffect(() => {
    if (masters.length < 2) return;
    if (userOverrodeMaster) return;
    const jd = jobDescription.trim();
    if (jd.length < 100) return; // need real JD content to classify
    let cancelled = false;
    setIsScoringFit(true);
    const handle = setTimeout(async () => {
      const r = await scoreMastersForJD({ jdText: jd });
      if (cancelled) return;
      setIsScoringFit(false);
      if (r.error || !r.result) return;
      setFitResult(r.result);
      // Auto-select best-fit Master only if user hasn't explicitly switched.
      if (!userOverrodeMaster && r.result.bestMasterId) {
        setSelectedMasterId(r.result.bestMasterId);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDescription, masters.length]);

  function handleMasterSwitch(id: string) {
    setSelectedMasterId(id);
    setUserOverrodeMaster(true); // disables auto-pick until JD changes
  }

  const missingCv = cvs.length === 0;
  const canTailor =
    !isTailoring &&
    !missingCv &&
    jobDescription.trim().length >= 30;

  // Stage cycle for the tailor pipeline (factbase extract → master tailor →
  // AI generation → critic passes). Mirrors Master Profile UX so the user
  // sees movement during the 30-60s wait.
  function startTailorStageCycle() {
    setTailorStage("Reading your CV, skills and work history…");
    return [
      setTimeout(() => setTailorStage("Tailoring your Profile to the JD…"), 4000),
      setTimeout(() => setTailorStage("Drafting bullets and skills…"), 12000),
      setTimeout(() => setTailorStage("Running quality critic…"), 24000),
      setTimeout(() => setTailorStage("Polishing — almost done…"), 38000),
    ];
  }

  // Single source of truth for tailor + regenerate. Always clears the previous
  // tailored CV first so the spinner doesn't sit over a stale one (Tom flagged
  // this as flicker).
  function runTailor() {
    setError(null);
    setTailored(null);
    setWarnings([]);
    setSavedId(null);
    setSaveError(null);
    const stageTimers = startTailorStageCycle();
    startTailor(async () => {
      try {
        const result = await tailorCV({
          jdText: jobDescription,
          cvId: selectedCvId || undefined,
          companyName: companyName || undefined,
          roleName: roleName || undefined,
          masterId: selectedMasterId || undefined,
        });
        if (result.error) {
          setError(result.error);
          setWarnings(result.warnings ?? []);
          return;
        }
        if (result.tailoredCV) {
          setTailored(result.tailoredCV);
          setWarnings(result.warnings ?? []);
        }
      } finally {
        for (const t of stageTimers) clearTimeout(t);
        setTailorStage(null);
      }
    });
  }

  const handleTailor = runTailor;
  const handleRegenerate = runTailor;

  function handleStartOver() {
    setTailored(null);
    setError(null);
    setWarnings([]);
    setRefineText("");
    setSavedId(null);
    setSaveError(null);
    setTailorStage(null);
  }

  function handleSave() {
    if (!tailored) return;
    setSaveError(null);
    startSave(async () => {
      // If JD was pasted in tracker mode but not yet on the application, save it.
      if (
        mode === "application" &&
        selectedAppId &&
        inlineJd.trim() &&
        !selectedApp?.job_description
      ) {
        try {
          await updateApplication(selectedAppId, { job_description: inlineJd.trim() });
        } catch {
          /* non-blocking */
        }
      }
      const result = await saveTailoredCV({
        tailoredCV: tailored,
        applicationId: mode === "application" ? selectedAppId || undefined : undefined,
        companyName: companyName || undefined,
        roleName: roleName || undefined,
        jdText: jobDescription || undefined,
      });
      if (result.error) {
        setSaveError(result.error);
        return;
      }
      if (result.id) setSavedId(result.id);
    });
  }


  function handleRefine() {
    if (!tailored || !refineText.trim()) return;
    setError(null);
    setSavedId(null);
    setSaveError(null);
    startRefine(async () => {
      const result = await refineTailoredCV({
        jdText: jobDescription,
        cvId: selectedCvId || undefined,
        companyName: companyName || undefined,
        roleName: roleName || undefined,
        previousCV: tailored,
        instruction: refineText.trim(),
      });
      if (result.error) {
        setError(result.error);
        setWarnings(result.warnings ?? []);
        return;
      }
      if (result.tailoredCV) {
        setTailored(result.tailoredCV);
        setWarnings(result.warnings ?? []);
        setRefineText("");
      }
    });
  }

  function handleDownloadWord() {
    if (!tailored) return;
    const base = cvFileBaseName(tailored, companyName || undefined, roleName || undefined);
    const html = tailoredCVToWordHtml(tailored);
    const blob = new Blob(["﻿", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Profile section actions (Phase 2 of Profile section) ───────────────
  // [Edit] [Adapt] [Reset] live above the rendered Profile and let the user
  // override the verbatim Master for THIS CV without touching their default.
  function handleResetProfileToMaster() {
    if (!tailored) return;
    setProfileMessage(null);
    startResetProfile(async () => {
      // Reset to whichever Master is currently selected for this CV.
      const fresh = selectedMasterId
        ? await getMasterProfileById(selectedMasterId)
        : null;
      if (!fresh?.summary?.trim()) {
        setProfileMessage("No saved Master Profile to reset to. Save one on the Profile page first.");
        return;
      }
      setTailored({ ...tailored, summary: fresh.summary.trim() });
      setProfileMessage(`Profile reset to ${fresh.name}.`);
      setTimeout(() => setProfileMessage(null), 2500);
    });
  }

  function handleProfileAccept(newSummary: string) {
    if (!tailored) return;
    setTailored({ ...tailored, summary: newSummary });
    setProfileMessage("Profile updated for this CV.");
    setTimeout(() => setProfileMessage(null), 2500);
  }

  // Save the AI-generated Profile from this tailor as the user's first Master.
  // Only relevant when masters.length === 0 — see the post-tailor banner.
  function handleSaveAsFirstMaster() {
    if (!tailored?.summary?.trim()) return;
    const name =
      saveMasterName.trim() ||
      fitResult?.detectedRoleFamily?.trim() ||
      roleName?.trim() ||
      "My Master";
    setSaveMasterError(null);
    startSaveAsMaster(async () => {
      const r = await saveMaster({
        name,
        summary: tailored.summary,
        source: "generated",
        isDefault: true,
      });
      if (r.error) {
        setSaveMasterError(r.error);
        return;
      }
      setSavedAsMasterFlash(true);
      setTimeout(() => setSavedAsMasterFlash(false), 3000);
      // Note: the masters prop won't auto-update without a refetch — but
      // for the banner UX we set savedAsMasterFlash, and the next page load
      // (or router.refresh) will pick up the new Master.
    });
  }

  function handleDownloadPDF() {
    if (!tailored) return;
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) {
      setSaveError(
        "Browser blocked the PDF preview pop-up. Allow pop-ups for this site, or use the Word download instead."
      );
      return;
    }
    win.document.write(tailoredCVToPrintHtml(tailored));
    win.document.close();
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        <button
          onClick={() => setMode("application")}
          className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg transition-colors ${
            mode === "application"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <ClipboardList size={14} />
          From tracker
        </button>
        <button
          onClick={() => setMode("manual")}
          className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg transition-colors ${
            mode === "manual"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <FileText size={14} />
          Paste job description
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-6 space-y-5">
          {missingCv && (
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="font-semibold">No base CV uploaded</p>
                <p className="text-amber-700 text-xs mt-0.5">
                  Upload your CV in{" "}
                  <a href="/profile" className="underline font-medium">
                    My Profile
                  </a>{" "}
                  before tailoring.
                </p>
              </div>
            </div>
          )}

          {mode === "application" ? (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">
                Select application
              </label>
              {applications.length === 0 ? (
                <div className="text-sm text-slate-400 bg-slate-50 rounded-xl px-4 py-3 border border-slate-200">
                  No applications yet.{" "}
                  <a href="/tracker" className="text-blue-600 font-medium hover:underline">
                    Add one first
                  </a>
                  .
                </div>
              ) : (
                <div className="relative">
                  <select
                    value={selectedAppId}
                    onChange={(e) => setSelectedAppId(e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 appearance-none bg-white text-slate-800"
                  >
                    <option value="">— Select a role —</option>
                    {applications.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.role} @ {a.company}
                        {a.job_description ? " ✓" : " (no JD)"}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                  />
                </div>
              )}

              {selectedApp && (
                <div className="mt-3 flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                  <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                    <Building2 size={14} className="text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900">{selectedApp.role}</p>
                    <p className="text-xs text-slate-500">
                      {selectedApp.company}
                      {selectedApp.location ? ` · ${selectedApp.location}` : ""}
                    </p>
                  </div>
                  {selectedApp.job_description ? (
                    <span className="text-xs text-emerald-600 font-medium bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                      JD ready
                    </span>
                  ) : (
                    <button
                      onClick={() => jdTextareaRef.current?.focus()}
                      className="text-xs text-amber-600 font-medium bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full hover:bg-amber-100 transition-colors"
                    >
                      Add JD
                    </button>
                  )}
                </div>
              )}

              {selectedApp && !selectedApp.job_description && (
                <div className="mt-3">
                  <label className="text-xs font-semibold text-amber-600 uppercase tracking-wider mb-1 block flex items-center gap-1.5">
                    <AlertCircle size={11} /> Paste the job description
                  </label>
                  <textarea
                    ref={jdTextareaRef}
                    value={inlineJd}
                    onChange={(e) => setInlineJd(e.target.value)}
                    placeholder="Paste the full job description here — required for a tailored CV."
                    rows={6}
                    className="w-full text-sm border border-amber-200 bg-amber-50/20 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                    Company name{" "}
                    <span className="text-slate-400 font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={manualCompany}
                    onChange={(e) => setManualCompany(e.target.value)}
                    placeholder="e.g. Monzo"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                    Role title{" "}
                    <span className="text-slate-400 font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={manualRole}
                    onChange={(e) => setManualRole(e.target.value)}
                    placeholder="e.g. Senior Supply Chain Analyst"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                  Job description <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={manualJD}
                  onChange={(e) => setManualJD(e.target.value)}
                  placeholder="Paste the full job description here — the more detail, the better tailored your CV will be."
                  rows={8}
                  className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
                />
              </div>
            </div>
          )}

          {cvs.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                Base CV
              </label>
              <div className="relative">
                <select
                  value={selectedCvId}
                  onChange={(e) => setSelectedCvId(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 appearance-none bg-white text-slate-800"
                >
                  {cvs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.is_default ? " · default" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                />
              </div>
              <p className="text-xs text-slate-400 mt-1.5">
                The tailorer pulls bullets and education from this CV plus your Work History and Skills.
              </p>
            </div>
          )}
        </div>

        {/* Master picker — auto-defaults to user's default Master, can be
            switched per CV. Fit-scoring auto-picks the best Master once the
            JD is chosen. Banner below shows fit level. */}
        {masters.length > 0 ? (
          <div className="border-t border-slate-100 bg-white px-6 py-3 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-slate-500 inline-flex items-center gap-1.5">
                <Sparkles size={11} className="text-blue-500" />
                <span>
                  Master Profile:{" "}
                  <span className="font-semibold text-slate-900">
                    {selectedMaster?.name ?? "—"}
                  </span>
                  {selectedMaster?.is_default && (
                    <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 border border-blue-100 text-blue-700">
                      default
                    </span>
                  )}
                  {fitResult && fitResult.bestMasterId === selectedMasterId && (
                    <span
                      className={`ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                        fitResult.fitScore === "high"
                          ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                          : fitResult.fitScore === "medium"
                            ? "bg-amber-50 border-amber-200 text-amber-700"
                            : "bg-rose-50 border-rose-200 text-rose-700"
                      }`}
                      title={fitResult.reason}
                    >
                      {fitResult.fitScore} fit
                    </span>
                  )}
                  {isScoringFit && (
                    <span className="ml-1.5 text-[10px] text-slate-400 inline-flex items-center gap-1">
                      <Loader2 size={9} className="animate-spin" /> matching…
                    </span>
                  )}
                </span>
              </div>
              {masters.length > 1 && (
                <div className="relative">
                  <select
                    value={selectedMasterId}
                    onChange={(e) => handleMasterSwitch(e.target.value)}
                    className="text-xs border border-slate-200 rounded-lg px-3 py-1.5 pr-8 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 appearance-none bg-white text-slate-800"
                  >
                    {masters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.is_default ? " · default" : ""}
                        {fitResult?.bestMasterId === m.id ? " · best fit" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={12}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                  />
                </div>
              )}
            </div>

            {/* Fit warning when no saved Master matches the JD's role family. */}
            {fitResult && fitResult.fitScore === "low" && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 text-[11px] text-amber-900 leading-relaxed">
                <div className="font-semibold mb-0.5">
                  This JD looks like a {fitResult.detectedRoleFamily || "different role family"}.
                </div>
                <div className="text-amber-800">
                  None of your saved Masters fit it well. The CV will use{" "}
                  <span className="font-medium">{selectedMaster?.name}</span>{" "}
                  as the closest match — but consider creating a Master for this
                  role family on the Profile page.
                </div>
              </div>
            )}
            {fitResult && fitResult.fitScore === "medium" && (
              <div className="text-[11px] text-amber-800 leading-relaxed">
                Detected role family: <span className="font-medium">{fitResult.detectedRoleFamily}</span>.{" "}
                <span className="font-medium">{selectedMaster?.name}</span> is a partial match —
                click <span className="font-semibold">Adapt to this JD</span> on the Profile after tailoring for vocabulary tweaks.
              </div>
            )}
          </div>
        ) : (
          <div className="border-t border-slate-100 bg-amber-50/50 px-6 py-3">
            <div className="text-xs text-amber-900 leading-relaxed">
              <span className="font-semibold">No Master Profile saved.</span>{" "}
              The CV will use a one-off AI-generated Profile from your CV + JD.
              Quality varies — once it&apos;s generated, you can save it as your
              first Master for future applications.{" "}
              <a href="/profile" className="underline font-medium">
                Or set one up now.
              </a>
            </div>
          </div>
        )}
        <div className="border-t border-slate-100 bg-slate-50/50 px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-slate-500 flex-1 min-w-0">
            {isTailoring && tailorStage ? (
              <span className="inline-flex items-center gap-1.5 text-slate-700 font-medium">
                <Loader2 size={11} className="animate-spin text-blue-600" />
                {tailorStage}
              </span>
            ) : (
              "Truth contract: every claim traces to your profile or CV. No invented metrics."
            )}
          </div>
          <button
            onClick={handleTailor}
            disabled={!canTailor}
            className={`flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-xl transition-all shrink-0 ${
              canTailor
                ? "bg-slate-900 text-white hover:bg-slate-800 shadow-sm"
                : "bg-slate-100 text-slate-400 cursor-not-allowed"
            }`}
          >
            {isTailoring ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Tailoring…
              </>
            ) : (
              <>
                <Sparkles size={14} /> Tailor CV
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-900">
          {error}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 space-y-1">
          {warnings.map((w, i) => (
            <p key={i}>• {w}</p>
          ))}
        </div>
      )}

      {tailored && (
        <div ref={outputRef} className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-lg font-semibold text-slate-900">Tailored CV</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={isRefining || isTailoring || isSaving}
                className={`text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${
                  savedId
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
                title={
                  mode === "application" && selectedAppId
                    ? "Save this version to the selected application"
                    : "Save this version (not linked to an application)"
                }
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
              <button
                onClick={handleDownloadWord}
                disabled={isRefining || isTailoring}
                className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
              >
                <FileDown size={13} /> Word
              </button>
              <button
                onClick={handleDownloadPDF}
                disabled={isRefining || isTailoring}
                className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
              >
                <Printer size={13} /> PDF
              </button>
              <button
                onClick={handleRegenerate}
                disabled={isRefining || isTailoring}
                className="text-xs font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
                title="Roll a fresh generation with no instruction"
              >
                <RefreshCw size={13} /> Regenerate
              </button>
              <button
                onClick={handleStartOver}
                disabled={isRefining || isTailoring}
                className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 px-2 py-1.5 disabled:opacity-40"
              >
                Start over
              </button>
            </div>
          </div>

          {saveError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {saveError}
            </div>
          )}

          {profileMessage && (
            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {profileMessage}
            </div>
          )}

          {/* No-Master onboarding banner — shown when the user generated this
              CV without a saved Master. Lets them save the auto-Profile as
              their first Master in one click, with optional name. */}
          {masters.length === 0 && tailored.summary && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 space-y-2.5">
              <div className="flex items-start gap-2 text-xs text-blue-900 leading-relaxed">
                <Sparkles size={13} className="mt-0.5 shrink-0 text-blue-500" />
                <div className="flex-1">
                  <div className="font-semibold mb-0.5">
                    This Profile was generated one-off from your CV + JD.
                  </div>
                  <div className="text-blue-800">
                    Save it as your first Master and it&apos;ll be reused
                    (and tailorable) for every future CV. You can edit it
                    later on the Profile page.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={saveMasterName}
                  onChange={(e) => setSaveMasterName(e.target.value)}
                  disabled={isSavingAsMaster}
                  placeholder={
                    fitResult?.detectedRoleFamily
                      ? `e.g. ${fitResult.detectedRoleFamily}`
                      : roleName
                        ? `e.g. ${roleName}`
                        : "Name this Master"
                  }
                  className="flex-1 min-w-[180px] text-xs border border-blue-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-400 disabled:opacity-50"
                />
                <button
                  onClick={handleSaveAsFirstMaster}
                  disabled={isSavingAsMaster || savedAsMasterFlash}
                  className={`text-xs font-semibold inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 ${
                    savedAsMasterFlash
                      ? "bg-emerald-100 border border-emerald-300 text-emerald-800"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {isSavingAsMaster ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> Saving…
                    </>
                  ) : savedAsMasterFlash ? (
                    <>
                      <Check size={11} /> Saved as your first Master
                    </>
                  ) : (
                    <>
                      <Save size={11} /> Save as my first Master
                    </>
                  )}
                </button>
              </div>
              {saveMasterError && (
                <div className="text-[11px] text-rose-700 inline-flex items-center gap-1">
                  <AlertCircle size={10} /> {saveMasterError}
                </div>
              )}
            </div>
          )}

          <TailoredCVView
            cv={tailored}
            profileActions={
              <>
                <button
                  onClick={() => setProfileEditOpen(true)}
                  disabled={isTailoring || isRefining || isResettingProfile}
                  className="text-[11px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors disabled:opacity-40"
                  title="Manually edit the Profile for this CV"
                >
                  <Pencil size={11} /> Edit
                </button>
                <button
                  onClick={() => setProfileAdaptOpen(true)}
                  disabled={isTailoring || isRefining || isResettingProfile || !jobDescription.trim()}
                  className="text-[11px] font-semibold inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
                  title="AI adapts your saved Master Profile to this JD's vocabulary. Every named claim is preserved."
                >
                  <Wand2 size={11} /> Adapt to this JD
                </button>
                <button
                  onClick={handleResetProfileToMaster}
                  disabled={isTailoring || isRefining || isResettingProfile}
                  className="text-[11px] font-medium inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors disabled:opacity-40"
                  title="Restore the Profile to your saved Master verbatim"
                >
                  {isResettingProfile ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> Resetting…
                    </>
                  ) : (
                    <>
                      <RotateCcw size={11} /> Master
                    </>
                  )}
                </button>
              </>
            }
          />

          {profileAdaptOpen && (
            <ProfileAdaptModal
              jdText={jobDescription}
              cvId={selectedCvId || undefined}
              companyName={companyName || undefined}
              roleName={roleName || undefined}
              masterId={selectedMasterId || undefined}
              onAccept={handleProfileAccept}
              onClose={() => setProfileAdaptOpen(false)}
            />
          )}
          {profileEditOpen && tailored && (
            <ProfileEditModal
              initialValue={tailored.summary || ""}
              onSave={handleProfileAccept}
              onClose={() => setProfileEditOpen(false)}
            />
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">
              Refine — tell me what to change
            </label>
            <textarea
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              placeholder='e.g. "Drop the lifeguard role", "Make Grain & Frame bullets punchier", "Reorder skills with analytics first", "Sharpen the profile around the ERP build".'
              rows={3}
              disabled={isRefining || isTailoring}
              className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300 disabled:opacity-50"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-slate-400">
                Refining keeps your truth contract intact and re-runs the critic.
              </p>
              <button
                onClick={handleRefine}
                disabled={isRefining || isTailoring || !refineText.trim()}
                className={`flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all ${
                  refineText.trim() && !isRefining && !isTailoring
                    ? "bg-slate-900 text-white hover:bg-slate-800 shadow-sm"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed"
                }`}
              >
                {isRefining ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Refining…
                  </>
                ) : (
                  <>
                    <Sparkles size={14} /> Refine
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
