"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  Loader2,
  Sparkles,
  AlertCircle,
  AlertTriangle,
  ArrowDownWideNarrow,
} from "lucide-react";
import {
  createSearch,
  deleteSearch,
  listShortlist,
  listRuns,
  countShortlistByState,
  runSearchNow,
  updateSearch,
  type Search,
  type ShortlistEntry,
  type ShortlistCounts,
  type RunRecord,
} from "@/app/actions/searches";
import SearchEditor from "./SearchEditor";
import JobCard from "./JobCard";
import RejectPicker from "./RejectPicker";

interface Props {
  initialSearches: Search[];
  initialActiveId: string | null;
  initialShortlist: ShortlistEntry[];
  initialRuns: RunRecord[];
  initialCounts: ShortlistCounts;
}

type PaneState = "new" | "interested" | "applied" | "rejected_user" | "deleted";

// In-results sort. "best" is the pipeline's composite rank (how the DB already
// returns rows), so it's the identity order — no client re-sort, no surprise.
type SortKey = "best" | "newest" | "salary";

const EMPTY_COUNTS: ShortlistCounts = { new: 0, interested: 0, applied: 0, rejected_user: 0, deleted: 0 };

export default function RolesClient({ initialSearches, initialActiveId, initialShortlist, initialRuns, initialCounts }: Props) {
  const router = useRouter();
  const [searches, setSearches] = useState(initialSearches);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [shortlist, setShortlist] = useState<ShortlistEntry[]>(initialShortlist);
  const [runs, setRuns] = useState<RunRecord[]>(initialRuns);
  const [pane, setPane] = useState<PaneState>("new");
  const [counts, setCounts] = useState<ShortlistCounts>(initialCounts);
  const [sortKey, setSortKey] = useState<SortKey>("best");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"create" | "edit">("create");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRunNotice, setLastRunNotice] = useState<{
    terms: string[];
    source: "keywords" | "target_titles" | "description" | "browse";
  } | null>(null);
  const [isRunning, startRun] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  const active = useMemo(() => searches.find((s) => s.id === activeId) ?? null, [searches, activeId]);
  const sortedShortlist = useMemo(() => sortShortlist(shortlist, sortKey), [shortlist, sortKey]);
  // How many visible cards are still waiting on a Companies House lookup. On a
  // fresh corpus this is most of them; enrichment warms the cache over the next
  // run(s). We say so ONCE, quietly, instead of leaving the user to wonder why
  // every card's size is blank.
  const pendingSizeCount = useMemo(
    () => shortlist.filter((e) => e.posting && !e.posting.enrichment).length,
    [shortlist]
  );

  async function refreshActive(searchId: string, keepPane: PaneState = pane) {
    const states: Record<PaneState, ("new" | "interested" | "applied" | "rejected_user" | "deleted")[]> = {
      new: ["new"],
      interested: ["interested"],
      applied: ["applied"],
      rejected_user: ["rejected_user"],
      deleted: ["deleted"],
    };
    // Shortlist AND runs. `setRuns` used to be called exactly once — at initial
    // state — so the Run Summary panel showed whichever search happened to be
    // active when the PAGE LOADED, for ever: switch search, it stayed; re-run the
    // search, it stayed. On a live run it cheerfully reported "ats_total: 0" over a
    // shortlist made entirely of SmartRecruiters jobs, because those numbers
    // belonged to a different search.
    //
    // A panel of numbers that silently belongs to something else is worse than no
    // panel: it is the stats equivalent of a source returning zero.
    const [list, runList, countList] = await Promise.all([
      listShortlist(searchId, { states: states[keepPane] }),
      listRuns(searchId),
      countShortlistByState(searchId),
    ]);
    setShortlist(list);
    setRuns(runList);
    setCounts(countList);
  }

  function switchSearch(id: string) {
    setActiveId(id);
    setPane("new");
    refreshActive(id, "new");
  }

  function openCreate() {
    setEditorMode("create");
    setEditorOpen(true);
  }
  function openEdit() {
    setEditorMode("edit");
    setEditorOpen(true);
  }

  async function handleSaved(saved: Search, isNew: boolean) {
    if (isNew) {
      setSearches((prev) => [saved, ...prev]);
      setActiveId(saved.id);
      await refreshActive(saved.id, "new");
    } else {
      setSearches((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
    }
    setEditorOpen(false);
  }

  function handleRun() {
    if (!active) return;
    setError(null);
    setLastRunNotice(null);
    startRun(async () => {
      const res = await runSearchNow(active.id);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.termsDerivedFrom === "description" && res.searchTermsUsed?.length) {
        setLastRunNotice({ terms: res.searchTermsUsed, source: "description" });
      } else if (res.termsDerivedFrom === "browse") {
        setLastRunNotice({ terms: [], source: "browse" });
      }
      await refreshActive(active.id, "new");
      setPane("new");
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!active) return;
    setError(null);
    startDelete(async () => {
      const res = await deleteSearch(active.id);
      if (res.error) {
        setError(res.error);
        setConfirmDeleteOpen(false);
        return;
      }
      const next = searches.filter((s) => s.id !== active.id);
      setSearches(next);
      const nextActive = next[0]?.id ?? null;
      setActiveId(nextActive);
      setPane("new");
      if (nextActive) await refreshActive(nextActive, "new");
      else {
        setShortlist([]);
        setCounts(EMPTY_COUNTS);
      }
      setConfirmDeleteOpen(false);
    });
  }

  async function handleDecide(id: string, state: "interested" | "applied" | "rejected_user" | "deleted", reason?: string) {
    const { decideShortlist } = await import("@/app/actions/searches");
    const res = await decideShortlist(id, state, reason);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (active) await refreshActive(active.id, pane);
  }

  async function handleRestore(id: string) {
    const { restoreShortlist } = await import("@/app/actions/searches");
    const res = await restoreShortlist(id);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (active) await refreshActive(active.id, pane);
  }

  return (
    <div className="mt-6 grid grid-cols-12 gap-6">
      {/* Left: search list */}
      <aside className="col-span-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Searches</h2>
          <button
            onClick={openCreate}
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            <Plus size={13} /> New
          </button>
        </div>
        <div className="space-y-1">
          {searches.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
              No searches yet. Create one to start pulling jobs.
            </div>
          )}
          {searches.map((s) => (
            <button
              key={s.id}
              onClick={() => switchSearch(s.id)}
              className={`w-full text-left rounded-lg px-3 py-2.5 border transition-all ${
                s.id === activeId
                  ? "bg-blue-50 border-blue-200 text-slate-900"
                  : "bg-white border-slate-200 text-slate-700 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium truncate flex-1">{s.name}</p>
                {!s.active && <span className="text-[10px] text-slate-400 uppercase">paused</span>}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {s.jobs_per_run}/run · {s.last_run_at ? relativeTime(s.last_run_at) : "never run"}
              </p>
            </button>
          ))}
        </div>
      </aside>

      {/* Right: shortlist */}
      <main className="col-span-9">
        {!active ? (
          <EmptyState onCreate={openCreate} />
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">{active.name}</h2>
                {active.description && <p className="text-sm text-slate-500 mt-0.5">{active.description}</p>}
                <RunSummary runs={runs} />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRun}
                  disabled={isRunning}
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-3.5 py-2 disabled:opacity-60"
                >
                  {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {isRunning ? "Running…" : "Run now"}
                </button>
                <button
                  onClick={openEdit}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium px-3 py-2"
                >
                  <Pencil size={13} /> Edit
                </button>
                <button
                  onClick={() => setConfirmDeleteOpen(true)}
                  disabled={isDeleting}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700 text-slate-700 text-sm font-medium px-3 py-2 disabled:opacity-60"
                  title="Delete search"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Something went wrong</p>
                  <p className="text-red-600/90 text-xs mt-0.5">{error}</p>
                </div>
                <button className="ml-auto text-red-500 hover:text-red-700 text-xs" onClick={() => setError(null)}>
                  dismiss
                </button>
              </div>
            )}

            {lastRunNotice && lastRunNotice.source === "description" && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                <Sparkles size={16} className="mt-0.5 shrink-0 text-blue-600" />
                <div className="flex-1">
                  <p className="font-medium">Searched from your description</p>
                  <p className="text-blue-700/90 text-xs mt-0.5">
                    No keywords or job titles set, so we searched for:{" "}
                    <span className="font-medium">{lastRunNotice.terms.join(", ")}</span>. Add specific
                    keywords or job titles in Edit for tighter results.
                  </p>
                </div>
                <button className="text-blue-500 hover:text-blue-700 text-xs" onClick={() => setLastRunNotice(null)}>
                  dismiss
                </button>
              </div>
            )}
            {lastRunNotice && lastRunNotice.source === "browse" && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                <Sparkles size={16} className="mt-0.5 shrink-0 text-blue-600" />
                <div className="flex-1">
                  <p className="font-medium">Browsing across sectors</p>
                  <p className="text-blue-700/90 text-xs mt-0.5">
                    No role type set, so we pulled jobs matching your filters (working model, salary, distance)
                    and ranked by quality &amp; salary-fit. Add specific keywords or job titles in Edit for a
                    role-focused search.
                  </p>
                </div>
                <button className="text-blue-500 hover:text-blue-700 text-xs" onClick={() => setLastRunNotice(null)}>
                  dismiss
                </button>
              </div>
            )}

            <PaneTabs
              value={pane}
              counts={counts}
              onChange={(next) => {
                setPane(next);
                if (active) refreshActive(active.id, next);
              }}
            />

            {shortlist.length > 1 && (
              <div className="mt-3 flex items-center justify-end">
                <SortControl value={sortKey} onChange={setSortKey} />
              </div>
            )}

            {pendingSizeCount >= 3 && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
                <Loader2 size={12} className="shrink-0 animate-spin text-slate-300" />
                Company size for {pendingSizeCount} of these is still being looked up — it fills in after the next run.
              </p>
            )}

            <div className="mt-4 space-y-3">
              {shortlist.length === 0 && (
                <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
                  <Sparkles size={20} className="mx-auto text-slate-400" />
                  <p className="mt-2 text-sm text-slate-600 font-medium">
                    {pane === "new"
                      ? "No new jobs yet. Hit Run now."
                      : `Nothing in ${paneLabel(pane).toLowerCase()}.`}
                  </p>
                  {pane === "new" && (
                    <p className="mt-1 text-xs text-slate-500">
                      We pull only jobs that match your filters; small numbers here mean the filter is doing its job.
                    </p>
                  )}
                </div>
              )}
              {sortedShortlist.map((entry) => (
                <JobCard
                  key={entry.id}
                  entry={entry}
                  onInterested={() => handleDecide(entry.id, "interested")}
                  onReject={() => setRejectingId(entry.id)}
                  onApplied={() => handleDecide(entry.id, "applied")}
                  onDelete={() => handleDecide(entry.id, "deleted")}
                  onRestore={() => handleRestore(entry.id)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {editorOpen && (
        <SearchEditor
          mode={editorMode}
          initial={editorMode === "edit" ? active ?? undefined : undefined}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      )}
      {rejectingId && (
        <RejectPicker
          onClose={() => setRejectingId(null)}
          onPick={async (reason) => {
            const id = rejectingId;
            setRejectingId(null);
            await handleDecide(id, "rejected_user", reason);
          }}
        />
      )}
      {confirmDeleteOpen && active && (
        <ConfirmDialog
          title={`Delete “${active.name}”?`}
          body={
            <>
              This removes the search and everything shortlisted under it
              {counts.new + counts.interested + counts.applied + counts.rejected_user + counts.deleted > 0 && (
                <>
                  {" "}
                  (<span className="font-medium text-slate-700">
                    {counts.new + counts.interested + counts.applied + counts.rejected_user + counts.deleted} job
                    {counts.new + counts.interested + counts.applied + counts.rejected_user + counts.deleted === 1 ? "" : "s"}
                  </span>
                  , including any you marked applied)
                </>
              )}
              . This can&apos;t be undone.
            </>
          }
          confirmLabel="Delete search"
          busy={isDeleting}
          onCancel={() => setConfirmDeleteOpen(false)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-8 rounded-xl border border-slate-200 bg-white p-10 text-center">
      <Sparkles className="mx-auto text-blue-500" size={28} />
      <h3 className="mt-3 text-lg font-semibold text-slate-900">Set up your first search</h3>
      <p className="mt-1 text-sm text-slate-600 max-w-md mx-auto">
        Describe what you want, set your essentials, run it. We'll surface only jobs worth reading and rank each one with reasons.
      </p>
      <button
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5"
      >
        <Plus size={14} /> New search
      </button>
    </div>
  );
}

function paneLabel(p: PaneState): string {
  return {
    new: "New",
    interested: "Interested",
    applied: "Applied",
    rejected_user: "Rejected",
    deleted: "Deleted",
  }[p];
}

function PaneTabs({
  value,
  counts,
  onChange,
}: {
  value: PaneState;
  counts: ShortlistCounts;
  onChange: (v: PaneState) => void;
}) {
  const tabs: PaneState[] = ["new", "interested", "applied", "rejected_user", "deleted"];
  return (
    <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
      {tabs.map((t) => {
        const n = counts[t];
        const activeTab = value === t;
        return (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {paneLabel(t)}
            <span
              className={`inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                activeTab
                  ? "bg-blue-100 text-blue-700"
                  : n > 0
                    ? "bg-slate-100 text-slate-600"
                    : "bg-transparent text-slate-300"
              }`}
            >
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "best", label: "Best match" },
  { key: "newest", label: "Newest" },
  { key: "salary", label: "Highest salary" },
];

function SortControl({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      <ArrowDownWideNarrow size={13} className="text-slate-400" />
      <span>Sort</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Client-side re-order of the already-fetched shortlist. "Best match" is the
// identity order (the DB returns composite_rank desc), so it's a no-op — never
// re-sorting on the default means the pipeline's ranking is what the user sees
// unless they deliberately ask for something else.
//   newest  — posted date, falling back to when we first saw it; undated last.
//   salary  — top of the listed range; jobs with no listed salary sink to the
//             bottom rather than pretending to be £0.
function sortShortlist(entries: ShortlistEntry[], key: SortKey): ShortlistEntry[] {
  if (key === "best") return entries;
  const copy = [...entries];
  if (key === "newest") {
    copy.sort((a, b) => dateValue(b) - dateValue(a));
  } else if (key === "salary") {
    copy.sort((a, b) => salaryValue(b) - salaryValue(a));
  }
  return copy;
}

function dateValue(e: ShortlistEntry): number {
  const iso = e.posting?.posted_at ?? e.seen_at;
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

function salaryValue(e: ShortlistEntry): number {
  const p = e.posting;
  if (!p || !p.salary_listed) return -1;
  return p.salary_max ?? p.salary_min ?? -1;
}

// A real, styled confirmation modal in place of the browser's native confirm().
// Overlay-click and Escape both cancel; the confirm button is auto-focused and
// styled destructive so an accidental Enter can't quietly nuke a search.
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0 rounded-full bg-red-100 p-2">
              <AlertTriangle size={16} className="text-red-600" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900">{title}</h3>
              <p className="mt-1 text-sm text-slate-600">{body}</p>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 rounded-b-xl border-t border-slate-200 bg-slate-50 p-4">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunSummary({ runs }: { runs: RunRecord[] }) {
  const latest = runs[0];
  const [expanded, setExpanded] = useState(false);
  if (!latest || !latest.finished_at) return null;
  const sources = latest.source_counts ?? {};
  const drops = (latest.filter_drops ?? {}) as Record<string, number>;
  const dedupe = (latest.dedupe_stats ?? {}) as Record<string, unknown>;
  // Warnings the pipeline recorded but nothing ever showed: a postcode that
  // wouldn't resolve (distance filter silently OFF), a source that returned zero
  // or failed, an empty ATS corpus. These are exactly the silent failures this
  // product keeps getting bitten by, so they render loudly, not behind "details".
  const warnings = Array.isArray(dedupe.warnings) ? (dedupe.warnings as string[]) : [];
  const dropSum = Object.values(drops).reduce((a, b) => a + (b ?? 0), 0);
  const sourceStr = Object.entries(sources).map(([k, v]) => `${k}: ${v}`).join(", ") || "—";

  // Human-readable labels for each drop reason.
  const DROP_LABEL: Record<string, string> = {
    title_irrelevant: "title didn't match",
    salary_floor: "under salary floor",
    hidden_salary: "no salary listed",
    working_model: "wrong working model",
    industry_exclude: "excluded industry",
    expired: "job expired",
    already_decided: "already decided (rejected / applied / interested)",
    company_size: "company size didn't match",
    recruiter: "posted by a recruitment agency",
    // The three classified dimensions. Each is reported separately so a user who
    // ticks "Contract", gets three results and assumes the product is empty can
    // instead SEE that the job-type filter removed 140.
    job_type: "job type didn't match",
    seniority: "experience level didn't match",
    job_function: "job function didn't match",
    location_distance: "further away than your radius",
    location_foreign: "not a UK job",
    location_unresolved: "couldn't place the location",
    pruned_stale: "no longer in the results",
  };
  const rankedPool = (dedupe.ranked_pool as number | undefined) ?? undefined;
  const target = (dedupe.jobs_per_run_target as number | undefined) ?? undefined;
  const sizeByBucket = (dedupe.size_drops_by_bucket as Record<string, number> | undefined) ?? {};

  const dropRows = Object.entries(drops)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  return (
    <div className="mt-1 text-xs text-slate-500">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="hover:text-slate-700"
      >
        Last run {relativeTime(latest.finished_at)} · pulled from {sourceStr} · dropped {dropSum} by filters · {latest.shortlist_count ?? 0} shortlisted
        {" "}
        <span className="text-slate-400 underline decoration-dotted">{expanded ? "hide" : "details"}</span>
      </button>
      {warnings.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-1.5 text-amber-800">
            <AlertTriangle size={13} className="shrink-0" />
            <p className="text-[10px] font-semibold uppercase tracking-wider">
              {warnings.length === 1 ? "Warning — results may be affected" : `${warnings.length} warnings — results may be affected`}
            </p>
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-amber-700 list-disc list-inside">
            {warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {expanded && (
        <div className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
          {target && (
            <p className="text-slate-600">
              Target: <span className="font-medium">{target}</span> jobs · ranked pool: <span className="font-medium">{rankedPool ?? "—"}</span> · shortlisted: <span className="font-medium text-slate-900">{latest.shortlist_count ?? 0}</span>
            </p>
          )}
          {dropRows.length > 0 && (
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-[10px] font-semibold mb-1">Filter drops</p>
              <ul className="space-y-0.5">
                {dropRows.map(([k, n]) => (
                  <li key={k} className="flex items-center justify-between gap-3">
                    <span className="text-slate-600">{DROP_LABEL[k] ?? k}</span>
                    <span className="tabular-nums font-medium text-slate-800">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(drops.company_size ?? 0) > 0 && Object.values(sizeByBucket).some((v) => v > 0) && (
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-[10px] font-semibold mb-1">Sizes filtered out</p>
              <ul className="space-y-0.5">
                {Object.entries(sizeByBucket)
                  .filter(([, v]) => v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([bucket, n]) => (
                    <li key={bucket} className="flex items-center justify-between gap-3">
                      <span className="text-slate-600 capitalize">{bucket}</span>
                      <span className="tabular-nums font-medium text-slate-800">{n}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {(latest.shortlist_count ?? 0) < (target ?? 0) && (
            <p className="text-slate-600 leading-relaxed pt-1 border-t border-slate-200">
              Fewer results than you asked for. If most drops are &quot;company size&quot;, either tick more size buckets, tick &quot;include jobs where we can&apos;t tell size&quot;, or accept that few large-employer jobs came through this pull.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
