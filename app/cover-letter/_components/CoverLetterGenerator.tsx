"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  FileText, Sparkles, Copy, Check, RefreshCw, ChevronDown,
  ClipboardList, AlertCircle, Loader2, Building2, FileDown, PlusCircle,
} from "lucide-react";
import { generateCoverLetter, refineCoverLetter, analyzeSkillGaps, createApplicationFromCoverLetter, SavedCoverLetter, type SkillGap } from "@/app/actions/cover-letters";
import { saveCoverLetterPrefs } from "@/app/actions/profile";
import { updateApplication } from "@/app/actions/applications";
import type { Application } from "@/app/actions/applications";
import type { UserCV, UserProfile, CoverLetterPrefs } from "@/app/actions/profile";
import type { Provider } from "@/lib/ai-providers";
import ProviderSelector from "@/app/_components/ProviderSelector";
import SkillDiscovery from "./SkillDiscovery";

interface Props {
  applications: Application[];
  cvs: UserCV[];
  currentProvider?: Provider | "auto";
  connectedProviders: Provider[];
  recentLetters: SavedCoverLetter[];
  profile: UserProfile;
  clPrefs: CoverLetterPrefs;
}

export default function CoverLetterGenerator({
  applications, cvs, currentProvider, connectedProviders, recentLetters, profile, clPrefs,
}: Props) {
  const searchParams = useSearchParams();
  const preselectedId = searchParams.get("applicationId");

  const [mode, setMode] = useState<"application" | "manual">(preselectedId ? "application" : "application");
  const [selectedAppId, setSelectedAppId] = useState<string>(preselectedId ?? "");
  const [manualJD, setManualJD] = useState("");
  const [manualCompany, setManualCompany] = useState("");
  const [manualRole, setManualRole] = useState("");
  const [selectedCvId, setSelectedCvId] = useState<string>(cvs.find((c) => c.is_default)?.id ?? cvs[0]?.id ?? "");
  const [anythingToAdd, setAnythingToAdd] = useState("");

  const [output, setOutput] = useState("");
  const [outputProvider, setOutputProvider] = useState("");
  const [letterId, setLetterId] = useState<string | null>(null);
  const [trackerAdded, setTrackerAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isAddingToTracker, startAddToTracker] = useTransition();

  const [refinementText, setRefinementText] = useState("");
  const [inlineJd, setInlineJd] = useState("");
  const [jdSaved, setJdSaved] = useState(false);

  const [isGenerating, startGenerate] = useTransition();
  const [isRefining, startRefine] = useTransition();
  const [isAnalysing, startAnalyse] = useTransition();

  // Skill discovery
  const [gaps, setGaps] = useState<SkillGap[]>([]);
  const [discoveryEnabled, setDiscoveryEnabled] = useState(clPrefs.enable_skill_discovery !== false);

  async function handleDisableDiscovery() {
    setDiscoveryEnabled(false);
    await saveCoverLetterPrefs({ ...clPrefs, enable_skill_discovery: false });
  }

  const outputRef = useRef<HTMLDivElement>(null);
  const jdTextareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedApp = applications.find((a) => a.id === selectedAppId);

  useEffect(() => {
    if (output && outputRef.current) {
      outputRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [output]);

  useEffect(() => {
    setInlineJd("");
    setJdSaved(false);
  }, [selectedAppId]);

  const jobDescription =
    mode === "application"
      ? (selectedApp?.job_description || inlineJd || "")
      : manualJD;

  const companyName =
    mode === "application" ? (selectedApp?.company ?? "") : manualCompany;

  const roleName =
    mode === "application" ? (selectedApp?.role ?? "") : manualRole;

  function handleGenerate() {
    setError(null);
    startGenerate(async () => {
      try {
        const result = await generateCoverLetter({
          jobDescription,
          companyName: companyName || undefined,
          roleName: roleName || undefined,
          cvId: selectedCvId || undefined,
          anythingToAdd: anythingToAdd || undefined,
          applicationId: mode === "application" ? selectedAppId || undefined : undefined,
        });
        setOutput(result.text);
        setOutputProvider(result.provider);
        setLetterId(result.letterId ?? null);
        setTrackerAdded(false);
        setRefinementText("");
        setGaps([]);

        // Silently save inline JD to tracker if user pasted it here
        if (mode === "application" && selectedAppId && inlineJd.trim() && !selectedApp?.job_description) {
          updateApplication(selectedAppId, { job_description: inlineJd.trim() })
            .then(() => setJdSaved(true))
            .catch(() => {});
        }

        // Trigger skill gap analysis in background if enabled and there's a JD
        if (discoveryEnabled && jobDescription.trim().length > 50) {
          startAnalyse(async () => {
            const found = await analyzeSkillGaps(jobDescription, selectedCvId || undefined);
            setGaps(found);
          });
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Generation failed. Please try again.");
      }
    });
  }

  function handleRefine() {
    if (!refinementText.trim() || !output) return;
    setError(null);
    startRefine(async () => {
      try {
        const result = await refineCoverLetter({
          originalLetter: output,
          refinementRequest: refinementText,
          jobDescription,
        });
        setOutput(result.text);
        setOutputProvider(result.provider);
        setRefinementText("");
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Refinement failed. Please try again.");
      }
    });
  }

  function buildHeader(): string {
    if (!clPrefs.include_header) return "";
    const lines = [
      profile.full_name,
      profile.location,
      profile.phone,
      profile.email,
      profile.headline,
    ].filter(Boolean);
    return lines.join("\n");
  }

  function fullLetterText(): string {
    const header = buildHeader();
    return header ? `${header}\n\n${output}` : output;
  }

  function handleCopy() {
    navigator.clipboard.writeText(fullLetterText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function buildLetterHtml(): string {
    return fullLetterText()
      .split("\n\n")
      .map((p) => `<p style="margin-bottom:1em;margin-top:0">${p.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function handleDownloadWord() {
    const filename = [companyName, roleName].filter(Boolean).join("-") || "cover-letter";
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'></head><body style="font-family:Georgia,serif;font-size:12pt;line-height:1.6;max-width:580px;margin:40px auto">${buildLetterHtml()}</body></html>`;
    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename.replace(/\s+/g, "-").toLowerCase()}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleDownloadPDF() {
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Cover Letter</title><style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.6;max-width:580px;margin:40px auto;color:#111}p{margin-bottom:1em;margin-top:0}</style></head><body>${buildLetterHtml()}<script>window.addEventListener('load',function(){window.print();})<\/script></body></html>`);
    win.document.close();
  }

  const canGenerate =
    !isGenerating &&
    (mode === "manual" ? manualJD.trim().length > 20 : !!selectedAppId) &&
    cvs.length > 0;

  const missingCv = cvs.length === 0;

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      {/* Mode tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        <button
          onClick={() => setMode("application")}
          className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg transition-colors ${mode === "application" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
        >
          <ClipboardList size={14} />
          From tracker
        </button>
        <button
          onClick={() => setMode("manual")}
          className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg transition-colors ${mode === "manual" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
        >
          <FileText size={14} />
          Paste job description
        </button>
      </div>

      {/* Input panel */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-6 space-y-5">

          {/* CV warning */}
          {missingCv && (
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-500" />
              <div>
                <p className="font-semibold">No CV uploaded</p>
                <p className="text-amber-700 text-xs mt-0.5">
                  Upload your CV in{" "}
                  <a href="/profile" className="underline font-medium">My Profile</a>{" "}
                  before generating a cover letter.
                </p>
              </div>
            </div>
          )}

          {mode === "application" ? (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">
                Select Application
              </label>
              {applications.length === 0 ? (
                <div className="text-sm text-slate-400 bg-slate-50 rounded-xl px-4 py-3 border border-slate-200">
                  No applications in your tracker yet.{" "}
                  <a href="/tracker" className="text-blue-600 font-medium hover:underline">Add one first</a>.
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
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>
              )}

              {selectedApp && (
                <div className="mt-3 flex items-center gap-3 bg-slate-50 rounded-xl px-4 py-3 border border-slate-100">
                  <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                    <Building2 size={14} className="text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900">{selectedApp.role}</p>
                    <p className="text-xs text-slate-500">{selectedApp.company}{selectedApp.location ? ` · ${selectedApp.location}` : ""}</p>
                  </div>
                  {selectedApp.job_description ? (
                    <span className="text-xs text-emerald-600 font-medium bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">JD ready</span>
                  ) : jdSaved ? (
                    <span className="text-xs text-emerald-600 font-medium bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">JD saved</span>
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
                <div className="mt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-amber-600 uppercase tracking-wider flex items-center gap-1.5">
                      <AlertCircle size={11} /> Paste the job description for a tailored letter
                    </label>
                    {jdSaved && (
                      <span className="text-xs text-emerald-600 flex items-center gap-1">
                        <Check size={10} /> Saved to tracker
                      </span>
                    )}
                  </div>
                  <textarea
                    ref={jdTextareaRef}
                    value={inlineJd}
                    onChange={(e) => setInlineJd(e.target.value)}
                    placeholder="Paste the full job description here — we'll save it to your tracker automatically when you generate."
                    rows={6}
                    className="w-full text-sm border border-amber-200 bg-amber-50/20 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
                  />
                  {!inlineJd.trim() && (
                    <p className="text-xs text-slate-400">
                      No JD? You can still generate — but the letter will be general and untailored.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                    Company Name <span className="text-slate-400 font-normal normal-case">(optional)</span>
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
                    Role Title <span className="text-slate-400 font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={manualRole}
                    onChange={(e) => setManualRole(e.target.value)}
                    placeholder="e.g. Product Manager"
                    className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                  Job Description <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={manualJD}
                  onChange={(e) => setManualJD(e.target.value)}
                  placeholder="Paste the full job description here — the more detail, the better tailored your cover letter will be."
                  rows={8}
                  className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
                />
              </div>
            </div>
          )}

          {/* CV selector */}
          {cvs.length > 1 && (
            <div>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
                Which CV
              </label>
              <div className="relative">
                <select
                  value={selectedCvId}
                  onChange={(e) => setSelectedCvId(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 appearance-none bg-white text-slate-800"
                >
                  {cvs.map((cv) => (
                    <option key={cv.id} value={cv.id}>
                      {cv.name}{cv.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
            </div>
          )}

          {/* Anything to add */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">
              Anything to add or emphasise?{" "}
              <span className="text-slate-400 font-normal normal-case">optional — this is your chance to personalise</span>
            </label>
            <textarea
              value={anythingToAdd}
              onChange={(e) => setAnythingToAdd(e.target.value)}
              placeholder="e.g. &quot;Mention my experience leading the rebrand at X — it's directly relevant&quot; or &quot;I know the VP of Product there — keep the tone confident&quot; or &quot;Add something about my side project building a fintech app&quot;"
              rows={3}
              className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
            />
            <p className="text-xs text-slate-400 mt-1.5">
              Include personal stories, achievements not on your CV, specific things to mention or avoid. The AI uses everything in your profile — this is for role-specific additions.
            </p>
          </div>
        </div>

        {/* Generate bar */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-4">
          <ProviderSelector
            task="cover-letter"
            current={currentProvider}
            connectedProviders={connectedProviders}
          />
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
          >
            {isGenerating ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                Generate Cover Letter
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Generation failed</p>
            <p className="text-red-600 text-xs mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Output */}
      {output && (
        <div ref={outputRef} className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Output header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="font-semibold text-slate-900 text-sm">Your Cover Letter</h2>
                {outputProvider && (
                  <p className="text-xs text-slate-400 mt-0.5">Generated with {outputProvider}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 bg-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  <RefreshCw size={12} /> Regenerate
                </button>
                <button
                  onClick={handleDownloadWord}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 bg-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  <FileDown size={12} /> Word
                </button>
                <button
                  onClick={handleDownloadPDF}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 bg-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  <FileDown size={12} /> PDF
                </button>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 text-xs font-medium bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
            </div>

            {/* Letter body */}
            <div className="px-8 py-8">
              <div className="max-w-2xl font-serif text-slate-800 leading-relaxed space-y-4">
                {/* Contact header block */}
                {clPrefs.include_header && (
                  <div className="not-prose mb-6 pb-6 border-b border-slate-100">
                    {[profile.full_name, profile.location, profile.phone, profile.email, profile.headline]
                      .filter(Boolean)
                      .map((line, i) => (
                        <p key={i} className={`text-[14px] font-sans leading-snug text-slate-700 ${i === 0 ? "font-semibold text-slate-900" : ""} ${i === 4 ? "font-medium" : ""}`}>
                          {line}
                        </p>
                      ))}
                  </div>
                )}
                {/* Letter paragraphs */}
                {output.split("\n\n").map((para, i) => (
                  <p key={i} className="text-[15px]">{para}</p>
                ))}
              </div>
            </div>

            {/* Word count */}
            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50">
              <p className="text-xs text-slate-400">
                {output.split(/\s+/).filter(Boolean).length} words · Saved automatically
              </p>
            </div>
          </div>

          {/* Refinement */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-900 text-sm">Refine this letter</h3>
              <p className="text-xs text-slate-400 mt-0.5">Tell the AI what to change — be specific</p>
            </div>
            <div className="p-6 space-y-3">
              <textarea
                value={refinementText}
                onChange={(e) => setRefinementText(e.target.value)}
                placeholder={"e.g. \"Make the opening stronger — lead with the Monzo project\" or \"Shorten the second paragraph — it's too long\" or \"Add more about my leadership experience\""}
                rows={3}
                className="w-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed placeholder-slate-300"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">You can refine as many times as you like — each iteration improves the letter.</p>
                <button
                  onClick={handleRefine}
                  disabled={!refinementText.trim() || isRefining}
                  className="flex items-center gap-1.5 text-sm bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {isRefining ? (
                    <><Loader2 size={14} className="animate-spin" /> Refining…</>
                  ) : (
                    <><Sparkles size={14} /> Apply Changes</>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Add to tracker prompt — manual mode only */}
          {mode === "manual" && manualCompany && !trackerAdded && letterId && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                  <ClipboardList size={14} className="text-slate-500" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Add to your tracker?</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {manualRole ? `${manualRole} at ${manualCompany}` : manualCompany} — track this application and keep everything in one place
                  </p>
                </div>
              </div>
              <button
                onClick={() => startAddToTracker(async () => {
                  await createApplicationFromCoverLetter(manualCompany, manualRole || "Role", manualJD, letterId);
                  setTrackerAdded(true);
                })}
                disabled={isAddingToTracker}
                className="flex items-center gap-1.5 text-sm font-semibold bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white px-4 py-2 rounded-xl transition-colors shrink-0"
              >
                {isAddingToTracker
                  ? <><Loader2 size={13} className="animate-spin" /> Adding…</>
                  : <><PlusCircle size={13} /> Add to tracker</>}
              </button>
            </div>
          )}
          {mode === "manual" && trackerAdded && (
            <div className="flex items-center gap-2 text-sm text-emerald-600 font-medium bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4">
              <Check size={15} />
              Added to your tracker —{" "}
              <a href="/tracker" className="underline hover:no-underline">view it here</a>
            </div>
          )}

          {/* Skill discovery */}
          {isAnalysing && (
            <div className="flex items-center gap-2.5 bg-white border border-slate-200 rounded-2xl px-5 py-4 text-sm text-slate-500">
              <Loader2 size={14} className="animate-spin text-blue-500 shrink-0" />
              Checking this JD for skills you haven't mentioned yet…
            </div>
          )}
          {!isAnalysing && gaps.length > 0 && discoveryEnabled && (
            <SkillDiscovery
              gaps={gaps}
              jobDescription={jobDescription}
              currentLetter={output}
              onLetterUpdated={(text, provider) => { setOutput(text); setOutputProvider(provider); }}
              onDisable={handleDisableDiscovery}
              onClose={() => setGaps([])}
            />
          )}
        </div>
      )}


      {/* Recent letters (shown when no output yet) */}
      {!output && recentLetters.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900 text-sm">Recent letters</h3>
          </div>
          <div className="divide-y divide-slate-50">
            {recentLetters.slice(0, 5).map((letter) => {
              const preview = letter.content.slice(0, 180).replace(/\n/g, " ").trim();
              const wordCount = letter.content.split(/\s+/).filter(Boolean).length;
              const date = new Date(letter.created_at).toLocaleDateString("en-GB", {
                day: "numeric", month: "short", year: "2-digit",
              });
              return (
                <div
                  key={letter.id}
                  className="px-6 py-4 hover:bg-slate-50 cursor-pointer transition-colors"
                  onClick={() => { setOutput(letter.content); setOutputProvider(letter.provider ?? ""); }}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-slate-500">{date}</p>
                    <p className="text-xs text-slate-400">{wordCount} words</p>
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed line-clamp-2">{preview}…</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
