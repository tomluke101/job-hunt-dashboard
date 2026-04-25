"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, Plus, Pencil, Trash2, Check, X, MapPin, PoundSterling, TrendingUp, Clock } from "lucide-react";
import { addEmployer, updateEmployer, deleteEmployer, type UserEmployer, type UserEmployerInput } from "@/app/actions/profile";

const EMPLOYMENT_TYPES = [
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
  { value: "freelance", label: "Freelance" },
];

const emptyForm: UserEmployerInput = {
  company_name: "",
  role_title: "",
  start_date: "",
  end_date: null,
  is_current: false,
  location: "",
  employment_type: "full-time",
  summary: "",
  salary: "",
};

function formatMonthYear(iso: string): string {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function tenureMonths(start: string, end: string | null | undefined): number {
  if (!start) return 0;
  const [sy, sm] = start.split("-").map(Number);
  const startD = new Date(sy, (sm ?? 1) - 1, 1);
  const endD = end ? (() => { const [ey, em] = end.split("-").map(Number); return new Date(ey, (em ?? 1) - 1, 1); })() : new Date();
  return Math.max(0, (endD.getFullYear() - startD.getFullYear()) * 12 + (endD.getMonth() - startD.getMonth()));
}

function formatTenure(months: number): string {
  if (months < 1) return "Less than a month";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} ${m === 1 ? "month" : "months"}`;
  if (m === 0) return `${y} ${y === 1 ? "year" : "years"}`;
  return `${y} ${y === 1 ? "year" : "years"} ${m} ${m === 1 ? "month" : "months"}`;
}

function parseSalaryNumber(raw?: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[£$,\s]/g, "").replace(/k$/i, "000");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function EmployerForm({
  initial,
  title,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: UserEmployerInput;
  title: string;
  submitLabel: string;
  onSubmit: (input: UserEmployerInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<UserEmployerInput>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    setError(null);
    if (!form.company_name.trim() || !form.role_title.trim() || !form.start_date) {
      setError("Company, role title, and start date are required.");
      return;
    }
    startTransition(async () => {
      await onSubmit(form);
    });
  }

  function update<K extends keyof UserEmployerInput>(key: K, value: UserEmployerInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="bg-white border-2 border-blue-200 rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs font-semibold text-slate-500 block mb-1">Company *</label>
          <input
            type="text"
            value={form.company_name}
            onChange={(e) => update("company_name", e.target.value)}
            placeholder="e.g. Grain and Frame"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs font-semibold text-slate-500 block mb-1">Role title *</label>
          <input
            type="text"
            value={form.role_title}
            onChange={(e) => update("role_title", e.target.value)}
            placeholder="e.g. Supply Chain Analyst"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-1">Start date *</label>
          <input
            type="month"
            value={form.start_date}
            onChange={(e) => update("start_date", e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-1">End date</label>
          <input
            type="month"
            value={form.is_current ? "" : (form.end_date ?? "")}
            onChange={(e) => update("end_date", e.target.value || null)}
            disabled={form.is_current}
            placeholder="Current"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-400"
          />
        </div>
        <div className="col-span-2">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={form.is_current}
              onChange={(e) => update("is_current", e.target.checked)}
              className="rounded border-slate-300 text-blue-600"
            />
            I currently work here
          </label>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-1">Location</label>
          <input
            type="text"
            value={form.location ?? ""}
            onChange={(e) => update("location", e.target.value)}
            placeholder="e.g. Birmingham"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-1">Employment type</label>
          <select
            value={form.employment_type ?? "full-time"}
            onChange={(e) => update("employment_type", e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 bg-white"
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="text-xs font-semibold text-slate-500 block mb-1">Brief summary <span className="text-slate-400 font-normal">(optional)</span></label>
          <textarea
            value={form.summary ?? ""}
            onChange={(e) => update("summary", e.target.value)}
            rows={2}
            placeholder="One or two sentences on what the role covers"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs font-semibold text-slate-500 block mb-1">
            Salary <span className="text-slate-400 font-normal">(optional, private — never used in cover letters)</span>
          </label>
          <input
            type="text"
            value={form.salary ?? ""}
            onChange={(e) => update("salary", e.target.value)}
            placeholder="e.g. £35,000"
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="text-sm text-slate-500 hover:text-slate-700 px-3 py-2 rounded-lg hover:bg-slate-100 transition-colors">Cancel</button>
        <button
          onClick={handleSubmit}
          disabled={isPending || !form.company_name.trim() || !form.role_title.trim() || !form.start_date}
          className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-medium px-4 py-2 rounded-lg transition-colors"
        >
          <Check size={13} /> {isPending ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function EmployerCard({
  employer,
  prevSalary,
  onEdit,
  onDelete,
}: {
  employer: UserEmployer;
  prevSalary: number | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const months = tenureMonths(employer.start_date, employer.end_date);
  const currentSalary = parseSalaryNumber(employer.salary);
  const salaryDelta = currentSalary && prevSalary ? currentSalary - prevSalary : null;

  return (
    <div className="relative pl-8 group">
      <div className={`absolute left-0 top-2 w-3.5 h-3.5 rounded-full border-2 ${employer.is_current ? "bg-blue-500 border-blue-200 shadow-sm shadow-blue-200" : "bg-slate-300 border-slate-100"}`} />
      <div className="bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-slate-900 text-sm">{employer.role_title}</p>
              {employer.is_current && (
                <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-full uppercase tracking-wider">Current</span>
              )}
            </div>
            <p className="text-sm text-slate-600">{employer.company_name}</p>
            <div className="flex items-center gap-3 flex-wrap mt-1.5 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Clock size={11} />
                {formatMonthYear(employer.start_date)} {employer.is_current ? "— Present" : `— ${formatMonthYear(employer.end_date ?? "")}`}
                <span className="text-slate-400 ml-1">· {formatTenure(months)}</span>
              </span>
              {employer.location && (
                <span className="flex items-center gap-1"><MapPin size={11} /> {employer.location}</span>
              )}
              {employer.employment_type && employer.employment_type !== "full-time" && (
                <span className="text-[10px] font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded uppercase tracking-wider">{employer.employment_type}</span>
              )}
            </div>
            {employer.summary && (
              <p className="text-sm text-slate-600 mt-2 leading-relaxed">{employer.summary}</p>
            )}
            {employer.salary && (
              <div className="flex items-center gap-2 mt-2">
                <span className="flex items-center gap-1 text-xs text-slate-500 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full">
                  <PoundSterling size={11} className="text-slate-400" /> {employer.salary}
                  <span className="text-[10px] text-slate-400 ml-1">private</span>
                </span>
                {salaryDelta !== null && salaryDelta > 0 && (
                  <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                    <TrendingUp size={11} /> +£{salaryDelta.toLocaleString()}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button onClick={onEdit} className="text-slate-400 hover:text-blue-500 transition-colors p-1"><Pencil size={13} /></button>
            <button onClick={onDelete} className="text-slate-400 hover:text-red-500 transition-colors p-1"><Trash2 size={13} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WorkHistoryManager({ initial }: { initial: UserEmployer[] }) {
  const router = useRouter();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [, startDelete] = useTransition();

  // Sort oldest-first for salary progression calculation, then reverse for display.
  const chronological = [...initial].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const salaryByEmployerId = new Map<string, number | null>();
  let lastSalary: number | null = null;
  for (const emp of chronological) {
    const sal = parseSalaryNumber(emp.salary);
    salaryByEmployerId.set(emp.id, sal !== null && lastSalary !== null ? lastSalary : null);
    if (sal !== null) lastSalary = sal;
  }

  const ordered = [...initial].sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return b.start_date.localeCompare(a.start_date);
  });

  function handleDelete(id: string) {
    setDeleteConfirm(null);
    startDelete(async () => {
      await deleteEmployer(id);
      router.refresh();
    });
  }

  async function handleAdd(input: UserEmployerInput) {
    const result = await addEmployer(input);
    if (!result.error) {
      setShowAdd(false);
      router.refresh();
    }
  }

  async function handleUpdate(id: string, input: UserEmployerInput) {
    const result = await updateEmployer(id, input);
    if (!result.error) {
      setEditId(null);
      router.refresh();
    }
  }

  return (
    <div>
      {initial.length === 0 && !showAdd && (
        <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl mb-4">
          <Briefcase size={22} className="text-slate-400 mx-auto mb-2" />
          <p className="text-sm text-slate-600 font-medium mb-1">No work history added yet</p>
          <p className="text-xs text-slate-400 mb-4 max-w-sm mx-auto">Add your roles so the AI can attribute your skills and achievements to the right employer when writing cover letters.</p>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <Plus size={14} /> Add your first role
          </button>
        </div>
      )}

      {ordered.length > 0 && (
        <div className="relative space-y-3 mb-4">
          <div className="absolute left-[7px] top-3 bottom-3 w-px bg-slate-200" />
          {ordered.map((emp) => (
            editId === emp.id ? (
              <div key={emp.id} className="pl-8">
                <EmployerForm
                  initial={{
                    company_name: emp.company_name,
                    role_title: emp.role_title,
                    start_date: emp.start_date,
                    end_date: emp.end_date,
                    is_current: emp.is_current,
                    location: emp.location ?? "",
                    employment_type: emp.employment_type ?? "full-time",
                    summary: emp.summary ?? "",
                    salary: emp.salary ?? "",
                  }}
                  title="Edit role"
                  submitLabel="Save changes"
                  onSubmit={(i) => handleUpdate(emp.id, i)}
                  onCancel={() => setEditId(null)}
                />
              </div>
            ) : deleteConfirm === emp.id ? (
              <div key={emp.id} className="pl-8">
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between gap-3">
                  <p className="text-sm text-red-800">Delete <span className="font-semibold">{emp.company_name}</span> from your work history?</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setDeleteConfirm(null)} className="text-sm text-slate-600 hover:text-slate-800 px-3 py-1.5 rounded-lg hover:bg-white transition-colors">Cancel</button>
                    <button onClick={() => handleDelete(emp.id)} className="text-sm bg-red-600 hover:bg-red-700 text-white font-medium px-3 py-1.5 rounded-lg transition-colors">Delete</button>
                  </div>
                </div>
              </div>
            ) : (
              <EmployerCard
                key={emp.id}
                employer={emp}
                prevSalary={salaryByEmployerId.get(emp.id) ?? null}
                onEdit={() => { setEditId(emp.id); setShowAdd(false); setDeleteConfirm(null); }}
                onDelete={() => { setDeleteConfirm(emp.id); setEditId(null); setShowAdd(false); }}
              />
            )
          ))}
        </div>
      )}

      {showAdd && (
        <div className="pl-8 mb-4">
          <EmployerForm
            initial={emptyForm}
            title="Add a role"
            submitLabel="Add role"
            onSubmit={handleAdd}
            onCancel={() => setShowAdd(false)}
          />
        </div>
      )}

      {!showAdd && initial.length > 0 && (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 text-sm text-blue-600 font-medium hover:text-blue-700 transition-colors"
        >
          <Plus size={15} /> Add another role
        </button>
      )}
    </div>
  );
}
