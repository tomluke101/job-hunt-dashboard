"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Building2,
  ChevronDown,
  ClipboardList,
  FileDown,
  FileText,
  Printer,
  Sparkles,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { tailorCV, refineTailoredCV } from "@/app/actions/cv-tailoring";
import type { Application } from "@/app/actions/applications";
import type { UserCV } from "@/app/actions/profile";
import type { TailoredCV } from "@/lib/cv/tailored-cv";
import {
  cvFileBaseName,
  tailoredCVToPrintHtml,
  tailoredCVToWordHtml,
} from "@/lib/cv/export";
import TailoredCVView from "./TailoredCVView";

interface Props {
  applications: Application[];
  cvs: UserCV[];
}

export default function CVTailorClient({ applications, cvs }: Props) {
  const searchParams = useSearchParams();
  const preselectedAppId = searchParams.get("applicationId");

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
  const [inlineJd, setInlineJd] = useState("");

  const [tailored, setTailored] = useState<TailoredCV | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isTailoring, startTailor] = useTransition();
  const [refineText, setRefineText] = useState("");
  const [isRefining, startRefine] = useTransition();

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
  }, [selectedAppId]);

  const missingCv = cvs.length === 0;
  const canTailor =
    !isTailoring &&
    !missingCv &&
    jobDescription.trim().length >= 30;

  function handleTailor() {
    setError(null);
    setTailored(null);
    setWarnings([]);
    startTailor(async () => {
      const result = await tailorCV({
        jdText: jobDescription,
        cvId: selectedCvId || undefined,
        companyName: companyName || undefined,
        roleName: roleName || undefined,
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
    });
  }

  function handleStartOver() {
    setTailored(null);
    setError(null);
    setWarnings([]);
    setRefineText("");
  }

  function handleRegenerate() {
    setError(null);
    setWarnings([]);
    startTailor(async () => {
      const result = await tailorCV({
        jdText: jobDescription,
        cvId: selectedCvId || undefined,
        companyName: companyName || undefined,
        roleName: roleName || undefined,
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
    });
  }

  function handleRefine() {
    if (!tailored || !refineText.trim()) return;
    setError(null);
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

  function handleDownloadPDF() {
    if (!tailored) return;
    const win = window.open("", "_blank", "width=900,height=1100");
    if (!win) return;
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

        <div className="border-t border-slate-100 bg-slate-50/50 px-6 py-4 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Truth contract: every claim traces to your profile or CV. No invented metrics.
          </div>
          <button
            onClick={handleTailor}
            disabled={!canTailor}
            className={`flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-xl transition-all ${
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

          <TailoredCVView cv={tailored} />

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
