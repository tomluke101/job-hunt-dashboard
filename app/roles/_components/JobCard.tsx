"use client";

import { useMemo, useState } from "react";
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
  Users,
  Briefcase,
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

  const sourceLabel = p.source === "reed" ? "Reed" : p.source.charAt(0).toUpperCase() + p.source.slice(1);
  const openOnSourceLabel = `Open on ${sourceLabel}`;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-300 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums ${rankColor}`}>
              {entry.composite_rank ?? "—"}
            </span>
            <p className="text-xs text-slate-500 uppercase tracking-wider">{sourceLabel}</p>
            {p.posted_at && <p className="text-xs text-slate-400">· {postedAgo(p.posted_at)}</p>}
          </div>
          {p.source_url ? (
            <a
              href={p.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-semibold text-slate-900 leading-snug hover:text-blue-700 hover:underline decoration-blue-300 underline-offset-4"
            >
              {p.title}
            </a>
          ) : (
            <h3 className="text-base font-semibold text-slate-900 leading-snug">{p.title}</h3>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
            <span className="flex items-center gap-1"><Building2 size={13} className="text-slate-400" />{p.company}</span>
            {p.location_raw && <span className="flex items-center gap-1"><MapPin size={13} className="text-slate-400" />{p.location_raw}</span>}
            <WorkingModelBadge model={p.working_model} />
            <SalaryBadge min={p.salary_min} max={p.salary_max} currency={p.salary_currency} listed={p.salary_listed} />
            <CompanySizeBadge enrichment={p.enrichment} />
            {p.enrichment?.is_likely_recruiter && (
              <span
                className="flex items-center gap-1 rounded-md bg-amber-50 border border-amber-200 text-amber-700 px-1.5 py-0.5 text-xs"
                title="Employer looks like a recruitment agency (SIC 78* or curated name match)"
              >
                <Briefcase size={11} /> Recruiter
              </span>
            )}
          </div>
        </div>
        {p.source_url && (
          <a
            href={p.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium px-3 py-1.5"
            title={openOnSourceLabel}
          >
            {openOnSourceLabel}
            <ExternalLink size={13} />
          </a>
        )}
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
        <span>{expanded ? "Hide description & ranking" : "Show description & ranking"}</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Why it ranked here</p>
            <RankingExplanation entry={entry} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Description</p>
            <JdParagraphs text={p.jd_text} />
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

const SIZE_LABELS: Record<string, string> = {
  startup: "Startup",
  small: "Small",
  mid: "Mid",
  large: "Large",
  enterprise: "Enterprise",
};
const SIZE_STYLES: Record<string, string> = {
  startup: "bg-purple-50 border-purple-200 text-purple-700",
  small: "bg-sky-50 border-sky-200 text-sky-700",
  mid: "bg-emerald-50 border-emerald-200 text-emerald-700",
  large: "bg-indigo-50 border-indigo-200 text-indigo-700",
  enterprise: "bg-slate-100 border-slate-300 text-slate-700",
};

// Compact company-size chip on each job card. Renders one of three states:
//   1. Known bucket (Startup/Small/Mid/Large/Enterprise) — coloured chip, may
//      include a real employee count when iXBRL parse succeeded.
//   2. Enriched but bucket = unknown — dormant/dissolved matched entity or
//      the accounts-type field is missing. Grey "Unknown size" chip.
//   3. No enrichment row yet — waiting on the batch to catch up. Grey
//      "Size pending" chip so the user knows why the info is missing.
function CompanySizeBadge({
  enrichment,
}: {
  enrichment: {
    size_bucket: string | null;
    size_confidence: string | null;
    ch_employee_count: number | null;
    ch_company_name: string | null;
  } | null;
}) {
  // State 3: no enrichment row at all
  if (!enrichment) {
    return (
      <span
        className="flex items-center gap-1 rounded-md border border-dashed border-slate-300 bg-white text-slate-400 px-1.5 py-0.5 text-xs"
        title="Waiting for Companies House lookup on this employer. Should populate on the next run."
      >
        <Users size={11} />
        Size pending
      </span>
    );
  }
  const bucket = enrichment.size_bucket ?? "unknown";
  // State 2: enrichment row exists but size can't be determined
  if (bucket === "unknown") {
    return (
      <span
        className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 text-slate-500 px-1.5 py-0.5 text-xs"
        title={
          enrichment.ch_company_name
            ? `Matched to ${enrichment.ch_company_name} but its Companies House data doesn't identify a size (usually dormant, dissolved, or a small subsidiary).`
            : "Couldn't determine size from Companies House data."
        }
      >
        <Users size={11} />
        Size unknown
      </span>
    );
  }
  // State 1: known bucket
  const label = SIZE_LABELS[bucket] ?? bucket;
  const style = SIZE_STYLES[bucket] ?? "bg-slate-50 border-slate-200 text-slate-600";
  const employees = enrichment.ch_employee_count;
  const empLabel = employees ? ` · ${employees.toLocaleString("en-GB")} emp` : "";
  const tooltip = [
    enrichment.ch_company_name ? `CH: ${enrichment.ch_company_name}` : null,
    enrichment.size_confidence ? `confidence: ${enrichment.size_confidence}` : null,
    employees ? `${employees.toLocaleString("en-GB")} employees (avg during period)` : null,
  ].filter(Boolean).join(" · ");
  return (
    <span
      className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${style}`}
      title={tooltip || undefined}
    >
      <Users size={11} />
      {label}
      {empLabel}
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

// Render the JD as clean paragraphs. `\n\n` = paragraph, `\n- ` = bullet list.
function JdParagraphs({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="text-sm text-slate-700 leading-relaxed space-y-3 max-h-[36rem] overflow-y-auto pr-1">
      {blocks.map((b, i) =>
        b.kind === "list" ? (
          <ul key={i} className="list-disc pl-5 space-y-1">
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.text}</p>
        )
      )}
    </div>
  );
}

type Block = { kind: "para"; text: string } | { kind: "list"; items: string[] };

function splitBlocks(text: string): Block[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: Block[] = [];
  for (const para of paras) {
    const lines = para.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = lines.every((l) => /^[-•]\s+/.test(l));
    if (bullets && lines.length > 1) {
      out.push({ kind: "list", items: lines.map((l) => l.replace(/^[-•]\s+/, "")) });
    } else {
      out.push({ kind: "para", text: lines.join(" ") });
    }
  }
  return out;
}

function scoreTier(v: number | null | undefined): { border: string; bg: string; text: string; labelText: string; bar: string } {
  if (v == null) return { border: "border-slate-200", bg: "bg-slate-50", text: "text-slate-400", labelText: "text-slate-500", bar: "bg-slate-200" };
  if (v >= 75) return { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-800", labelText: "text-emerald-700", bar: "bg-emerald-500" };
  if (v >= 55) return { border: "border-blue-200", bg: "bg-blue-50", text: "text-blue-800", labelText: "text-blue-700", bar: "bg-blue-500" };
  if (v >= 35) return { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-800", labelText: "text-amber-700", bar: "bg-amber-500" };
  return { border: "border-rose-200", bg: "bg-rose-50", text: "text-rose-800", labelText: "text-rose-700", bar: "bg-rose-500" };
}

function ScoreTile({ label, value, comingSoon }: { label: string; value: number | null | undefined; comingSoon?: boolean }) {
  const tier = scoreTier(value);
  const pct = value != null ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className={`rounded-md border p-2 ${tier.border} ${tier.bg}`}>
      <p className={`text-[10px] uppercase tracking-wider font-semibold ${tier.labelText}`}>{label}</p>
      <div className="flex items-baseline gap-1 mt-0.5">
        {value != null ? (
          <>
            <p className={`text-sm font-semibold tabular-nums ${tier.text}`}>{value}</p>
            <p className={`text-[10px] tabular-nums ${tier.text} opacity-70`}>%</p>
          </>
        ) : (
          <p className="text-sm font-semibold text-slate-400">{comingSoon ? "next" : "—"}</p>
        )}
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-white/60 overflow-hidden">
        <div className={`h-full rounded-full ${tier.bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RankingExplanation({ entry }: { entry: ShortlistEntry }) {
  const scores = [
    { label: "Match to search", value: entry.match_to_search_score },
    { label: "Job quality", value: entry.quality_score },
    { label: "Match to you", value: entry.match_to_user_score, comingSoon: true },
    { label: "Career fit", value: entry.career_fit_score, comingSoon: true },
  ];
  const explanation = entry.ranking_explanation as Record<string, unknown> | null;
  const note = explanation?.note as string | undefined;
  const keywordHits = explanation?.keyword_hits as string[] | undefined;
  const qualityReasons = explanation?.quality_reasons as string[] | undefined;
  const salaryFit = explanation?.salary_fit as number | undefined;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {scores.map((s) => (
          <ScoreTile key={s.label} label={s.label} value={s.value} comingSoon={s.comingSoon} />
        ))}
      </div>
      {(keywordHits?.length || qualityReasons?.length || salaryFit !== undefined) && (
        <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3 space-y-2">
          {keywordHits && keywordHits.length > 0 && (
            <p className="text-xs text-slate-700">
              <span className="font-semibold text-slate-500 uppercase tracking-wider mr-2 text-[10px]">Keyword hits</span>
              {keywordHits.map((k) => (
                <span key={k} className="inline-block bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs text-slate-700 mr-1 mb-1">{k}</span>
              ))}
            </p>
          )}
          {qualityReasons && qualityReasons.length > 0 && (
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-slate-500 uppercase tracking-wider mr-2 text-[10px]">Quality</span>
              {qualityReasons.join(" · ")}
            </p>
          )}
          {salaryFit !== undefined && (
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-slate-500 uppercase tracking-wider mr-2 text-[10px]">Salary fit</span>
              {salaryFit}/100
            </p>
          )}
        </div>
      )}
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
