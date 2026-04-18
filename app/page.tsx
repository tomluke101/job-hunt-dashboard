import Link from "next/link";
import { ArrowUpRight, Building2, ClipboardList } from "lucide-react";
import StatCard from "./_components/StatCard";
import PageHeader from "./_components/PageHeader";
import { getApplications } from "@/app/actions/applications";
import type { Status } from "@/app/actions/applications";

const statusStyles: Record<Status, string> = {
  applied:   "bg-blue-50 text-blue-700 border-blue-200",
  interview: "bg-emerald-50 text-emerald-700 border-emerald-200",
  offer:     "bg-purple-50 text-purple-700 border-purple-200",
  rejected:  "bg-red-50 text-red-700 border-red-200",
  withdrawn: "bg-slate-100 text-slate-600 border-slate-200",
};

const statusLabels: Record<Status, string> = {
  applied:   "Applied",
  interview: "Interview",
  offer:     "Offer",
  rejected:  "Rejected",
  withdrawn: "Withdrawn",
};

const breakdownColors: Record<Status, string> = {
  applied:   "bg-blue-500",
  interview: "bg-emerald-500",
  offer:     "bg-purple-500",
  rejected:  "bg-red-400",
  withdrawn: "bg-slate-300",
};

function displayDate(iso: string) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function DashboardPage() {
  const apps = await getApplications();

  const total = apps.length;
  const inProgress = apps.filter((a) => a.status === "applied" || a.status === "interview").length;
  const interviews = apps.filter((a) => a.status === "interview").length;
  const responseRate = total > 0
    ? Math.round(((total - apps.filter((a) => a.status === "applied").length) / total) * 100)
    : 0;

  const recent = [...apps]
    .sort((a, b) => (b.applied_date ?? "").localeCompare(a.applied_date ?? ""))
    .slice(0, 5);

  const breakdown = (["applied", "interview", "offer", "rejected", "withdrawn"] as Status[])
    .map((s) => ({ label: statusLabels[s], count: apps.filter((a) => a.status === s).length, color: breakdownColors[s] }))
    .filter((row) => row.count > 0);

  const isEmpty = total === 0;

  return (
    <div className="p-8">
      <PageHeader title="Overview" description="Your job hunt at a glance">
        <Link
          href="/tracker"
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Add Application
          <ArrowUpRight size={15} />
        </Link>
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Applied"  value={total}      sub={total === 0 ? "None yet" : "All time"}               accent="blue"   />
        <StatCard label="In Progress"    value={inProgress} sub="Applied or interviewing"                              accent="green"  />
        <StatCard label="Interviews"     value={interviews} sub="Scheduled or completed"                               accent="purple" />
        <StatCard label="Response Rate"  value={total > 0 ? `${responseRate}%` : "—"} sub={total > 0 ? "Of all applications" : "Add applications to track"} accent="amber" />
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
            <ClipboardList size={22} className="text-slate-400" />
          </div>
          <p className="text-slate-700 font-semibold text-base mb-1">No applications yet</p>
          <p className="text-slate-400 text-sm mb-5">Start tracking your job hunt to see stats and insights here</p>
          <Link
            href="/tracker"
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            Add Your First Application
            <ArrowUpRight size={15} />
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">Recent Applications</h2>
              <Link href="/tracker" className="text-blue-600 text-xs font-medium hover:underline flex items-center gap-1">
                View all <ArrowUpRight size={12} />
              </Link>
            </div>
            <div className="divide-y divide-slate-50">
              {recent.map((app) => (
                <div key={app.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                  <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                    <Building2 size={15} className="text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{app.role}</p>
                    <p className="text-xs text-slate-500">{app.company}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${statusStyles[app.status]}`}>
                      {app.stage || statusLabels[app.status]}
                    </span>
                    <p className="text-xs text-slate-400 mt-1">{displayDate(app.applied_date)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
              <div className="px-5 py-4 border-b border-slate-100">
                <h2 className="font-semibold text-slate-900 text-sm">Status Breakdown</h2>
              </div>
              <div className="p-4 space-y-2.5">
                {breakdown.map((row) => (
                  <div key={row.label}>
                    <div className="flex justify-between text-xs text-slate-600 mb-1">
                      <span>{row.label}</span>
                      <span className="font-medium">{row.count}</span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full ${row.color} rounded-full`} style={{ width: `${Math.round((row.count / total) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Quick Actions</p>
              <div className="space-y-1.5">
                {[
                  { href: "/cover-letter", label: "Generate Cover Letter" },
                  { href: "/cv",           label: "Tailor My CV" },
                  { href: "/contacts",     label: "Find a Contact" },
                  { href: "/alerts",       label: "Set Up Alerts" },
                ].map((a) => (
                  <Link
                    key={a.href}
                    href={a.href}
                    className="flex items-center justify-between text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors"
                  >
                    {a.label}
                    <ArrowUpRight size={13} />
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
