import Link from "next/link";
import StatCard from "./_components/StatCard";
import PageHeader from "./_components/PageHeader";
import {
  ArrowUpRight,
  Clock,
  CheckCircle2,
  XCircle,
  Building2,
  CalendarDays,
} from "lucide-react";

const recentApplications = [
  {
    id: 1,
    role: "Senior Product Manager",
    company: "Monzo",
    status: "interview",
    date: "2025-04-14",
    stage: "2nd Interview",
  },
  {
    id: 2,
    role: "Product Lead",
    company: "Revolut",
    status: "applied",
    date: "2025-04-12",
    stage: "Application Sent",
  },
  {
    id: 3,
    role: "Head of Product",
    company: "Wise",
    status: "rejected",
    date: "2025-04-10",
    stage: "Rejected",
  },
  {
    id: 4,
    role: "Product Manager II",
    company: "Starling Bank",
    status: "interview",
    date: "2025-04-09",
    stage: "1st Interview",
  },
  {
    id: 5,
    role: "Group PM",
    company: "N26",
    status: "applied",
    date: "2025-04-08",
    stage: "Application Sent",
  },
];

const statusConfig = {
  applied: { label: "Applied", color: "bg-blue-50 text-blue-700 border-blue-200" },
  interview: { label: "Interview", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "Rejected", color: "bg-red-50 text-red-700 border-red-200" },
  offer: { label: "Offer", color: "bg-purple-50 text-purple-700 border-purple-200" },
};

const upcomingEvents = [
  { id: 1, title: "2nd Interview — Monzo", date: "18 Apr", time: "10:00 AM" },
  { id: 2, title: "Intro Call — Starling Bank", date: "22 Apr", time: "2:30 PM" },
];

export default function DashboardPage() {
  return (
    <div className="p-8">
      <PageHeader
        title="Overview"
        description="Your job hunt at a glance"
      >
        <Link
          href="/tracker"
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Add Application
          <ArrowUpRight size={15} />
        </Link>
      </PageHeader>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Applied" value={24} sub="Since 1 Mar 2025" accent="blue" />
        <StatCard label="In Progress" value={6} sub="Active applications" accent="green" />
        <StatCard label="Interviews" value={4} sub="Scheduled or completed" accent="purple" />
        <StatCard label="Response Rate" value="38%" sub="Above avg of 20–25%" accent="amber" />
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Recent Applications */}
        <div className="col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <h2 className="font-semibold text-slate-900 text-sm">Recent Applications</h2>
            <Link href="/tracker" className="text-blue-600 text-xs font-medium hover:underline flex items-center gap-1">
              View all <ArrowUpRight size={12} />
            </Link>
          </div>
          <div className="divide-y divide-slate-50">
            {recentApplications.map((app) => {
              const s = statusConfig[app.status as keyof typeof statusConfig];
              return (
                <div key={app.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                  <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                    <Building2 size={15} className="text-slate-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{app.role}</p>
                    <p className="text-xs text-slate-500">{app.company}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${s.color}`}>
                      {app.stage}
                    </span>
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(app.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          {/* Upcoming */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">Upcoming</h2>
            </div>
            <div className="p-4 space-y-3">
              {upcomingEvents.map((e) => (
                <div key={e.id} className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-50 rounded-lg flex items-center justify-center shrink-0">
                    <CalendarDays size={14} className="text-blue-500" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-slate-800 leading-tight">{e.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{e.date} · {e.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Status breakdown */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="font-semibold text-slate-900 text-sm">Status Breakdown</h2>
            </div>
            <div className="p-4 space-y-2.5">
              {[
                { label: "Applied", count: 14, pct: 58, color: "bg-blue-500" },
                { label: "Interview", count: 4, pct: 17, color: "bg-emerald-500" },
                { label: "Offer", count: 2, pct: 8, color: "bg-purple-500" },
                { label: "Rejected", count: 4, pct: 17, color: "bg-red-400" },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between text-xs text-slate-600 mb-1">
                    <span>{row.label}</span>
                    <span className="font-medium">{row.count}</span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full ${row.color} rounded-full`} style={{ width: `${row.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick links */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Quick Actions</p>
            <div className="space-y-1.5">
              {[
                { href: "/cover-letter", label: "Generate Cover Letter" },
                { href: "/cv", label: "Tailor My CV" },
                { href: "/contacts", label: "Find a Contact" },
                { href: "/alerts", label: "Set Up Alerts" },
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
    </div>
  );
}
