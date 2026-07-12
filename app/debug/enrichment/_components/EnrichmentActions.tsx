"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  backfillEnrichment,
  refreshCompany,
  reEnrichAll,
  type BackfillResult,
  type ReEnrichResult,
} from "@/app/actions/enrichment";

interface Props {
  initialRemaining: number;
}

export default function EnrichmentActions({ initialRemaining }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<BackfillResult | null>(null);
  const [reEnrichResult, setReEnrichResult] = useState<ReEnrichResult | null>(null);
  const [refreshName, setRefreshName] = useState("");
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(initialRemaining);

  function onBackfill() {
    startTransition(async () => {
      setLastResult(null);
      const result = await backfillEnrichment();
      setLastResult(result);
      setRemaining(result.remaining_postings);
      router.refresh();
    });
  }

  function onReEnrichAll() {
    startTransition(async () => {
      setReEnrichResult(null);
      const result = await reEnrichAll();
      setReEnrichResult(result);
      router.refresh();
    });
  }

  function onRefresh(e: React.FormEvent) {
    e.preventDefault();
    if (!refreshName.trim()) return;
    startTransition(async () => {
      setRefreshMsg(null);
      const r = await refreshCompany(refreshName.trim());
      setRefreshMsg(r.ok ? `Refreshed "${refreshName.trim()}"` : `Failed: ${r.error}`);
      router.refresh();
    });
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Backfill enrichment</h2>
          <p className="text-xs text-slate-500 mt-1">
            Enrich up to 300 postings that don&apos;t yet have a Companies House
            match. Companies House allows ~2 requests/second so this can take up
            to a minute per click. Safe to run repeatedly.
          </p>
        </div>
        <button
          type="button"
          onClick={onBackfill}
          disabled={pending || remaining === 0}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {pending ? "Working…" : remaining === 0 ? "Nothing to backfill" : `Backfill (${remaining} left)`}
        </button>
      </div>

      {lastResult && (
        <div className="border-t border-slate-100 pt-4 text-sm">
          {lastResult.error ? (
            <p className="text-red-600">Error: {lastResult.error}</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <ResultTile label="Companies matched" value={lastResult.matched} accent="emerald" />
              <ResultTile label="Ambiguous" value={lastResult.ambiguous} accent="amber" />
              <ResultTile label="Unmatched" value={lastResult.unmatched} accent="slate" />
              <ResultTile label="Errors" value={lastResult.errored} accent="red" />
              <ResultTile label="Postings updated" value={lastResult.processed_postings} accent="blue" />
              <ResultTile label="Deferred (over budget)" value={lastResult.deferred_companies} accent="slate" />
              <ResultTile label="Postings still pending" value={lastResult.remaining_postings} accent={lastResult.remaining_postings === 0 ? "emerald" : "amber"} />
              <ResultTile label="Elapsed" value={`${Math.round(lastResult.elapsed_ms / 100) / 10}s`} accent="slate" />
            </div>
          )}
        </div>
      )}

      <div className="border-t border-slate-100 pt-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Re-enrich all rows</h2>
          <p className="text-xs text-slate-500 mt-1">
            Force-refresh every cached company so it re-derives with the current
            heuristic. Use after a heuristic change (e.g. adding the statutory
            accounts-type signal). Bounded per click; keep clicking until
            &quot;Remaining stale&quot; hits 0.
          </p>
        </div>
        <button
          type="button"
          onClick={onReEnrichAll}
          disabled={pending}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {pending ? "Working…" : "Re-enrich all"}
        </button>
      </div>

      {reEnrichResult && (
        <div className="text-sm">
          {reEnrichResult.error ? (
            <p className="text-red-600">Error: {reEnrichResult.error}</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <ResultTile label="Attempted" value={reEnrichResult.attempted} accent="blue" />
              <ResultTile label="Succeeded" value={reEnrichResult.succeeded} accent="emerald" />
              <ResultTile label="Failed" value={reEnrichResult.failed} accent={reEnrichResult.failed ? "red" : "slate"} />
              <ResultTile label="Remaining stale" value={reEnrichResult.remaining_stale} accent={reEnrichResult.remaining_stale === 0 ? "emerald" : "amber"} />
              <ResultTile label="Elapsed" value={`${Math.round(reEnrichResult.elapsed_ms / 100) / 10}s`} accent="slate" />
            </div>
          )}
        </div>
      )}

      <form onSubmit={onRefresh} className="border-t border-slate-100 pt-4 flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="refresh-company" className="block text-xs font-medium text-slate-700 mb-1">
            Force-refresh a single company
          </label>
          <input
            id="refresh-company"
            type="text"
            value={refreshName}
            onChange={(e) => setRefreshName(e.target.value)}
            placeholder="Tesco PLC"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !refreshName.trim()}
          className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {pending ? "Working…" : "Refresh"}
        </button>
      </form>

      {refreshMsg && (
        <p className="text-xs text-slate-600 -mt-2">{refreshMsg}</p>
      )}
    </section>
  );
}

function ResultTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: "emerald" | "amber" | "red" | "blue" | "slate";
}) {
  const bg =
    accent === "emerald"
      ? "bg-emerald-50 text-emerald-700"
      : accent === "amber"
      ? "bg-amber-50 text-amber-700"
      : accent === "red"
      ? "bg-red-50 text-red-700"
      : accent === "blue"
      ? "bg-blue-50 text-blue-700"
      : "bg-slate-50 text-slate-600";
  return (
    <div className={`${bg} rounded-lg px-3 py-2`}>
      <div className="text-[11px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
    </div>
  );
}
