"use client";

import { useMemo, useState } from "react";
import {
  JOB_TYPE_LABELS,
  SENIORITY_LABELS,
  type JobType,
  type Seniority,
} from "@/lib/job-search/classify";
import {
  ExternalLink,
  Heart,
  X,
  Check,
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
  Sparkles,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { explainJobFit, type ShortlistEntry } from "@/app/actions/searches";

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
  // "Why this fits" — on-demand, cached per card. Seeded from the persisted
  // jd_fit_summary so a previously-generated read shows immediately on reload.
  const [fit, setFit] = useState<string | null>(entry.jd_fit_summary);
  const [fitLoading, setFitLoading] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);
  const [fitNudge, setFitNudge] = useState(false);

  async function handleExplainFit() {
    if (fitLoading) return; // cost-guard: one request in flight per card
    setFitLoading(true);
    setFitError(null);
    try {
      const res = await explainJobFit(entry.id);
      if (res.error) {
        setFitError(res.error);
      } else if (res.summary) {
        setFit(res.summary);
        setFitNudge(res.hadProfile === false);
      }
    } catch {
      setFitError("Something went wrong. Please try again.");
    } finally {
      setFitLoading(false);
    }
  }

  const p = entry.posting;
  if (!p) return null;

  const mustHaveHits = readStringArray(entry.ranking_explanation?.must_have_hits);

  const rankColor =
    (entry.composite_rank ?? 0) >= 75
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : (entry.composite_rank ?? 0) >= 55
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : "bg-slate-50 text-slate-600 border-slate-200";

  // "jsonld" is an implementation detail — to the user those jobs came straight
  // from the employer's own careers site, so say that.
  const sourceLabel =
    p.source === "reed"
      ? "Reed"
      : p.source === "jsonld"
      ? "Company site"
      : p.source.charAt(0).toUpperCase() + p.source.slice(1);
  const openOnSourceLabel = p.source === "jsonld" ? "Open on company site" : `Open on ${sourceLabel}`;

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
            <ClassifiedBadges
              employmentType={p.employment_type}
              seniority={p.seniority_hint}
              jobFunction={p.job_function}
            />
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

      {mustHaveHits.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <Check size={12} /> Matches what you asked for:
          </span>
          {mustHaveHits.map((h) => (
            <span
              key={h}
              className="inline-flex items-center rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs px-2 py-0.5"
            >
              {h}
            </span>
          ))}
        </div>
      )}

      <FitSection
        text={fit}
        loading={fitLoading}
        error={fitError}
        nudge={fitNudge}
        onExplain={handleExplainFit}
      />

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

// "Why this fits" panel. Four states: idle (button), loading, error (retry), and
// resolved (the read). The resolved text is stored as labelled lines ("Label: body")
// which we render as styled rows; any non-conforming line (or a legacy paragraph)
// falls back to plain prose so nothing ever renders as raw label soup.
function FitSection({
  text,
  loading,
  error,
  nudge,
  onExplain,
}: {
  text: string | null;
  loading: boolean;
  error: string | null;
  nudge: boolean;
  onExplain: () => void;
}) {
  if (text) {
    const lines = parseFitLines(text);
    return (
      <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <Sparkles size={12} className="text-blue-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">
            Why this fits
          </span>
        </div>
        <div className="space-y-1">
          {lines.map((ln, i) =>
            ln.label ? (
              <p key={i} className="text-sm leading-snug text-slate-700">
                <span className="font-semibold text-slate-900">{ln.label}:</span> {ln.body}
              </p>
            ) : (
              <p key={i} className="text-sm leading-snug text-slate-700">
                {ln.body}
              </p>
            )
          )}
        </div>
        {nudge && (
          <p className="mt-2 text-xs text-blue-700/80">
            This is a general read.{" "}
            <a
              href="/profile"
              className="font-medium underline decoration-blue-300 underline-offset-2 hover:text-blue-800"
            >
              Add your profile
            </a>{" "}
            for a take on how you fit.
          </p>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-600">
        <Loader2 size={13} className="animate-spin" /> Reading your fit…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 text-rose-700">
          <AlertCircle size={13} /> {error}
        </span>
        <button
          onClick={onExplain}
          className="font-medium text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onExplain}
      className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
      title="Get a short, honest read on how you fit this role"
    >
      <Sparkles size={13} /> Why this fits
    </button>
  );
}

type FitLine = { label: string | null; body: string };

// Parse the stored fit text into labelled rows. A line shaped "Label: body" (short
// label, then a colon) becomes a styled row; anything else is plain prose. Keeps the
// column a single string with no schema change and degrades gracefully for a legacy
// row saved as one paragraph.
function parseFitLines(text: string): FitLine[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^:]{2,40}):\s*(.+)$/);
      return m ? { label: m[1].trim(), body: m[2].trim() } : { label: null, body: l };
    });
}

/**
 * Job type / experience level / function, as classified at ingest.
 *
 * These are shown for the same reason the filters exist: a user who filters by
 * "Contract" must be able to SEE "Contract" on the cards that came back, or the
 * filter is a black box asking to be trusted. Absent values render nothing at all —
 * we never print "Unknown", because a job whose ad simply didn't state a level is
 * not a job with a defect, and a wall of "Unknown" chips would imply otherwise.
 */
