"use client";

import { useState, useEffect, useRef } from "react";
import { Building2, ExternalLink, Trash2, Plus, X, ClipboardList, Upload, AlertCircle } from "lucide-react";

type Status = "applied" | "interview" | "offer" | "rejected" | "withdrawn";

interface Application {
  id: string;
  role: string;
  company: string;
  location: string;
  status: Status;
  stage: string;
  appliedDate: string;
  salary?: string;
  url?: string;
}

const STORAGE_KEY = "job-hunt-applications";

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

const emptyForm = {
  role: "",
  company: "",
  location: "",
  status: "applied" as Status,
  stage: "Application Sent",
  appliedDate: new Date().toISOString().split("T")[0],
  salary: "",
  url: "",
};

// --- CSV parsing ---

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  function splitRow(row: string): string[] {
    const cells: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        if (inQuote && row[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === "," && !inQuote) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  const headers = splitRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

const COL_ALIASES: Record<keyof Omit<Application, "id">, string[]> = {
  role:        ["role", "jobtitle", "title", "position", "job"],
  company:     ["company", "employer", "organisation", "organization", "firm"],
  location:    ["location", "city", "place", "office", "country"],
  status:      ["status", "state", "applicationstatus"],
  stage:       ["stage", "notes", "note", "currentstage", "update"],
  appliedDate: ["applieddate", "dateapplied", "date", "applied", "appliedon"],
  salary:      ["salary", "salaryrange", "pay", "compensation", "comp", "tc", "package"],
  url:         ["url", "link", "joburl", "joblink", "href", "jobposting"],
};

function normaliseStatus(raw: string): Status {
  const s = raw.toLowerCase().trim();
  if (s.includes("interview")) return "interview";
  if (s.includes("offer")) return "offer";
  if (s.includes("reject")) return "rejected";
  if (s.includes("withdraw")) return "withdrawn";
  return "applied";
}

function mapRow(row: Record<string, string>): Omit<Application, "id"> | null {
  function pick(aliases: string[]) {
    for (const a of aliases) {
      if (row[a] !== undefined && row[a] !== "") return row[a];
    }
    return "";
  }

  const role = pick(COL_ALIASES.role);
  const company = pick(COL_ALIASES.company);
  if (!role && !company) return null;

  const rawDate = pick(COL_ALIASES.appliedDate);
  let appliedDate = new Date().toISOString().split("T")[0];
  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) appliedDate = d.toISOString().split("T")[0];
  }

  return {
    role: role || "Unknown Role",
    company: company || "Unknown Company",
    location: pick(COL_ALIASES.location),
    status: normaliseStatus(pick(COL_ALIASES.status)),
    stage: pick(COL_ALIASES.stage) || "Application Sent",
    appliedDate,
    salary: pick(COL_ALIASES.salary) || undefined,
    url: pick(COL_ALIASES.url) || undefined,
  };
}

// --- Component ---

