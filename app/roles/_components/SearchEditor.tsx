"use client";

import { useMemo, useState, useTransition } from "react";
import { X, Loader2 } from "lucide-react";
import {
  createSearch,
  getSearch,
  updateSearch,
  type Search,
} from "@/app/actions/searches";
import {
  DEFAULT_CRITERIA,
  DEFAULT_WEIGHTS,
  type SearchCriteria,
  type CriteriaWeights,
  type FilterableWorkingModel,
} from "@/lib/job-search/types";

interface Props {
  mode: "create" | "edit";
  initial?: Search;
  onClose: () => void;
  onSaved: (saved: Search, isNew: boolean) => void;
}

// Split on comma / slash / newline / " and " and trim each piece. Forgives
// any of the ways a real user might separate a list.
function splitList(raw: string): string[] {
  return raw
    .split(/[,\/\n]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function SearchEditor({ mode, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [criteria, setCriteria] = useState<SearchCriteria>(mergeCriteria(initial?.criteria));
  const [weights, setWeights] = useState<CriteriaWeights>({ ...DEFAULT_WEIGHTS, ...(initial?.weights ?? {}) });
  const [jobsPerRun, setJobsPerRun] = useState<number>(initial?.jobs_per_run ?? 10);
  // Raw text state for list-typed fields — never parsed on keystroke so users
  // can type spaces and mid-word without losing characters. Parsed on save.
  const [targetTitlesRaw, setTargetTitlesRaw] = useState(mergeCriteria(initial?.criteria).target_titles.join(", "));
  const [industriesExcludeRaw, setIndustriesExcludeRaw] = useState(mergeCriteria(initial?.criteria).industries_exclude.join(", "));
  const parsedTargetTitles = useMemo(() => splitList(targetTitlesRaw), [targetTitlesRaw]);
  const parsedIndustriesExclude = useMemo(() => splitList(industriesExcludeRaw), [industriesExcludeRaw]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  const wmChoices: FilterableWorkingModel[] = ["remote", "hybrid", "office"];

  function toggleWM(m: FilterableWorkingModel) {
    setCriteria((c) => {
      const accepted = new Set(c.working_model.accepted);
      if (accepted.has(m)) accepted.delete(m);
      else accepted.add(m);
      return { ...c, working_model: { ...c.working_model, accepted: Array.from(accepted) } };
    });
  }

  function save() {
    if (!name.trim()) {
      setError("Give the search a name");
      return;
    }
    setError(null);
    // Parse raw list-input strings into structured criteria on save (never
    // on every keystroke). See feedback_input_tolerance_saas.
    const finalCriteria: SearchCriteria = {
      ...criteria,
      target_titles: parsedTargetTitles,
      industries_exclude: parsedIndustriesExclude,
    };
    startSave(async () => {
      if (mode === "create") {
        const res = await createSearch({
          name: name.trim(),
          description: description.trim() || undefined,
          criteria: finalCriteria,
          weights,
          jobs_per_run: jobsPerRun,
        });
        if (res.error || !res.id) {
          setError(res.error ?? "Save failed");
          return;
        }
        const fetched = await getSearch(res.id);
        if (fetched) onSaved(fetched, true);
      } else if (initial) {
        const res = await updateSearch(initial.id, {
          name: name.trim(),
          description: description.trim() || null,
          criteria: finalCriteria,
          weights,
          jobs_per_run: jobsPerRun,
        });
        if (res.error) {
          setError(res.error);
          return;
        }
        const fetched = await getSearch(initial.id);
        if (fetched) onSaved(fetched, false);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl bg-white shadow-2xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between p-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {mode === "create" ? "New search" : "Edit search"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Describe what you want. Set what's essential. We'll filter out the noise.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </header>

        <div className="p-5 space-y-6 max-h-[75vh] overflow-y-auto">
          <Field label="Name" hint='e.g. "Supply chain analyst — Birmingham"'>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Give it a name"
            />
          </Field>

          <Field
            label="What are you looking for?"
            hint="Free-text description. Used for semantic matching against JDs."
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Mid-senior supply chain analyst at scale-ups, hybrid West Midlands or fully remote, avoid defense/automotive."
            />
          </Field>

          <Field label="Keywords" hint="Broad terms sent to the job APIs. Loose OR-match to cast a wide net.">
            <input
              value={criteria.keywords}
              onChange={(e) => setCriteria({ ...criteria, keywords: e.target.value })}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="supply chain analyst"
            />
          </Field>

          <Field
            label="Job titles to accept"
            hint={'Only jobs whose title matches ONE of these role types will be shortlisted. Separate with commas, slashes or new lines. Case doesn\'t matter, plurals are handled. e.g. "Supply Chain Analyst, Procurement Analyst, Buyer" accepts Analyst OR Buyer titles, drops drivers.'}
          >
            <input
              value={targetTitlesRaw}
              onChange={(e) => setTargetTitlesRaw(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Supply Chain Analyst, Procurement Analyst, Buyer"
            />
            <ChipPreview items={parsedTargetTitles} emptyHint="No titles yet — we'll fall back to your keywords." />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Home postcode" hint="For commute distance">
              <input
                value={criteria.location.postcode ?? ""}
                onChange={(e) =>
                  setCriteria({ ...criteria, location: { ...criteria.location, postcode: e.target.value || null } })
                }
                className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="B29 6NW"
              />
            </Field>
            <Field label="Max commute (mins)" hint="One-way. Leave blank to use radius fallback.">
              <input
                type="number"
                min={0}
                value={criteria.location.max_commute_minutes ?? ""}
                onChange={(e) =>
                  setCriteria({
                    ...criteria,
                    location: { ...criteria.location, max_commute_minutes: e.target.value ? parseInt(e.target.value, 10) : null },
                  })
                }
                className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="45"
              />
            </Field>
          </div>

          <Field label="Working model">
            <div className="flex flex-wrap gap-2">
              {wmChoices.map((m) => {
                const on = criteria.working_model.accepted.includes(m);
                const label = m === "remote" ? "Remote" : m === "hybrid" ? "Hybrid" : "Office-based";
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleWM(m)}
                    className={`text-sm rounded-md border px-3 py-1.5 transition-colors ${
                      on
                        ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                        : "bg-white border-slate-300 text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={criteria.working_model.include_unknown}
                  onChange={(e) =>
                    setCriteria({
                      ...criteria,
                      working_model: { ...criteria.working_model, include_unknown: e.target.checked },
                    })
                  }
                />
                Include jobs that don't say
              </label>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Salary floor (£)" hint="Below this, jobs are dropped.">
              <input
                type="number"
                min={0}
                step={1000}
                value={criteria.salary.floor ?? ""}
                onChange={(e) =>
                  setCriteria({
                    ...criteria,
                    salary: { ...criteria.salary, floor: e.target.value ? parseInt(e.target.value, 10) : null },
                  })
                }
                className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="40000"
              />
            </Field>
            <Field label="Salary target (£)" hint="Aspirational. Used for career-fit ranking.">
              <input
                type="number"
                min={0}
                step={1000}
                value={criteria.salary.target ?? ""}
                onChange={(e) =>
                  setCriteria({
                    ...criteria,
                    salary: { ...criteria.salary, target: e.target.value ? parseInt(e.target.value, 10) : null },
                  })
                }
                className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="55000"
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={criteria.salary.drop_hidden_salary}
              onChange={(e) =>
                setCriteria({ ...criteria, salary: { ...criteria.salary, drop_hidden_salary: e.target.checked } })
              }
            />
            Strict mode: drop jobs that don't list salary
          </label>

          <Field label="Exclude industries" hint="Any JD containing these words is dropped. Separate with commas, slashes or new lines.">
            <input
              value={industriesExcludeRaw}
              onChange={(e) => setIndustriesExcludeRaw(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="defense, gambling, tobacco"
            />
            <ChipPreview items={parsedIndustriesExclude} emptyHint="Nothing excluded." />
          </Field>

          <Field label="Jobs per run" hint="Max to shortlist each run. Cap 100.">
            <input
              type="number"
              min={1}
              max={100}
              value={jobsPerRun}
              onChange={(e) => setJobsPerRun(Math.max(1, Math.min(100, parseInt(e.target.value || "10", 10))))}
              className="w-32 text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>
        </div>

        {error && (
          <div className="px-5 pb-2 text-xs text-red-600">{error}</div>
        )}

        <footer className="flex items-center justify-end gap-2 p-5 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-800 px-3 py-1.5">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={isSaving}
            className="flex items-center gap-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3.5 py-1.5 disabled:opacity-60"
          >
            {isSaving && <Loader2 size={13} className="animate-spin" />}
            {mode === "create" ? "Create search" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// Shows the parsed list as chips so the user can SEE how the system read
// their input. If parsing dropped something they meant to keep, they see it.
function ChipPreview({ items, emptyHint }: { items: string[]; emptyHint: string }) {
  if (items.length === 0) {
    return <p className="mt-2 text-xs text-slate-400 italic">{emptyHint}</p>;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="inline-flex items-center rounded-md bg-blue-50 border border-blue-200 text-blue-700 text-xs px-2 py-0.5"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function mergeCriteria(persisted: unknown): SearchCriteria {
  const p = (persisted ?? {}) as Partial<SearchCriteria>;
  return {
    ...DEFAULT_CRITERIA,
    ...p,
    location: { ...DEFAULT_CRITERIA.location, ...(p.location ?? {}) },
    working_model: { ...DEFAULT_CRITERIA.working_model, ...(p.working_model ?? {}) },
    salary: { ...DEFAULT_CRITERIA.salary, ...(p.salary ?? {}) },
    target_titles: p.target_titles ?? [],
  };
}