function ClassifiedBadges({
  employmentType,
  seniority,
  jobFunction,
}: {
  employmentType: string | null;
  seniority: string | null;
  jobFunction: string | null;
}) {
  const type = employmentType ? (JOB_TYPE_LABELS[employmentType as JobType] ?? null) : null;
  const level = seniority ? (SENIORITY_LABELS[seniority as Seniority] ?? null) : null;

  return (
    <>
      {type && (
        <span className="rounded-md bg-slate-100 border border-slate-200 text-slate-700 px-1.5 py-0.5 text-xs">
          {type}
        </span>
      )}
      {level && (
        <span className="rounded-md bg-slate-100 border border-slate-200 text-slate-700 px-1.5 py-0.5 text-xs">
          {level}
        </span>
      )}
      {jobFunction && (
        <span className="rounded-md bg-violet-50 border border-violet-200 text-violet-700 px-1.5 py-0.5 text-xs">
          {jobFunction}
        </span>
      )}
    </>
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

function ScoreTile({
  label,
  value,
  naLabel,
  naTooltip,
}: {
  label: string;
  value: number | null | undefined;
  // Shown instead of a bare "—" when the axis genuinely can't be scored for this
  // job (e.g. meaning-match on an aggregator listing). A blank alone reads as a
  // bug; "n/a" + a reason reads as an honest answer.
  naLabel?: string;
  naTooltip?: string;
}) {
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
          <p className="text-sm font-semibold text-slate-400" title={naTooltip}>
            {naLabel ?? "—"}
          </p>
        )}
      </div>
      {value != null && (
        <div className="mt-1.5 h-1 rounded-full bg-white/60 overflow-hidden">
          <div className={`h-full rounded-full ${tier.bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function RankingExplanation({ entry }: { entry: ShortlistEntry }) {
  const explanation = entry.ranking_explanation as Record<string, unknown> | null;

  // "Match to you" is the semantic (embedding) match between this JD and the user's
  // own description. It's null for two honest reasons, and the card says which:
  //   • aggregator listings (Reed / Adzuna) — we only embed first-party JDs, so
  //     there is nothing to compare against for these;
  //   • a first-party role we haven't embedded yet, or a search with no free-text
  //     to match against.
  // A bare "—" reads as a bug, so the tile shows "n/a" and we explain below.
  const matchToYou = entry.match_to_user_score;
  const isFirstParty = explanation?.first_party === true;
  const matchToYouReason = isFirstParty
    ? "Match to you isn't scored for this role yet — it needs the meaning-match pass, which runs on employers' own listings."
    : "Match to you runs on jobs from an employer's own careers site. This one came from an aggregator, so there's nothing to meaning-match against.";

  const scores: Array<{ label: string; value: number | null | undefined; naTooltip?: string }> = [
    { label: "Match to search", value: entry.match_to_search_score },
    { label: "Job quality", value: entry.quality_score },
    {
      label: "Match to you",
      value: matchToYou,
      naTooltip: matchToYou == null ? matchToYouReason : undefined,
    },
  ];
  const note = explanation?.note as string | undefined;
  const keywordHits = explanation?.keyword_hits as string[] | undefined;
  const qualityReasons = explanation?.quality_reasons as string[] | undefined;
  const salaryFit = explanation?.salary_fit as number | undefined;
  const semanticScore = explanation?.semantic_score as number | null | undefined;
  const mustHaveHits = readStringArray(explanation?.must_have_hits);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {scores.map((s) => (
          <ScoreTile
            key={s.label}
            label={s.label}
            value={s.value}
            naLabel={s.label === "Match to you" && s.value == null ? "n/a" : undefined}
            naTooltip={s.naTooltip}
          />
        ))}
      </div>
      {matchToYou == null && (
        <p className="text-[11px] text-slate-500 leading-snug">
          <span className="font-semibold text-slate-400 uppercase tracking-wider mr-1.5 text-[10px]">Match to you</span>
          {matchToYouReason}
        </p>
      )}
      {(keywordHits?.length || qualityReasons?.length || salaryFit !== undefined || semanticScore != null || mustHaveHits.length > 0) && (
        <div className="rounded-md border border-slate-200 bg-slate-50/60 p-3 space-y-2">
          {mustHaveHits.length > 0 && (
            <p className="text-xs text-slate-700">
              <span className="font-semibold text-emerald-600 uppercase tracking-wider mr-2 text-[10px]">You asked for</span>
              {mustHaveHits.map((h) => (
                <span key={h} className="inline-block bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 text-xs text-emerald-700 mr-1 mb-1">{h}</span>
              ))}
            </p>
          )}
          {semanticScore != null && (
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-slate-500 uppercase tracking-wider mr-2 text-[10px]">Meaning match</span>
              {semanticScore}/100 — how closely this role matches what you described
            </p>
          )}
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

// ranking_explanation is stored JSONB (Record<string, unknown>), so pull typed
// arrays out defensively — an old row won't have must_have_hits at all.
function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function postedAgo(iso: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days === 0) return "posted today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}
