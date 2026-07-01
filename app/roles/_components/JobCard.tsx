"use client";

import { useState } from "react";
import {
  ExternalLink,
  Heart,
  X,
  CheckCheck,
  RotateCcw,
  MapPin,
  Building2,
  PoundSterling,
  Home,
  Building,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { ShortlistEntry } from "@/app/actions/searches";

interface Props {
  entry: ShortlistEntry;
  onInterested: () => void;
  onReject: () => void;
  onApplied: () => void;
  onDelete: () => void;
  onRestore: () => void;
}

export default function JobCard({ entry, onInterested, onReject, onApplied, onDelete, onRestore }: Props) {
  const [expanded, setExpanded] = useState(false);
  const p = entry.posting;
  if (!p) return null;

  const rankColor =
    (entry.composite_rank ?? 0) >= 75
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : (entry.composite_rank ?? 0) >= 55
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-300 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums ${rankColor}`}>
              {entry.composite_rank ?? "—"}
            </span>
            <p className="text-xs text-slate-500 uppercase tracking-wider">{p.source}</p>
            {p.posted_at && <p className="text-xs text-slate-400">· {postedAgo(p.posted_at)}</p>}
          </div>
          <h3 className="text-base font-semibold text-slate-900 leading-snug">{p.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
            <span className="flex items-center gap-1"><Building2 size={13} className="text-slate-400" />{p.company}</span>
            {p.location_raw && <span className="flex items-center gap-1"><MapPin size={13} className="text-slate-400" />{p.location_raw}</span>}
            <WorkingModelBadge model={p.working_model} />
            <SalaryBadge min={p.salary_min} max={p.salary_max} currency={p.salary_currency} listed={p.salary_listed} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {p.source_url && (
            <a
              href={p.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-700"
            >
              View source <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>

      {entry.jd_fit_summary && (
        <p className="mt-3 text-sm text-slate-700 bg-blue-50/50 border border-blue-100 rounded-lg px-3 py-2">
          {entry.jd_fit_summary}
        </p>
      )}

      <button
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
      >
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {expanded ? "Hide" : "Show"} description &amp; ranking
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Why it ranked here</p>
            <RankingExplanation entry={entry} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Description</p>
            <p className="text-sm text-slate-700 whitespace-pre-line line-clamp-[20]">{p.jd_text}</p>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 pt-3 border-t border-slate-100">
        {entry.state === "new" && (
          <>
            <button
              onClick={onInterested}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-3 py-1.5"
            >
              <Heart size={13} /> Interested
            </button>
            <button
              onClick={onReject}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-1.5"
            >
              <X size={13} /> Not interested
            </button>
            <button
              onClick={onDelete}
              className="ml-auto text-xs text-slate-400 hover:text-slate-600"
              title="Send to trash"
            >
              Trash
            </button>
          </>
        )}
        {entry.state === "interested" && (
          <>
            <button
              onClick={onApplied}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-3 py-1.5"
            >
              <CheckCheck size={13} /> Mark applied
            </button>
            <button
              onClick={onReject}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-1.5"
            >
              <X size={13} /> Not interested
            </button>
            <button onClick={onDelete} className="ml-auto text-xs text-slate-400 hover:text-slate-600">
              Trash
            </button>
          </>
        )}
        {(entry.state === "rejected_user" || entry.state === "deleted") && (
          <button
            onClick={onRestore}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-1.5"
          >
            <RotateCcw size={13} /> Restore
          </button>
        )}
        {entry.state === "applied" && (
          <p className="text-sm text-emerald-700 font-medium">Applied · tracked in Applications</p>
        )}
        {entry.reject_reason && (
          <p className="ml-3 text-xs text-slate-500">Reason: {entry.reject_reason}</p>
        )}
      </div>
    </article>
  );
}

function WorkingModelBadge({ model }: { model: string | null }) {
  if (!model || model === "unknown") return null;
  const label = model === "remote" ? "Remote" : model === "hybrid" ? "Hybrid" : "Office";
  const Icon = model === "remote" ? Home : Building;
  return (
    <span className="flex items-center gap-1 text-slate-600">
      <Icon size={12} className="text-slate-400" />
      {label}
    </span>
  );
}

function SalaryBadge({ min, max, currency, listed }: { min: number | null; max: number | null; currency: string | null; listed: boolean }) {
  if (!listed) return <span className="text-xs text-slate-400 italic">Salary hidden</span>;
  const sym = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const range = min && max && min !== max ? `${sym}${fmt(min)}–${fmt(max)}` : `${sym}${fmt((min ?? max)!)}`;
  return (
    <span className="flex items-center gap-1 text-slate-600">
      <PoundSterling size={12} className="text-slate-400" />
      {range}
    </span>
  );
}

function RankingExplanation({ entry }: { entry: ShortlistEntry }) {
  const scores = [
    { label: "Job quality", value: entry.quality_score },
    { label: "Match to search", value: entry.match_to_search_score },
    { label: "Match to you", value: entry.match_to_user_score },
    { label: "Career fit", value: entry.career_fit_score },
  ];
  const explanation = entry.ranking_explanation as Record<string, unknown> | null;
  const note = explanation?.note as string | undefined;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2">
        {scores.map((s) => (
          <div key={s.label} className="rounded-md border border-slate-200 bg-slate-50 p-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{s.label}</p>
            <p className="text-sm font-semibold text-slate-800 tabular-nums">
              {s.value ?? <span className="text-slate-400">—</span>}
            </p>
          </div>
        ))}
      </div>
      {note && <p className="text-xs text-slate-500 italic">{note}</p>}
    </div>
  );
}

function postedAgo(iso: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days === 0) return "posted today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
