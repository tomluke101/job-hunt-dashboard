"use client";

import { useState, useEffect, useRef } from "react";
import {
  Building2, ExternalLink, Trash2, Plus, X,
  ClipboardList, Upload, AlertCircle, Pencil, CheckSquare,
} from "lucide-react";

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

const filterOptions: { label: string; value: Status | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Applied", value: "applied" },
  { label: "Interview", value: "interview" },
  { label: "Offer", value: "offer" },
  { label: "Rejected", value: "rejected" },
  { label: "Withdrawn", value: "withdrawn" },
];

const emptyForm: Omit<Application, "id"> = {
  role: "", company: "", location: "",
  status: "applied", stage: "Application Sent",
  appliedDate: new Date().toISOString().split("T")[0],
  salary: "", url: "",
};

// ── Date helpers ─────────────────────────────────────────────────────────────

function parseDate(raw: string): string {
  const today = new Date().toISOString().split("T")[0];
  if (!raw?.trim()) return today;

  // ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  // UK/EU slash or dot separated: DD/MM/YYYY, DD/MM/YY, DD.MM.YYYY
  const ukMatch = raw.trim().match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (ukMatch) {
    const [, d, m, y] = ukMatch;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // Written month: "14 Apr 2025", "April 14 2025", "14-Apr-25"
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];

  return today;
}

function displayDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "2-digit",
  });
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(Boolean);
  if (lines.length < 2) return [];

  function splitRow(row: string): string[] {
    const cells: string[] = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        if (inQuote && row[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        cells.push(cur.trim()); cur = "";
      } else cur += ch;
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
  if (s.includes("offer"))     return "offer";
  if (s.includes("reject"))    return "rejected";
  if (s.includes("withdraw"))  return "withdrawn";
  return "applied";
}

function mapRow(row: Record<string, string>): Omit<Application, "id"> | null {
  function pick(aliases: string[]) {
    for (const a of aliases) if (row[a] !== undefined && row[a] !== "") return row[a];
    return "";
  }
  const role = pick(COL_ALIASES.role);
  const company = pick(COL_ALIASES.company);
  if (!role && !company) return null;
  return {
    role:        role || "Unknown Role",
    company:     company || "Unknown Company",
    location:    pick(COL_ALIASES.location),
    status:      normaliseStatus(pick(COL_ALIASES.status)),
    stage:       pick(COL_ALIASES.stage) || "Application Sent",
    appliedDate: parseDate(pick(COL_ALIASES.appliedDate)),
    salary:      pick(COL_ALIASES.salary) || undefined,
    url:         pick(COL_ALIASES.url)    || undefined,
  };
}

// ── Form fields config ────────────────────────────────────────────────────────

const TEXT_FIELDS: { label: string; key: keyof Omit<Application, "id" | "status">; placeholder: string; type?: string }[] = [
  { label: "Role *",        key: "role",        placeholder: "e.g. Senior Product Manager" },
  { label: "Company *",     key: "company",     placeholder: "e.g. Monzo" },
  { label: "Location",      key: "location",    placeholder: "e.g. London, UK" },
  { label: "Salary",        key: "salary",      placeholder: "e.g. £80–100k" },
  { label: "Stage / Notes", key: "stage",       placeholder: "e.g. 1st Interview" },
  { label: "Date Applied",  key: "appliedDate", placeholder: "", type: "date" },
  { label: "Job URL",       key: "url",         placeholder: "https://...", type: "url" },
];

// ── Shared form UI ────────────────────────────────────────────────────────────

function AppForm({
  title,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  title: string;
  value: Omit<Application, "id">;
  onChange: (v: Omit<Application, "id">) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {TEXT_FIELDS.map(({ label, key, placeholder, type = "text" }) => (
          <div key={key}>
            <label className="text-xs font-medium text-slate-500 block mb-1">{label}</label>
            <input
              type={type}
              placeholder={placeholder}
              value={(value as Record<string, string>)[key] ?? ""}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
            />
          </div>
        ))}
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Status</label>
          <select
            value={value.status}
            onChange={(e) => onChange({ ...value, status: e.target.value as Status })}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 bg-white"
          >
            {Object.entries(statusLabels).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!value.role.trim() || !value.company.trim()}
          className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ApplicationTable() {
  const [apps, setApps]             = useState<Application[]>([]);
  const [filter, setFilter]         = useState<Status | "all">("all");
  const [search, setSearch]         = useState("");
  const [showAdd, setShowAdd]       = useState(false);
  const [addForm, setAddForm]       = useState<Omit<Application, "id">>(emptyForm);
  const [editId, setEditId]         = useState<string | null>(null);
  const [editForm, setEditForm]     = useState<Omit<Application, "id">>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<Status>("applied");
  const [preview, setPreview]       = useState<Omit<Application, "id">[] | null>(null);
  const [csvError, setCsvError]     = useState<string | null>(null);
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

  // ── Add ──
  function addApp() {
    if (!addForm.role.trim() || !addForm.company.trim()) return;
    save([{ ...addForm, id: crypto.randomUUID(), salary: addForm.salary || undefined, url: addForm.url || undefined }, ...apps]);
    setAddForm(emptyForm);
    setShowAdd(false);
  }

  // ── Edit ──
  function startEdit(app: Application) {
    setEditId(app.id);
    setEditForm({ role: app.role, company: app.company, location: app.location, status: app.status, stage: app.stage, appliedDate: app.appliedDate, salary: app.salary ?? "", url: app.url ?? "" });
    setShowAdd(false);
    setDeleteConfirm(null);
  }

  function saveEdit() {
    if (!editForm.role.trim() || !editForm.company.trim()) return;
    save(apps.map((a) => a.id === editId ? { ...editForm, id: a.id, salary: editForm.salary || undefined, url: editForm.url || undefined } : a));
    setEditId(null);
  }

  // ── Delete ──
  function deleteApp(id: string) {
    save(apps.filter((a) => a.id !== id));
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    setDeleteConfirm(null);
  }

  // ── Multi-select ──
  function toggleSelect(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((a) => a.id)));
  }

  function applyBulkStatus() {
    save(apps.map((a) => selected.has(a.id) ? { ...a, status: bulkStatus } : a));
    setSelected(new Set());
  }

  function bulkDelete() {
    save(apps.filter((a) => !selected.has(a.id)));
    setSelected(new Set());
  }

  // ── CSV ──
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setCsvError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseCSV(ev.target?.result as string);
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
    save([...preview.map((p) => ({ ...p, id: crypto.randomUUID() })), ...apps]);
    setPreview(null);
  }

  // ── Filtering ──
  const filtered = apps.filter((app) => {
    const matchesFilter = filter === "all" || app.status === filter;
    const matchesSearch = app.role.toLowerCase().includes(search.toLowerCase()) || app.company.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id));

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${filter === opt.value ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"}`}
            >
              {opt.label}
              {opt.value !== "all" && <span className="ml-1.5 text-xs opacity-60">{apps.filter((a) => a.status === opt.value).length}</span>}
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
            <Upload size={14} /> Bulk Upload
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
          </label>
          <button
            onClick={() => { setShowAdd(true); setEditId(null); setDeleteConfirm(null); }}
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
            <p className="text-red-500 text-xs mt-2">Expected columns: <span className="font-mono">Role, Company, Location, Status, Stage, Date Applied, Salary, URL</span></p>
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
                    {["Role", "Company", "Status", "Stage", "Date", "Salary"].map((h) => (
                      <th key={h} className="text-left px-4 py-2.5 font-semibold text-slate-500">{h}</th>
                    ))}
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
                      <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{displayDate(row.appliedDate)}</td>
                      <td className="px-4 py-2.5 text-slate-500">{row.salary || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              <p className="text-xs text-slate-400">Dates interpreted as DD/MM/YYYY. Status auto-detected.</p>
              <div className="flex gap-2">
                <button onClick={() => setPreview(null)} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-200 transition-colors">Cancel</button>
                <button onClick={confirmImport} className="text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors">
                  Import {preview.length} Application{preview.length !== 1 ? "s" : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <AppForm
          title="New Application"
          value={addForm}
          onChange={setAddForm}
          onSubmit={addApp}
          onCancel={() => setShowAdd(false)}
          submitLabel="Add Application"
        />
      )}

      {/* Edit form */}
      {editId && (
        <AppForm
          title="Edit Application"
          value={editForm}
          onChange={setEditForm}
          onSubmit={saveEdit}
          onCancel={() => setEditId(null)}
          submitLabel="Save Changes"
        />
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center mb-3">
              <ClipboardList size={20} className="text-slate-400" />
            </div>
            <p className="text-slate-700 font-medium text-sm mb-1">No applications yet</p>
            <p className="text-slate-400 text-xs mb-4">Add manually or upload your spreadsheet as a CSV</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors">
                <Plus size={14} /> Add Manually
              </button>
              <label className="flex items-center gap-1.5 text-sm bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium px-4 py-2 rounded-lg cursor-pointer transition-colors">
                <Upload size={14} /> Upload CSV
                <input type="file" accept=".csv" className="hidden" onChange={handleFile} />
              </label>
            </div>
            <p className="text-slate-400 text-xs mt-4">CSV columns: <span className="font-mono text-slate-500">Role, Company, Location, Status, Stage, Date Applied, Salary, URL</span></p>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-slate-300 text-blue-600 cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Role / Company</th>
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
                    <td colSpan={8} className="text-center py-10 text-slate-400 text-sm">No applications match your filter</td>
                  </tr>
                )}
                {filtered.map((app) => (
                  <tr
                    key={app.id}
                    className={`transition-colors group ${selected.has(app.id) ? "bg-blue-50/60" : "hover:bg-slate-50"}`}
                  >
                    <td className="px-4 py-3.5">
                      <input
                        type="checkbox"
                        checked={selected.has(app.id)}
                        onChange={() => toggleSelect(app.id)}
                        className="rounded border-slate-300 text-blue-600 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3.5">
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
                    <td className="px-4 py-3.5 text-slate-500 text-xs whitespace-nowrap">{displayDate(app.appliedDate)}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {app.url && (
                          <a href={app.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-blue-500 transition-colors">
                            <ExternalLink size={14} />
                          </a>
                        )}
                        <button onClick={() => startEdit(app)} className="text-slate-400 hover:text-blue-500 transition-colors">
                          <Pencil size={14} />
                        </button>
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
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                <Plus size={12} /> Add another
              </button>
            </div>
          </>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white rounded-2xl shadow-2xl px-5 py-3.5 flex items-center gap-4 z-40">
          <div className="flex items-center gap-2 text-sm">
            <CheckSquare size={15} className="text-blue-400" />
            <span className="font-medium">{selected.size} selected</span>
          </div>
          <div className="w-px h-5 bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Set status:</span>
            <select
              value={bulkStatus}
              onChange={(e) => setBulkStatus(e.target.value as Status)}
              className="text-sm bg-slate-800 border border-slate-700 text-white rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            >
              {Object.entries(statusLabels).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <button
              onClick={applyBulkStatus}
              className="text-sm bg-blue-600 hover:bg-blue-500 font-medium px-3 py-1 rounded-lg transition-colors"
            >
              Apply
            </button>
          </div>
          <div className="w-px h-5 bg-slate-700" />
          <button
            onClick={bulkDelete}
            className="text-sm text-red-400 hover:text-red-300 font-medium transition-colors"
          >
            Delete all
          </button>
          <button onClick={() => setSelected(new Set())} className="text-slate-500 hover:text-slate-300 transition-colors ml-1">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
