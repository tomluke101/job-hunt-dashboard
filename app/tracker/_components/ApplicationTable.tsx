"use client";

import { useState } from "react";
import { Building2, ExternalLink, ChevronDown } from "lucide-react";

type Status = "applied" | "interview" | "offer" | "rejected" | "withdrawn";

interface Application {
  id: number;
  role: string;
  company: string;
  location: string;
  status: Status;
  stage: string;
  appliedDate: string;
  salary?: string;
  notes?: string;
  url?: string;
}

const sampleData: Application[] = [
  { id: 1, role: "Senior Product Manager", company: "Monzo", location: "London, UK", status: "interview", stage: "2nd Interview", appliedDate: "2025-04-14", salary: "£90–110k", url: "#" },
  { id: 2, role: "Product Lead", company: "Revolut", location: "London, UK", status: "applied", stage: "Application Sent", appliedDate: "2025-04-12", salary: "£100–120k" },
  { id: 3, role: "Head of Product", company: "Wise", location: "London, UK", status: "rejected", stage: "Rejected after CV screen", appliedDate: "2025-04-10", salary: "£110–130k" },
  { id: 4, role: "Product Manager II", company: "Starling Bank", location: "London, UK", status: "interview", stage: "1st Interview", appliedDate: "2025-04-09", salary: "£80–95k" },
  { id: 5, role: "Group PM", company: "N26", location: "Remote", status: "applied", stage: "Application Sent", appliedDate: "2025-04-08", salary: "€95–115k" },
  { id: 6, role: "Principal PM", company: "Checkout.com", location: "London, UK", status: "offer", stage: "Offer Received", appliedDate: "2025-03-28", salary: "£120–140k" },
  { id: 7, role: "Senior PM", company: "GoCardless", location: "London, UK", status: "withdrawn", stage: "Withdrew", appliedDate: "2025-03-22", salary: "£85–100k" },
];

const statusStyles: Record<Status, string> = {
  applied: "bg-blue-50 text-blue-700 border-blue-200",
  interview: "bg-emerald-50 text-emerald-700 border-emerald-200",
  offer: "bg-purple-50 text-purple-700 border-purple-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  withdrawn: "bg-slate-100 text-slate-600 border-slate-200",
};

const statusLabels: Record<Status, string> = {
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const filterOptions: { label: string; value: Status | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Applied", value: "applied" },
  { label: "Interview", value: "interview" },
  { label: "Offer", value: "offer" },
  { label: "Rejected", value: "rejected" },
  { label: "Withdrawn", value: "withdrawn" },
];

export default function ApplicationTable() {
  const [filter, setFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");

  const filtered = sampleData.filter((app) => {
    const matchesFilter = filter === "all" || app.status === filter;
    const matchesSearch =
      app.role.toLowerCase().includes(search.toLowerCase()) ||
      app.company.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex items-center gap-2">
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${
                filter === opt.value
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"
              }`}
            >
              {opt.label}
              {opt.value !== "all" && (
                <span className="ml-1.5 text-xs opacity-60">
                  {sampleData.filter((a) => a.status === opt.value).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search role or company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-400"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Role / Company</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Location</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Salary</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Stage</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Applied</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-12 text-slate-400 text-sm">
                  No applications found
                </td>
              </tr>
            )}
            {filtered.map((app) => (
              <tr key={app.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
                      <Building2 size={14} className="text-slate-500" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-900 text-sm">{app.role}</p>
                      <p className="text-xs text-slate-500">{app.company}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3.5 text-slate-600 text-sm">{app.location}</td>
                <td className="px-4 py-3.5 text-slate-600 text-sm">{app.salary ?? "—"}</td>
                <td className="px-4 py-3.5">
                  <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${statusStyles[app.status]}`}>
                    {statusLabels[app.status]}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-slate-500 text-xs max-w-[160px] truncate">{app.stage}</td>
                <td className="px-4 py-3.5 text-slate-500 text-xs whitespace-nowrap">
                  {new Date(app.appliedDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}
                </td>
                <td className="px-4 py-3.5 text-right">
                  {app.url && (
                    <a href={app.url} className="text-slate-400 hover:text-blue-500 transition-colors">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-xs text-slate-400">{filtered.length} application{filtered.length !== 1 ? "s" : ""}</p>
          <p className="text-xs text-slate-400">Add past applications via Bulk Upload (CSV)</p>
        </div>
      </div>
    </div>
  );
}