export default function ApplicationTable() {
  const [apps, setApps] = useState<Application[]>([]);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [preview, setPreview] = useState<Omit<Application, "id">[] | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setApps(JSON.parse(stored));
    } catch {}
  }, []);

  function save(updated: Application[]) {
    setApps(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }

  function addApp() {
    if (!form.role.trim() || !form.company.trim()) return;
    save([{ ...form, id: crypto.randomUUID(), salary: form.salary || undefined, url: form.url || undefined }, ...apps]);
    setForm(emptyForm);
    setShowForm(false);
  }

  function deleteApp(id: string) {
    save(apps.filter((a) => a.id !== id));
    setDeleteConfirm(null);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileRef.current) return;
    fileRef.current.value = "";
    if (!file) return;
    setCsvError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      const mapped = rows.map(mapRow).filter(Boolean) as Omit<Application, "id">[];
      if (mapped.length === 0) {
        setCsvError("No valid rows found. Make sure your CSV has at least Role and Company columns.");
        return;
      }
      setPreview(mapped);
    };
    reader.onerror = () => setCsvError("Could not read the file.");
    reader.readAsText(file);
  }

  function confirmImport() {
    if (!preview) return;
    const imported: Application[] = preview.map((p) => ({ ...p, id: crypto.randomUUID() }));
    save([...imported, ...apps]);
    setPreview(null);
  }

  const filtered = apps.filter((app) => {
    const matchesFilter = filter === "all" || app.status === filter;
    const matchesSearch =
      app.role.toLowerCase().includes(search.toLowerCase()) ||
      app.company.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
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
                  {apps.filter((a) => a.status === opt.value).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 w-44 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-400"
          />
          <label className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-700 text-sm font-medium px-3 py-1.5 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors">
            <Upload size={14} />
            Bulk Upload
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
          </label>
          <button
            onClick={() => { setShowForm(true); setDeleteConfirm(null); }}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      {/* CSV error */}
      {csvError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Upload failed</p>
            <p className="text-red-600 text-xs mt-0.5">{csvError}</p>
            <p className="text-red-500 text-xs mt-2">
              Expected columns (any order, flexible naming):{" "}
              <span className="font-mono">Role, Company, Location, Status, Stage, Date Applied, Salary, URL</span>
            </p>
          </div>
          <button onClick={() => setCsvError(null)} className="ml-auto text-red-400 hover:text-red-600"><X size={14} /></button>
        </div>
      )}

      {/* CSV preview modal */}
      {preview && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="font-semibold text-slate-900">Import Preview</h2>
                <p className="text-xs text-slate-500 mt-0.5">{preview.length} row{preview.length !== 1 ? "s" : ""} found — review before importing</p>
              </div>
              <button onClick={() => setPreview(null)} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Role</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Company</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Status</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Stage</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Date</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-slate-500">Salary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {preview.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 text-slate-800 font-medium">{row.role}</td>
                      <td className="px-4 py-2.5 text-slate-600">{row.company}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex text-xs font-medium px-1.5 py-0.5 rounded-full border ${statusStyles[row.status]}`}>
                          {statusLabels[row.status]}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{row.stage}</td>
                      <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">
                        {new Date(row.appliedDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" })}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{row.salary || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              <p className="text-xs text-slate-400">Status is auto-detected from your data. You can edit rows after importing.</p>
              <div className="flex gap-2">
                <button onClick={() => setPreview(null)} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-200 transition-colors">
                  Cancel
                </button>
                <button onClick={confirmImport} className="text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors">
                  Import {preview.length} Application{preview.length !== 1 ? "s" : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showForm && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-900 text-sm">New Application</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Role *", key: "role", placeholder: "e.g. Senior Product Manager", type: "text" },
              { label: "Company *", key: "company", placeholder: "e.g. Monzo", type: "text" },
              { label: "Location", key: "location", placeholder: "e.g. London, UK", type: "text" },
              { label: "Salary", key: "salary", placeholder: "e.g. £80–100k", type: "text" },
              { label: "Stage / Notes", key: "stage", placeholder: "e.g. 1st Interview", type: "text" },
              { label: "Date Applied", key: "appliedDate", placeholder: "", type: "date" },
              { label: "Job URL", key: "url", placeholder: "https://...", type: "url" },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key}>
                <label className="text-xs font-medium text-slate-500 block mb-1">{label}</label>
                <input
                  type={type}
                  placeholder={placeholder}
                  value={(form as Record<string, string>)[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                />
              </div>
            ))}
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 bg-white"
              >
                {Object.entries(statusLabels).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setShowForm(false)} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button
              onClick={addApp}
              disabled={!form.role.trim() || !form.company.trim()}
              className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Add Application
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mb-3">
              <ClipboardList size={20} className="text-slate-400" />
            </div>
            <p className="text-slate-700 font-medium text-sm mb-1">No applications yet</p>
            <p className="text-slate-400 text-xs mb-4">Add manually or upload your existing spreadsheet as a CSV</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors">
                <Plus size={14} /> Add Manually
              </button>
              <label className="flex items-center gap-1.5 text-sm bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium px-4 py-2 rounded-lg cursor-pointer transition-colors">
                <Upload size={14} /> Upload CSV
                <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
              </label>
            </div>
            <p className="text-slate-400 text-xs mt-4">
              CSV columns: <span className="font-mono text-slate-500">Role, Company, Location, Status, Stage, Date Applied, Salary, URL</span>
            </p>
          </div>
        ) : (
          <>
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
                    <td colSpan={7} className="text-center py-10 text-slate-400 text-sm">
                      No applications match your filter
                    </td>
                  </tr>
                )}
                {filtered.map((app) => (
                  <tr key={app.id} className="hover:bg-slate-50 transition-colors group">
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
                    <td className="px-4 py-3.5 text-slate-600 text-sm">{app.location || "—"}</td>
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
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {app.url && (
                          <a href={app.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-blue-500 transition-colors">
                            <ExternalLink size={14} />
                          </a>
                        )}
                        {deleteConfirm === app.id ? (
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => deleteApp(app.id)} className="text-xs text-red-600 font-medium hover:text-red-700">Delete</button>
                            <button onClick={() => setDeleteConfirm(null)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                          </div>
                        ) : (
                          <button onClick={() => setDeleteConfirm(app.id)} className="text-slate-400 hover:text-red-500 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
              <p className="text-xs text-slate-400">{filtered.length} of {apps.length} application{apps.length !== 1 ? "s" : ""}</p>
              <button onClick={() => setShowForm(true)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                <Plus size={12} /> Add another
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
