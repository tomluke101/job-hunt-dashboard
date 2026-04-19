"use client";

import { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Building2, ExternalLink, Trash2, Plus, X,
  ClipboardList, Upload, AlertCircle, Pencil, CheckSquare, Download, FileText, Maximize2, Sparkles,
} from "lucide-react";
import {
  Application, Status,
  createApplication, updateApplication, deleteApplication,
  bulkUpdateStatus, bulkDeleteApplications, bulkImportApplications,
} from "@/app/actions/applications";

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
  { label: "All",       value: "all" },
  { label: "Applied",   value: "applied" },
  { label: "Interview", value: "interview" },
  { label: "Offer",     value: "offer" },
  { label: "Rejected",  value: "rejected" },
  { label: "Withdrawn", value: "withdrawn" },
];

type FormData = Omit<Application, "id" | "user_id" | "created_at">;

const emptyForm: FormData = {
  role: "", company: "", location: "",
  status: "applied", stage: "Application Sent",
  applied_date: new Date().toISOString().split("T")[0],
  salary: "", url: "", notes: "", category: "",
  work_location: undefined, job_description: "",
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDate(raw: string): string {
  const today = new Date().toISOString().split("T")[0];
  if (!raw?.trim()) return today;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  const ukMatch = raw.trim().match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/);
  if (ukMatch) {
    const [, d, m, y] = ukMatch;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split("T")[0];

  return today;
}

function displayDate(iso: string) {
  if (!iso) return "—";
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

const COL_ALIASES: Record<string, string[]> = {
  role:         ["role", "jobtitle", "title", "position", "job"],
  company:      ["company", "employer", "organisation", "organization", "firm"],
  location:     ["location", "city", "place", "office", "country"],
  status:       ["status", "state", "applicationstatus"],
  stage:        ["stage", "currentstage", "update"],
  applied_date: ["applieddate", "dateapplied", "date", "applied", "appliedon"],
  salary:       ["salary", "salaryrange", "pay", "compensation", "comp", "tc", "package"],
  url:          ["url", "link", "joburl", "joblink", "href", "jobposting"],
  notes:        ["notes", "note", "comments", "comment"],
};

function normaliseStatus(raw: string): Status {
  const s = raw.toLowerCase().trim();
  if (s.includes("interview")) return "interview";
  if (s.includes("offer"))     return "offer";
  if (s.includes("reject"))    return "rejected";
  if (s.includes("withdraw"))  return "withdrawn";
  return "applied";
}

function mapRow(row: Record<string, string>): FormData | null {
  function pick(aliases: string[]) {
    for (const a of aliases) if (row[a] !== undefined && row[a] !== "") return row[a];
    return "";
  }
  const role = pick(COL_ALIASES.role);
  const company = pick(COL_ALIASES.company);
  if (!role && !company) return null;
  return {
    role:         role || "Unknown Role",
    company:      company || "Unknown Company",
    location:     pick(COL_ALIASES.location),
    status:       normaliseStatus(pick(COL_ALIASES.status)),
    stage:        pick(COL_ALIASES.stage) || "Application Sent",
    applied_date: parseDate(pick(COL_ALIASES.applied_date)),
    salary:       pick(COL_ALIASES.salary) || undefined,
    url:          pick(COL_ALIASES.url)    || undefined,
    notes:        pick(COL_ALIASES.notes)  || undefined,
    category:     undefined,
  };
}

// ── Form fields config ────────────────────────────────────────────────────────

const TEXT_FIELDS: { label: string; key: keyof FormData; placeholder: string; type?: string }[] = [
  { label: "Role *",        key: "role",         placeholder: "e.g. Senior Product Manager" },
  { label: "Company *",     key: "company",      placeholder: "e.g. Monzo" },
  { label: "Location",      key: "location",     placeholder: "e.g. London, UK" },
  { label: "Salary",        key: "salary",       placeholder: "e.g. £80–100k" },
  { label: "Stage / Notes", key: "stage",        placeholder: "e.g. 1st Interview" },
  { label: "Date Applied",  key: "applied_date", placeholder: "", type: "date" },
  { label: "Job URL",       key: "url",          placeholder: "https://...", type: "url" },
];

// ── Shared form UI ────────────────────────────────────────────────────────────

function AppForm({
  title, value, onChange, onSubmit, onCancel, submitLabel, isPending,
}: {
  title: string;
  value: FormData;
  onChange: (v: FormData) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  isPending: boolean;
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
        <div>
          <label className="text-xs font-medium text-slate-500 block mb-1">Work Location</label>
          <select
            value={value.work_location ?? ""}
            onChange={(e) => onChange({ ...value, work_location: (e.target.value || undefined) as FormData["work_location"] })}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 bg-white"
          >
            <option value="">Not specified</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-2 rounded-lg hover:bg-slate-100 transition-colors">
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={isPending || !value.role.trim() || !value.company.trim()}
          className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg transition-colors"
        >
          {isPending ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Job Description Modal ─────────────────────────────────────────────────────

function JobDescriptionModal({
  app,
  onClose,
  onSave,
}: {
  app: Application;
  onClose: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(app.job_description ?? "");
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      await onSave(text);
      setEditing(false);
    });
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col" style={{ height: "85vh" }}>
        {/* Header */}
        <div className="flex items-start justify-between px-7 py-5 border-b border-slate-100 shrink-0">
          <div>
            <h2 className="font-bold text-slate-900 text-lg leading-tight">{app.role}</h2>
            <p className="text-slate-500 text-sm mt-0.5">{app.company}{app.location ? ` · ${app.location}` : ""}</p>
          </div>
          <div className="flex items-center gap-2 ml-4">
            {!editing ? (
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-blue-600 px-3 py-1.5 rounded-lg hover:bg-blue-50 border border-slate-200 hover:border-blue-200 transition-colors"
              >
                <Pencil size={13} /> {app.job_description ? "Edit" : "Add JD"}
              </button>
            ) : (
              <>
                <button onClick={() => { setEditing(false); setText(app.job_description ?? ""); }} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isPending}
                  className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-4 py-1.5 rounded-lg transition-colors"
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
              </>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 ml-1 p-1">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden px-7 py-5">
          {editing ? (
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the full job description here — the AI will use this to write a tailored cover letter for this specific role."
              className="w-full h-full text-sm border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none leading-relaxed"
            />
          ) : app.job_description ? (
            <div className="h-full overflow-y-auto">
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{app.job_description}</p>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                <FileText size={22} className="text-slate-400" />
              </div>
              <p className="text-slate-700 font-semibold mb-1">No job description yet</p>
              <p className="text-slate-400 text-sm mb-5 max-w-sm">
                Paste the job description and the AI will use it to write a cover letter perfectly tailored to this role.
              </p>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <Plus size={14} /> Add Job Description
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {app.job_description && !editing && (
          <div className="px-7 py-3 border-t border-slate-100 bg-slate-50 rounded-b-2xl shrink-0 flex items-center justify-between">
            <p className="text-xs text-slate-400">{app.job_description.split(/\s+/).filter(Boolean).length} words</p>
            <p className="text-xs text-slate-400 flex items-center gap-1">
              <Maximize2 size={11} /> This will be used to personalise your AI cover letter
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ApplicationTable({ initialApps }: { initialApps: Application[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [apps, setApps]             = useState<Application[]>(initialApps);
  const [filter, setFilter]         = useState<Status | "all">("all");
  const [search, setSearch]         = useState("");
  const [showAdd, setShowAdd]       = useState(false);
  const [addForm, setAddForm]       = useState<FormData>(emptyForm);
  const [editId, setEditId]         = useState<string | null>(null);
  const [editForm, setEditForm]     = useState<FormData>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<Status>("applied");
  const [preview, setPreview]       = useState<FormData[] | null>(null);
  const [csvError, setCsvError]     = useState<string | null>(null);
  const [legacyCount, setLegacyCount] = useState(0);
  const [jdApp, setJdApp]           = useState<Application | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setApps(initialApps); }, [initialApps]);

  // detect old localStorage data
  useEffect(() => {
    try {
      const raw = localStorage.getItem("job-hunt-applications");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) setLegacyCount(parsed.length);
      }
    } catch {}
  }, []);

  function importLegacyData() {
    try {
      const raw = localStorage.getItem("job-hunt-applications");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<Record<string, string>>;
      const mapped: FormData[] = parsed
        .filter((a) => a.role || a.company)
        .map((a) => ({
          role:         a.role        || "Unknown Role",
          company:      a.company     || "Unknown Company",
          location:     a.location    || "",
          status:       (a.status as Status) || "applied",
          stage:        a.stage       || "Application Sent",
          applied_date: a.appliedDate || new Date().toISOString().split("T")[0],
          salary:       a.salary      || undefined,
          url:          a.url         || undefined,
          notes:        undefined,
          category:     undefined,
        }));
      startTransition(async () => {
        await bulkImportApplications(mapped);
        localStorage.removeItem("job-hunt-applications");
        setLegacyCount(0);
        router.refresh();
      });
    } catch {}
  }

  // ── Add ──
  function addApp() {
    if (!addForm.role.trim() || !addForm.company.trim()) return;
    const payload = { ...addForm, salary: addForm.salary || undefined, url: addForm.url || undefined };
    startTransition(async () => {
      await createApplication(payload);
      setAddForm(emptyForm);
      setShowAdd(false);
      router.refresh();
    });
  }

  // ── Edit ──
  function startEdit(app: Application) {
    setEditId(app.id);
    setEditForm({
      role: app.role, company: app.company, location: app.location,
      status: app.status, stage: app.stage, applied_date: app.applied_date,
      salary: app.salary ?? "", url: app.url ?? "",
      notes: app.notes ?? "", category: app.category ?? "",
      work_location: app.work_location, job_description: app.job_description ?? "",
    });
    setShowAdd(false);
    setDeleteConfirm(null);
  }

  function saveEdit() {
    if (!editForm.role.trim() || !editForm.company.trim() || !editId) return;
    const payload = { ...editForm, salary: editForm.salary || undefined, url: editForm.url || undefined };
    startTransition(async () => {
      await updateApplication(editId, payload);
      setEditId(null);
      router.refresh();
    });
  }

  // ── Delete ──
  function deleteApp(id: string) {
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
    setDeleteConfirm(null);
    startTransition(async () => {
      await deleteApplication(id);
      router.refresh();
    });
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
    const ids = Array.from(selected);
    setSelected(new Set());
    startTransition(async () => {
      await bulkUpdateStatus(ids, bulkStatus);
      router.refresh();
    });
  }

  function bulkDelete() {
    const ids = Array.from(selected);
    setSelected(new Set());
    startTransition(async () => {
      await bulkDeleteApplications(ids);
      router.refresh();
    });
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
      const mapped = rows.map(mapRow).filter(Boolean) as FormData[];
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
    startTransition(async () => {
      await bulkImportApplications(preview);
      setPreview(null);
      router.refresh();
    });
  }

  // ── Filtering ──
  const filtered = apps.filter((app) => {
    const matchesFilter = filter === "all" || app.status === filter;
    const q = search.toLowerCase();
    const matchesSearch = app.role.toLowerCase().includes(q) || app.company.toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id));

  return (
    <div>
      {/* Job Description Modal */}
      {jdApp && (
        <JobDescriptionModal
          app={jdApp}
          onClose={() => setJdApp(null)}
          onSave={async (text) => {
            await updateApplication(jdApp.id, { job_description: text });
            setJdApp({ ...jdApp, job_description: text });
            router.refresh();
          }}
        />
      )}

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

      {/* Legacy migration banner */}
      {legacyCount > 0 && (
        <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3.5 mb-4">
          <Download size={15} className="text-blue-500 shrink-0" />
          <p className="text-sm text-blue-800 flex-1">
            <span className="font-semibold">{legacyCount} application{legacyCount !== 1 ? "s" : ""}</span> found from before the upgrade — import them into your account?
          </p>
          <button
            onClick={importLegacyData}
            disabled={isPending}
            className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-lg transition-colors shrink-0"
          >
            {isPending ? "Importing…" : "Import now"}
          </button>
          <button onClick={() => { localStorage.removeItem("job-hunt-applications"); setLegacyCount(0); }} className="text-blue-400 hover:text-blue-600">
            <X size={14} />
          </button>
        </div>
      )}

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
                      <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{displayDate(row.applied_date)}</td>
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
                <button
                  onClick={confirmImport}
                  disabled={isPending}
                  className="text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {isPending ? "Importing…" : `Import ${preview.length} Application${preview.length !== 1 ? "s" : ""}`}
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
          isPending={isPending}
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
          isPending={isPending}
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
                    <td className="px-4 py-3.5 text-slate-600 text-sm">
                      <span>{app.location || "—"}</span>
                      {app.work_location && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 capitalize">{app.work_location}</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-slate-600 text-sm">{app.salary ?? "—"}</td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${statusStyles[app.status]}`}>
                        {statusLabels[app.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-500 text-xs max-w-[160px] truncate">{app.stage}</td>
                    <td className="px-4 py-3.5 text-slate-500 text-xs whitespace-nowrap">{displayDate(app.applied_date)}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setJdApp(app)}
                          className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border transition-colors ${
                            app.job_description
                              ? "bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100"
                              : "bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100 hover:text-slate-600"
                          }`}
                          title={app.job_description ? "View job description" : "Add job description"}
                        >
                          <FileText size={11} />
                          JD
                        </button>
                        <Link
                          href={`/cover-letter?applicationId=${app.id}`}
                          className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-violet-50 text-violet-600 border-violet-200 hover:bg-violet-100 transition-colors"
                          title="Generate cover letter"
                        >
                          <Sparkles size={11} />
                          CL
                        </Link>
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
              disabled={isPending}
              className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-medium px-3 py-1 rounded-lg transition-colors"
            >
              Apply
            </button>
          </div>
          <div className="w-px h-5 bg-slate-700" />
          <button
            onClick={bulkDelete}
            disabled={isPending}
            className="text-sm text-red-400 hover:text-red-300 disabled:opacity-50 font-medium transition-colors"
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
