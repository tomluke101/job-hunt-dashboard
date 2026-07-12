"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { X, Loader2, Sparkles, ChevronDown, ChevronRight } from "lucide-react";
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
  type LocationFilterMode,
  type CommuteMode,
  type FilterableSizeBucket,
  SIZE_BUCKET_LABELS,
  SIZE_BUCKET_ORDER,
} from "@/lib/job-search/types";
import { suggestTitles, extractSearchTerms } from "@/lib/job-search/title-suggestions";

interface Props {
  mode: "create" | "edit";
  initial?: Search;
  onClose: () => void;
  onSaved: (saved: Search, isNew: boolean) => void;
}

const LIST_SEPARATOR_RE = /[,/\n]|\band\b/i;

function splitList(raw: string): string[] {
  return raw
    .split(LIST_SEPARATOR_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normaliseForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function findExistingChip(chips: string[], candidate: string): number {
  const norm = normaliseForCompare(candidate);
  if (!norm) return -1;
  return chips.findIndex((c) => normaliseForCompare(c) === norm);
}

export default function SearchEditor({ mode, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [criteria, setCriteria] = useState<SearchCriteria>(mergeCriteria(initial?.criteria));
  const [weights, setWeights] = useState<CriteriaWeights>({ ...DEFAULT_WEIGHTS, ...(initial?.weights ?? {}) });
  const [jobsPerRun, setJobsPerRun] = useState<number>(initial?.jobs_per_run ?? 10);
  const [titles, setTitles] = useState<string[]>(mergeCriteria(initial?.criteria).target_titles);
  const [industriesExcludeRaw, setIndustriesExcludeRaw] = useState(mergeCriteria(initial?.criteria).industries_exclude.join(", "));
  const parsedIndustriesExclude = useMemo(() => splitList(industriesExcludeRaw), [industriesExcludeRaw]);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();
  // Lifted from TitleChipInput so we can drive the suggestions engine with
  // what the user is actively typing (live autocomplete).
  const [titleBuffer, setTitleBuffer] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(
    (initial?.criteria?.keywords ?? "").trim().length > 0
  );

  const wmChoices: FilterableWorkingModel[] = ["remote", "hybrid", "office"];

  // Two modes based on whether the user is actively typing in the chip input:
  // - buffer empty → "Related roles" derived from Name / Keywords / Description
  // - buffer >= 2 chars → live autocomplete driven by the buffer only
  const titleSuggestions = useMemo(
    () =>
      suggestTitles(
        { name, keywords: criteria.keywords, description, buffer: titleBuffer },
        titles,
        8
      ),
    [name, criteria.keywords, description, titles, titleBuffer]
  );
  const isAutocomplete = titleBuffer.trim().length >= 2;

  // When the user has no explicit keywords or titles, the run pipeline falls
  // back to extracting search terms from the description. Show those live so
  // the user can see what will actually be searched — no surprises at run.
  const descriptionSearchPreview = useMemo(() => {
    const hasKw = (criteria.keywords ?? "").trim().length > 0;
    const hasTitles = titles.length > 0;
    if (hasKw || hasTitles) return [];
    return extractSearchTerms(description);
  }, [criteria.keywords, titles, description]);

  const hasExplicitIntent =
    (criteria.keywords ?? "").trim().length > 0 || titles.length > 0;

  function toggleWM(m: FilterableWorkingModel) {
    setCriteria((c) => {
      const accepted = new Set(c.working_model.accepted);
      if (accepted.has(m)) accepted.delete(m);
      else accepted.add(m);
      return { ...c, working_model: { ...c.working_model, accepted: Array.from(accepted) } };
    });
  }

  function toggleSize(b: FilterableSizeBucket) {
    setCriteria((c) => {
      const accepted = new Set(c.company_size.accepted);
      if (accepted.has(b)) accepted.delete(b);
      else accepted.add(b);
      // Preserve the punch-list order in the stored array so downstream code
      // can rely on it (UI reads directly from criteria).
      const ordered = SIZE_BUCKET_ORDER.filter((x) => accepted.has(x));
      return { ...c, company_size: { ...c.company_size, accepted: ordered } };
    });
  }

  function save() {
    if (!name.trim()) {
      setError("Give the search a name");
      return;
    }
    setError(null);
    const finalCriteria: SearchCriteria = {
      ...criteria,
      target_titles: titles,
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

  const locMode = criteria.location.filter_mode;
  function setLocationMode(m: LocationFilterMode) {
    setCriteria((c) => ({ ...c, location: { ...c.location, filter_mode: m } }));
  }
  function setLocationField<K extends keyof SearchCriteria["location"]>(k: K, v: SearchCriteria["location"][K]) {
    setCriteria((c) => ({ ...c, location: { ...c.location, [k]: v } }));
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

        <ModeIndicator
          hasExplicitIntent={hasExplicitIntent}
          descriptionSearchPreview={descriptionSearchPreview}
        />


        <div className="p-5 space-y-6 max-h-[75vh] overflow-y-auto">
          <Field label="Name" hint="Just for you">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Something you'll remember it by"
            />
          </Field>

          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                <Sparkles size={12} className="text-blue-500" />
                What are you looking for?
              </span>
            }
            hint="Plain English — the more you say, the better we match. We read this to understand your intent when you save."
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Junior data analyst at a scale-up with a strong training programme, hybrid London or fully remote. Avoid gambling and defence."
            />
            {descriptionSearchPreview.length > 0 && (
              <div className="mt-2 flex items-center flex-wrap gap-1.5">
                <span className="text-xs text-slate-400">We'll search for:</span>
                {descriptionSearchPreview.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center rounded-md bg-slate-100 border border-slate-200 text-slate-700 text-xs px-2 py-0.5"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </Field>

          <Field label="Job titles to accept">
            <TitleChipInput
              chips={titles}
              onChange={setTitles}
              suggestions={titleSuggestions}
              suggestionLabel={isAutocomplete ? "Matches:" : "Related roles:"}
              emptyPlaceholder="Type a title and press Enter — e.g. Product Manager"
              onBufferChange={setTitleBuffer}
            />
          </Field>

          <div className="space-y-3">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider">Location</label>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Home postcode</label>
                <input
                  value={criteria.location.postcode ?? ""}
                  onChange={(e) => setLocationField("postcode", e.target.value || null)}
                  className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
                  placeholder="e.g. SW1A 1AA"
                  disabled={locMode === "anywhere"}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Filter by</label>
                <SegmentedMode
                  value={locMode}
                  onChange={setLocationMode}
                />
              </div>
            </div>

            {locMode === "distance" && (
              <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
                <label className="block text-xs font-medium text-slate-600 mb-1">Max distance</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={criteria.location.max_distance_miles ?? ""}
                    onChange={(e) =>
                      setLocationField(
                        "max_distance_miles",
                        e.target.value ? parseInt(e.target.value, 10) : null
                      )
                    }
                    className="w-24 text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="25"
                  />
                  <span className="text-sm text-slate-500">miles from your postcode</span>
                </div>
              </div>
            )}

            {locMode === "commute" && (
              <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
                <label className="block text-xs font-medium text-slate-600 mb-1">Max commute time</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="number"
                    min={5}
                    max={180}
                    value={criteria.location.max_commute_minutes ?? ""}
                    onChange={(e) =>
                      setLocationField(
                        "max_commute_minutes",
                        e.target.value ? parseInt(e.target.value, 10) : null
                      )
                    }
                    className="w-24 text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="45"
                  />
                  <span className="text-sm text-slate-500">minutes by</span>
                  <select
                    value={criteria.location.commute_mode}
                    onChange={(e) => setLocationField("commute_mode", e.target.value as CommuteMode)}
                    className="text-sm rounded-md border border-slate-300 px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="car">car</option>
                    <option value="public_transport">public transport</option>
                    <option value="cycle">bicycle</option>
                  </select>
                </div>
              </div>
            )}

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
            <Field label="Salary floor (£)">
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
                placeholder="e.g. 40000"
              />
            </Field>
            <Field label="Salary target (£)">
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
                placeholder="e.g. 55000"
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

          <Field label="Company size">
            <div className="flex flex-wrap gap-2">
              {SIZE_BUCKET_ORDER.map((b) => {
                const on = criteria.company_size.accepted.includes(b);
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => toggleSize(b)}
                    className={`text-sm rounded-md border px-3 py-1.5 transition-colors ${
                      on
                        ? "bg-blue-50 border-blue-300 text-blue-700 font-medium"
                        : "bg-white border-slate-300 text-slate-600 hover:border-slate-400"
                    }`}
                  >
                    {SIZE_BUCKET_LABELS[b]}
                  </button>
                );
              })}
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={criteria.company_size.include_unknown}
                  onChange={(e) =>
                    setCriteria({
                      ...criteria,
                      company_size: { ...criteria.company_size, include_unknown: e.target.checked },
                    })
                  }
                />
                Include jobs where we can't tell size
              </label>
            </div>
            {criteria.company_size.accepted.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                No sizes selected — every posting will be dropped unless you tick a bucket or the &quot;include unknown&quot; box.
              </p>
            )}
          </Field>

          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={criteria.hide_recruiters}
              onChange={(e) =>
                setCriteria({ ...criteria, hide_recruiters: e.target.checked })
              }
            />
            Hide jobs posted by recruitment agencies
          </label>

          <Field label="Exclude industries">
            <input
              value={industriesExcludeRaw}
              onChange={(e) => setIndustriesExcludeRaw(e.target.value)}
              className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. gambling, tobacco, crypto"
            />
            {parsedIndustriesExclude.length > 0 && (
              <ChipPreview items={parsedIndustriesExclude} />
            )}
          </Field>

          <Field label="Jobs per run">
            <input
              type="number"
              min={1}
              max={100}
              value={jobsPerRun}
              onChange={(e) => setJobsPerRun(Math.max(1, Math.min(100, parseInt(e.target.value || "10", 10))))}
              className="w-32 text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>

          <div className="border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Advanced
            </button>
            {advancedOpen && (
              <div className="mt-3">
                <Field
                  label="Extra search terms"
                  hint="Sent as extra keywords to the job APIs alongside your title filter — useful for skills or topics not in the job title (e.g. Python, SQL, GCP). Most searches don't need this."
                >
                  <input
                    value={criteria.keywords}
                    onChange={(e) => setCriteria({ ...criteria, keywords: e.target.value })}
                    className="w-full text-sm rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g. Python SQL analytics"
                  />
                </Field>
              </div>
            )}
          </div>
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

// Always-visible mode indicator at the top of the modal. Users see at a
// glance what will happen when they hit Run: role-focused, description-
// derived, or browse. Kills the "did I set up my search correctly?" doubt.
function ModeIndicator({
  hasExplicitIntent,
  descriptionSearchPreview,
}: {
  hasExplicitIntent: boolean;
  descriptionSearchPreview: string[];
}) {
  let dotClass = "bg-slate-400";
  let title = "Browse mode";
  let subtitle = "We'll pull broadly across sectors and rank by your filters (working model, salary, distance). Add a keyword or job title to narrow.";
  let wrapperClass = "border-slate-200 bg-slate-50";

  if (hasExplicitIntent) {
    dotClass = "bg-emerald-500";
    title = "Role-focused search";
    subtitle = "We'll pull jobs matching your keywords and titles, then rank by quality and fit.";
    wrapperClass = "border-emerald-200 bg-emerald-50";
  } else if (descriptionSearchPreview.length > 0) {
    dotClass = "bg-blue-500";
    title = "Description-derived search";
    subtitle = `We extracted ${descriptionSearchPreview.slice(0, 3).map((t) => `"${t}"`).join(", ")}${descriptionSearchPreview.length > 3 ? "…" : ""} from your description.`;
    wrapperClass = "border-blue-200 bg-blue-50";
  }

  return (
    <div className={`mx-5 mt-4 rounded-md border px-3 py-2 flex items-start gap-2.5 ${wrapperClass}`}>
      <span className={`inline-block w-2 h-2 rounded-full mt-1.5 shrink-0 ${dotClass}`}></span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-800">{title}</p>
        <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

function SegmentedMode({
  value,
  onChange,
}: {
  value: LocationFilterMode;
  onChange: (v: LocationFilterMode) => void;
}) {
  const opts: Array<{ v: LocationFilterMode; label: string }> = [
    { v: "distance", label: "Distance" },
    { v: "commute", label: "Commute" },
    { v: "anywhere", label: "Anywhere" },
  ];
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 w-full">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`flex-1 text-xs font-medium px-2.5 py-1.5 rounded transition-colors ${
            value === o.v
              ? "bg-blue-600 text-white"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Chip / tag input for target job titles. Enter or comma commits, Backspace
// on an empty buffer deletes the last chip, paste with separators splits
// into multiple chips at once. Duplicates flash the existing chip instead
// of being added twice.
function TitleChipInput({
  chips,
  onChange,
  suggestions,
  suggestionLabel,
  emptyPlaceholder,
  onBufferChange,
}: {
  chips: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  suggestionLabel?: string;
  emptyPlaceholder: string;
  onBufferChange?: (v: string) => void;
}) {
  const [buffer, setBufferState] = useState("");
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const setBuffer = (v: string): void => {
    setBufferState(v);
    onBufferChange?.(v);
  };

  useEffect(() => {
    if (flashIndex === null) return;
    const t = setTimeout(() => setFlashIndex(null), 800);
    return () => clearTimeout(t);
  }, [flashIndex]);

  function commit(text: string): boolean {
    const trimmed = text.trim().replace(/^[,/\s]+|[,/\s]+$/g, "").trim();
    if (!trimmed) return false;
    const existing = findExistingChip(chips, trimmed);
    if (existing >= 0) {
      setFlashIndex(existing);
      return false;
    }
    onChange([...chips, trimmed]);
    return true;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      if (buffer.trim()) {
        e.preventDefault();
        commit(buffer);
        setBuffer("");
      } else if (e.key === "Enter") {
        e.preventDefault();
      }
    } else if (e.key === "Backspace" && buffer === "" && chips.length > 0) {
      onChange(chips.slice(0, -1));
    }
  }

  function handleBlur() {
    if (buffer.trim()) {
      commit(buffer);
      setBuffer("");
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!LIST_SEPARATOR_RE.test(pasted)) return;
    e.preventDefault();
    const parts = splitList(pasted);
    let next = chips;
    for (const p of parts) {
      const norm = normaliseForCompare(p);
      if (!norm) continue;
      if (next.some((c) => normaliseForCompare(c) === norm)) continue;
      next = [...next, p.trim()];
    }
    if (next !== chips) onChange(next);
    setBuffer("");
  }

  function removeChip(i: number) {
    onChange(chips.filter((_, j) => j !== i));
    inputRef.current?.focus();
  }

  return (
    <div>
      <div
        className="flex flex-wrap gap-1.5 items-center min-h-[42px] rounded-md border border-slate-300 px-2 py-1.5 bg-white focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((c, i) => (
          <span
            key={`${c}-${i}`}
            className={`inline-flex items-center gap-1 rounded-md text-xs font-medium pl-2 pr-1 py-1 transition-all ${
              flashIndex === i
                ? "bg-blue-100 border border-blue-400 text-blue-800 ring-2 ring-blue-300"
                : "bg-blue-50 border border-blue-200 text-blue-700"
            }`}
          >
            {c}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeChip(i);
              }}
              className="rounded-sm p-0.5 text-blue-400 hover:text-blue-800 hover:bg-blue-100"
              aria-label={`Remove ${c}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
          className="flex-1 min-w-[160px] outline-none border-none text-sm bg-transparent py-1"
          placeholder={chips.length === 0 ? emptyPlaceholder : ""}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="mt-2 flex items-center flex-wrap gap-1.5">
          <span className="text-xs text-slate-400">{suggestionLabel ?? "Related roles:"}</span>
          {suggestions.map((s) => (
            <button
              key={`sug-${s}`}
              type="button"
              onClick={() => {
                if (commit(s)) {
                  setBuffer("");
                  inputRef.current?.focus();
                }
              }}
              className="text-xs rounded-md border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 text-slate-600 px-2 py-0.5"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function ChipPreview({ items }: { items: string[] }) {
  if (items.length === 0) return null;
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
  const locP = (p.location ?? {}) as Partial<SearchCriteria["location"]>;
  // Legacy rows may not have filter_mode/max_distance_miles set. Infer a
  // sensible starting mode from whichever field was populated.
  const inferredMode: LocationFilterMode = locP.filter_mode
    ? locP.filter_mode
    : locP.willing_to_relocate
    ? "anywhere"
    : locP.max_commute_minutes && !locP.max_distance_miles
    ? "commute"
    : "distance";
  return {
    ...DEFAULT_CRITERIA,
    ...p,
    location: {
      ...DEFAULT_CRITERIA.location,
      ...locP,
      filter_mode: inferredMode,
      max_distance_miles:
        typeof locP.max_distance_miles === "number"
          ? locP.max_distance_miles
          : inferredMode === "distance"
          ? DEFAULT_CRITERIA.location.max_distance_miles
          : null,
    },
    working_model: { ...DEFAULT_CRITERIA.working_model, ...(p.working_model ?? {}) },
    salary: { ...DEFAULT_CRITERIA.salary, ...(p.salary ?? {}) },
    company_size: { ...DEFAULT_CRITERIA.company_size, ...(p.company_size ?? {}) },
    hide_recruiters: typeof p.hide_recruiters === "boolean" ? p.hide_recruiters : DEFAULT_CRITERIA.hide_recruiters,
    target_titles: p.target_titles ?? [],
  };
}
