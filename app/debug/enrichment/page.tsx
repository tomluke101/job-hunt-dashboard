import PageHeader from "@/app/_components/PageHeader";
import StatCard from "@/app/_components/StatCard";
import { getEnrichmentSummary } from "@/app/actions/enrichment";
import EnrichmentActions from "./_components/EnrichmentActions";

export const dynamic = "force-dynamic";
// Backfill is bounded by BACKFILL_BUDGET_MS in the action; keep the wrapping
// serverless function a bit more generous.
export const maxDuration = 60;

const STATUS_ACCENT: Record<
  string,
  "green" | "amber" | "blue" | "red" | "purple"
> = {
  matched: "green",
  ambiguous: "amber",
  unmatched: "blue",
  pending: "purple",
  error: "red",
};

const STATUS_ORDER = ["matched", "ambiguous", "unmatched", "pending", "error"];
const SIZE_ORDER = ["startup", "small", "mid", "large", "enterprise", "unknown"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function EnrichmentDebugPage() {
  const s = await getEnrichmentSummary();

  const enrichmentPct = s.postings_total
    ? Math.round((s.postings_enriched / s.postings_total) * 100)
    : 0;

  return (
    <div className="p-8 max-w-6xl">
      <PageHeader
        title="Company enrichment"
        description="Companies House data cached per unique employer. Feeds Company Size, ranking, and the Employer Intel panel."
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Companies enriched"
          value={s.total}
          sub={`${s.recruiters_flagged} flagged as recruiters`}
          accent="blue"
        />
        <StatCard
          label="Real employee counts"
          value={s.with_employee_count}
          sub={
            s.total > 0
              ? `${Math.round((s.with_employee_count / s.total) * 100)}% of matched — from iXBRL accounts`
              : "From latest iXBRL statutory accounts"
          }
          accent="purple"
        />
        <StatCard
          label="Postings enriched"
          value={`${s.postings_enriched} / ${s.postings_total}`}
          sub={`${enrichmentPct}% of live postings`}
          accent="green"
        />
        <StatCard
          label="Postings pending"
          value={s.postings_missing}
          sub="Click 'Backfill' to work through them"
          accent={s.postings_missing > 0 ? "amber" : "green"}
        />
      </section>

      <EnrichmentActions initialRemaining={s.postings_missing} />

      <section className="mt-8 grid md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
            By status
          </h2>
          <div className="space-y-2">
            {STATUS_ORDER.map((k) => {
              const n = s.by_status[k] ?? 0;
              const accent = STATUS_ACCENT[k] ?? "blue";
              return (
                <div key={k} className="flex items-center justify-between">
                  <span className="text-sm text-slate-700 capitalize">{k}</span>
                  <span
                    className={`text-sm font-semibold ${
                      accent === "green"
                        ? "text-emerald-600"
                        : accent === "red"
                        ? "text-red-600"
                        : accent === "amber"
                        ? "text-amber-600"
                        : accent === "purple"
                        ? "text-purple-600"
                        : "text-blue-600"
                    }`}
                  >
                    {n}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
            By size bucket
          </h2>
          <div className="space-y-2">
            {SIZE_ORDER.map((k) => {
              const n = s.by_size[k] ?? 0;
              const label = k[0].toUpperCase() + k.slice(1);
              return (
                <div key={k} className="flex items-center justify-between">
                  <span className="text-sm text-slate-700">{label}</span>
                  <span className="text-sm font-semibold text-slate-900">{n}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-3 leading-snug">
            Rough headcount buckets from active officers × company age × entity
            type. Every row records a size_confidence so low-signal guesses can be
            greyed out when we surface this to users.
          </p>
        </div>
      </section>

      <section className="mt-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider p-5 pb-3">
          Recent enrichments
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-y border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-5 py-2 font-medium">Name</th>
                <th className="text-left px-5 py-2 font-medium">Status</th>
                <th className="text-left px-5 py-2 font-medium">Size</th>
                <th className="text-left px-5 py-2 font-medium">Conf.</th>
                <th className="text-left px-5 py-2 font-medium">Employees</th>
                <th className="text-left px-5 py-2 font-medium">Accounts</th>
                <th className="text-left px-5 py-2 font-medium">Officers</th>
                <th className="text-left px-5 py-2 font-medium">SIC</th>
                <th className="text-left px-5 py-2 font-medium">Recruiter</th>
                <th className="text-left px-5 py-2 font-medium">Refreshed</th>
              </tr>
            </thead>
            <tbody>
              {s.recent.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-5 py-6 text-slate-400 text-center">
                    No enrichments yet — run a search or click Backfill.
                  </td>
                </tr>
              )}
              {s.recent.map((r) => (
                <tr key={r.normalised_name} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-2.5">
                    <div className="text-slate-900 font-medium">
                      {r.ch_company_name ?? r.normalised_name}
                    </div>
                    {r.ch_company_name && (
                      <div className="text-[11px] text-slate-400">{r.normalised_name}</div>
                    )}
                    {r.enrichment_error && (
                      <div className="text-[11px] text-red-500 mt-0.5">{r.enrichment_error}</div>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        r.enrichment_status === "matched"
                          ? "bg-emerald-50 text-emerald-700"
                          : r.enrichment_status === "ambiguous"
                          ? "bg-amber-50 text-amber-700"
                          : r.enrichment_status === "unmatched"
                          ? "bg-slate-100 text-slate-600"
                          : r.enrichment_status === "error"
                          ? "bg-red-50 text-red-700"
                          : "bg-purple-50 text-purple-700"
                      }`}
                    >
                      {r.enrichment_status}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-slate-700">{r.size_bucket ?? "—"}</td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">{r.size_confidence ?? "—"}</td>
                  <td className="px-5 py-2.5 text-slate-700 text-sm">
                    {r.ch_employee_count !== null ? (
                      <span title={r.ch_employee_count_period_end ? `Period ended ${r.ch_employee_count_period_end}` : "From latest XBRL accounts"}>
                        {r.ch_employee_count.toLocaleString("en-GB")}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-xs" title={r.ch_employee_count_status ?? undefined}>
                        {r.ch_employee_count_status
                          ? r.ch_employee_count_status.replace(/^doc-too-large:/, ">").replace(/^error:/, "err:").replace(/^tag-not-found$/, "no tag").replace(/^filing-paper-only$/, "paper").replace(/^no-xhtml-resource$/, "no XBRL").replace(/^no-accounts-filing$/, "no filing")
                          : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">{r.ch_accounts_type ?? "—"}</td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">
                    {r.ch_officers_active_count !== null ? `${r.ch_officers_active_count} / ${r.ch_officers_total_count ?? "?"}` : "—"}
                  </td>
                  <td className="px-5 py-2.5 text-slate-500 text-xs">
                    {(r.ch_sic_codes ?? []).slice(0, 3).join(", ") || "—"}
                  </td>
                  <td className="px-5 py-2.5">
                    {r.is_likely_recruiter ? (
                      <span className="text-xs text-amber-700">yes</span>
                    ) : (
                      <span className="text-xs text-slate-400">no</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-slate-400 text-xs">
                    {formatDate(r.last_refreshed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {s.attention.length > 0 && (
        <section className="mt-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-5 pb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
              Needs attention
            </h2>
            <p className="text-xs text-slate-400">
              {s.attention.length} row{s.attention.length === 1 ? "" : "s"} — ambiguous matches, dormant shells, or missing data
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-y border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-5 py-2 font-medium">Company (as we saw it)</th>
                  <th className="text-left px-5 py-2 font-medium">Status</th>
                  <th className="text-left px-5 py-2 font-medium">Why?</th>
                  <th className="text-left px-5 py-2 font-medium">CH candidates</th>
                </tr>
              </thead>
              <tbody>
                {s.attention.map((r) => (
                  <tr key={r.normalised_name} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-5 py-3">
                      <div className="text-slate-900 font-medium">
                        {r.raw_names[0] ?? r.normalised_name}
                      </div>
                      {r.ch_company_name && (
                        <div className="text-[11px] text-slate-500 mt-0.5">→ {r.ch_company_name}</div>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          r.enrichment_status === "ambiguous"
                            ? "bg-amber-50 text-amber-700"
                            : r.enrichment_status === "unmatched"
                            ? "bg-slate-100 text-slate-600"
                            : r.enrichment_status === "error"
                            ? "bg-red-50 text-red-700"
                            : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {r.enrichment_status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600 max-w-xs">
                      {r.enrichment_status === "ambiguous" && (
                        <span>CH returned multiple close matches — pick was tied.</span>
                      )}
                      {r.enrichment_status === "unmatched" && (
                        <span>No confident match in Companies House.</span>
                      )}
                      {r.enrichment_status === "matched" && r.ch_accounts_type === "dormant" && (
                        <span>Matched entity files dormant accounts — probably a shell, not the operating company.</span>
                      )}
                      {r.enrichment_status === "matched" && r.ch_company_status && r.ch_company_status !== "active" && (
                        <span>Matched entity status: {r.ch_company_status}.</span>
                      )}
                      {r.enrichment_error && (
                        <div className="text-red-500 mt-1">{r.enrichment_error}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs">
                      {r.candidates.length > 0 ? (
                        <ul className="space-y-1">
                          {r.candidates.map((c) => (
                            <li key={c.company_number} className="text-slate-700">
                              <span className="font-mono text-[10px] text-slate-400 mr-1">
                                {c.company_number}
                              </span>
                              <span>{c.title}</span>
                              {c.company_status && (
                                <span className={`ml-1 text-[10px] ${c.company_status === "active" ? "text-emerald-600" : "text-slate-400"}`}>
                                  ({c.company_status})
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-8 bg-blue-50 border border-blue-100 rounded-xl p-5 text-sm text-slate-700 leading-relaxed">
        <p className="font-medium text-slate-900 mb-2">How to verify this is working</p>
        <ol className="list-decimal ml-5 space-y-1">
          <li>Run a search from <a href="/roles" className="text-blue-600 underline">/roles</a>. New postings should show up as new enrichment rows here.</li>
          <li>Click <em>Backfill</em> above to enrich any pre-existing postings from previous runs.</li>
          <li>Most rows should end up <span className="text-emerald-700 font-medium">matched</span>. Confidential / recruiter placeholders end up <span className="text-slate-600 font-medium">unmatched</span>. That's correct.</li>
          <li>Spot-check a well-known name (e.g. Tesco) — status should be <em>matched</em>, size should read <em>enterprise</em>.</li>
        </ol>
      </section>
    </div>
  );
}
