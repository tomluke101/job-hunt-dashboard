"use client";

// Modal that opens when the user clicks "+ Add new Master". Captures the
// target role family + optional sector + Master name, then creates the
// Master with those fields persisted. Every subsequent AI path (generate,
// adapt, gap detection) uses the family to surface FactBase evidence
// relevant to that career direction.
//
// Skippable — leaving the family blank produces a sector-agnostic Master
// (current behaviour preserved for users who only target one role family).

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  Briefcase,
  Check,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react";

// Canonical role-family presets. Single clean label per row (no slash-soup
// like "Engineering / Software / DevOps"); adjacent specialties live in the
// hint text. Alphabetical order so users can scan predictably. A search bar
// in the modal filters live by label or hint, so typing "data" instantly
// surfaces the right row.
//
// Custom families (free-text fallback) are also fully supported — the AI
// handles unrecognised target families using its general knowledge of that
// field's CV-writing register.
export const ROLE_FAMILY_PRESETS: ReadonlyArray<{ label: string; hint: string }> = [
  { label: "Accountancy", hint: "tax, audit, statutory accounts, ACA / ACCA, advisory" },
  { label: "Architecture", hint: "RIBA stages, design lead, planning, portfolio" },
  { label: "Asset Management", hint: "portfolio, fund analysis, trading, quant, risk models" },
  { label: "Charity & Non-profit", hint: "fundraising, grants, programme delivery, impact, third sector" },
  { label: "Construction", hint: "civil engineering, site management, sub-contractors, H&S, trades" },
  { label: "Consulting", hint: "strategy, client engagements, hypothesis-driven analysis, deck delivery" },
  { label: "Customer Success", hint: "account management, retention, NRR, expansion, named accounts" },
  { label: "Cybersecurity", hint: "InfoSec, SOC, pen testing, IR, governance, ISO 27001" },
  { label: "Data", hint: "analytics, data science, ML, BI, modelling, pipelines, experimentation" },
  { label: "Design", hint: "UX, UI, product design, design systems, user research, portfolio" },
  { label: "Education", hint: "teaching, academic, curriculum, attainment, pastoral, leadership" },
  { label: "Finance", hint: "corporate finance, FP&A, treasury, lending, controls, advisory" },
  { label: "Healthcare", hint: "clinical, medical, nursing, patient care, governance, audit" },
  { label: "Hospitality & Travel", hint: "restaurant, hotels, covers, NPS, P&L, guest experience" },
  { label: "Human Resources", hint: "talent, L&D, ER, HRBP, comp & benefits, people ops" },
  { label: "Insurance", hint: "underwriting, broking, claims, actuarial, risk" },
  { label: "Investment Banking", hint: "PE, M&A, capital markets, deal execution, modelling, pitch decks" },
  { label: "Legal", hint: "solicitor, barrister, paralegal, regulatory, contracts, compliance" },
  { label: "Logistics & Transport", hint: "fleet, freight, warehousing, last-mile, OTIF, distribution" },
  { label: "Manufacturing", hint: "production, plant, lean, Six Sigma, OEE, output, planning" },
  { label: "Marketing", hint: "brand, content, growth, paid media, campaigns, creative" },
  { label: "Media & Communications", hint: "PR, journalism, comms, published bylines, campaigns, audience" },
  { label: "Operations", hint: "process redesign, project, programme management, cross-team coordination" },
  { label: "Pharma & Life Sciences", hint: "biotech, clinical research, regulatory affairs, GxP, drug development" },
  { label: "Procurement", hint: "sourcing, vendor management, category spend, supplier negotiation" },
  { label: "Product Management", hint: "roadmap, user research, GTM, cross-functional launches" },
  { label: "Property & Real Estate", hint: "surveying, MRICS, valuation, asset management, lettings, agency" },
  { label: "Public Sector", hint: "civil service, policy delivery, programme management, stakeholder engagement" },
  { label: "Research & Academia", hint: "thesis, peer-reviewed output, methodology, conferences" },
  { label: "Retail & E-commerce", hint: "store ops, merchandising, conversion, basket size, P&L" },
  { label: "Sales", hint: "business development, quota, pipeline, named-account wins, partnerships" },
  { label: "Social Care", hint: "social work, casework, safeguarding, statutory, multi-agency" },
  { label: "Software Engineering", hint: "development, DevOps, platform, infra, shipped systems, on-call, scale" },
  { label: "Supply Chain", hint: "demand planning, S&OP, logistics planning, forecasting, inventory" },
  { label: "Therapy & Mental Health", hint: "counselling, clinical psychology, clinical hours, modality, accreditation" },
];

interface Props {
  // Existing Master names — used to suggest a non-colliding default name
  // when the user picks a family.
  existingNames: string[];
  onSubmit: (payload: {
    name: string;
    targetRoleFamily: string | null;
    targetSector: string | null;
  }) => Promise<void> | void;
  onClose: () => void;
}

function suggestNameFromFamily(family: string, taken: string[]): string {
  if (!family.trim()) return "My Master";
  // Use the part before the slash as the base label ("Procurement" from
  // "Procurement / Supply Chain"). Cleaner CV-Profile reading for the
  // Master picker.
  const base = family.split("/")[0]!.trim();
  if (!taken.some((n) => n.toLowerCase() === base.toLowerCase())) return base;
  // Disambiguate by suffix if a Master with this name already exists.
  let i = 2;
  while (taken.some((n) => n.toLowerCase() === `${base} ${i}`.toLowerCase())) {
    i++;
  }
  return `${base} ${i}`;
}

export default function NewMasterModal({ existingNames, onSubmit, onClose }: Props) {
  const [familyChoice, setFamilyChoice] = useState<string>("");
  const [customFamily, setCustomFamily] = useState<string>("");
  const [sector, setSector] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, startSubmit] = useTransition();
  // Live search filter over the preset list. Matches on label OR hint so
  // typing "data" surfaces "Data" (label hit) and typing "supplier" surfaces
  // "Procurement" + "Supply Chain" (hint hits). Case-insensitive.
  const [familySearch, setFamilySearch] = useState<string>("");

  const filteredPresets = useMemo(() => {
    const q = familySearch.trim().toLowerCase();
    if (!q) return ROLE_FAMILY_PRESETS;
    return ROLE_FAMILY_PRESETS.filter(
      (p) =>
        p.label.toLowerCase().includes(q) || p.hint.toLowerCase().includes(q)
    );
  }, [familySearch]);

  // Resolved family: either the preset pick, or the custom free-text value
  // when "Other" is selected.
  const resolvedFamily = useMemo(() => {
    if (!familyChoice) return "";
    if (familyChoice === "__custom__") return customFamily.trim();
    return familyChoice;
  }, [familyChoice, customFamily]);

  // Auto-suggest the Master name based on the family choice, but stop
  // overwriting once the user has manually edited the name field.
  useEffect(() => {
    if (nameTouched) return;
    setName(suggestNameFromFamily(resolvedFamily, existingNames));
  }, [resolvedFamily, existingNames, nameTouched]);

  function handleSubmit() {
    setError(null);
    const trimmedName = name.trim() || suggestNameFromFamily(resolvedFamily, existingNames);
    const family = resolvedFamily || null;
    const sec = sector.trim() || null;
    startSubmit(async () => {
      try {
        await onSubmit({
          name: trimmedName,
          targetRoleFamily: family,
          targetSector: sec,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create Master.");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-4 shrink-0">
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-slate-900 text-lg inline-flex items-center gap-2">
              <Sparkles size={16} className="text-blue-500" />
              Create a new Master Profile
            </h2>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              A Master Profile is your strongest universal version for one
              career direction. The AI uses the target family to surface the
              FactBase evidence most relevant to it — same truth, different
              framing. Skip the family if you only target one role family.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-slate-700 p-1 disabled:opacity-30 shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Family picker */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-2">
              What role family is this Master for?{" "}
              <span className="text-slate-400 font-normal normal-case tracking-normal">
                (optional, but unlocks better tailoring)
              </span>
            </label>

            {/* Search bar — filters the list live by label or hint. Big
                time-saver vs scanning 35 entries. */}
            <div className="relative mb-2">
              <Search
                size={13}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
              />
              <input
                type="text"
                value={familySearch}
                onChange={(e) => setFamilySearch(e.target.value)}
                disabled={isSubmitting}
                placeholder="Search families — e.g. data, consulting, property…"
                className="w-full text-xs border border-slate-200 rounded-lg pl-8 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-400 disabled:opacity-50"
              />
              {familySearch && (
                <button
                  onClick={() => setFamilySearch("")}
                  disabled={isSubmitting}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 disabled:opacity-40"
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Single-column scrollable list — alphabetical, one row per
                family. Easier to scan than a 2-col grid; bounded height so
                the modal doesn't blow up vertically. */}
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
              {filteredPresets.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-500">
                  No matches for &quot;{familySearch}&quot;. Try a different term, or
                  use{" "}
                  <button
                    onClick={() => {
                      setFamilyChoice("__custom__");
                      setCustomFamily(familySearch);
                      setFamilySearch("");
                    }}
                    className="text-blue-600 font-semibold hover:underline"
                  >
                    Other / custom
                  </button>{" "}
                  to type your own.
                </div>
              ) : (
                filteredPresets.map((p) => {
                  const selected = familyChoice === p.label;
                  return (
                    <button
                      key={p.label}
                      onClick={() => setFamilyChoice(p.label)}
                      disabled={isSubmitting}
                      className={`w-full text-left text-xs px-3 py-2 transition-colors disabled:opacity-40 ${
                        selected
                          ? "bg-blue-50 text-blue-900"
                          : "bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                      title={p.hint}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold leading-tight">
                          {p.label}
                        </div>
                        {selected && (
                          <Check size={12} className="text-blue-600 shrink-0" />
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                        {p.hint}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Custom / other option — always present below the list as a
                separate affordance, so users typing an unrecognised family
                have a clear path. */}
            <button
              onClick={() => setFamilyChoice("__custom__")}
              disabled={isSubmitting}
              className={`mt-2 w-full text-left text-xs px-3 py-2 rounded-lg border transition-colors disabled:opacity-40 ${
                familyChoice === "__custom__"
                  ? "border-blue-400 bg-blue-50 text-blue-900"
                  : "border-dashed border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold leading-tight">Other / custom</div>
                {familyChoice === "__custom__" && (
                  <Check size={12} className="text-blue-600 shrink-0" />
                )}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5 leading-snug">
                Type your own — e.g. &quot;Equestrian Sports Management&quot;, &quot;Litigation&quot;, &quot;Yacht Brokerage&quot;
              </div>
            </button>

            {familyChoice === "__custom__" && (
              <input
                type="text"
                value={customFamily}
                onChange={(e) => setCustomFamily(e.target.value)}
                disabled={isSubmitting}
                placeholder="e.g. Investment Banking, Litigation, Hospitality Management"
                className="mt-2 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300 disabled:opacity-50"
              />
            )}

            {familyChoice && (
              <button
                onClick={() => {
                  setFamilyChoice("");
                  setCustomFamily("");
                  setNameTouched(false);
                  setName("");
                }}
                disabled={isSubmitting}
                className="mt-2 text-[10px] text-slate-500 hover:text-slate-900 underline-offset-2 hover:underline disabled:opacity-40"
              >
                Clear selection (creates a sector-agnostic Master)
              </button>
            )}
          </div>

          {/* Optional sector */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
              Target sector or industry{" "}
              <span className="text-slate-400 font-normal normal-case tracking-normal">
                (optional)
              </span>
            </label>
            <input
              type="text"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. Financial services, FMCG, Tech / SaaS, Healthcare"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300 disabled:opacity-50"
            />
          </div>

          {/* Master name */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
              Master name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              disabled={isSubmitting}
              placeholder={
                resolvedFamily
                  ? suggestNameFromFamily(resolvedFamily, existingNames)
                  : "My Master"
              }
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder-slate-300 disabled:opacity-50"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Shows in the Master picker on the CV builder so you can pick the
              right Master per JD.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 flex items-start gap-1.5">
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-100 px-6 py-3 flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="text-xs font-semibold inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Creating…
              </>
            ) : (
              <>
                <Check size={12} />
                {resolvedFamily ? `Create ${resolvedFamily} Master` : "Create blank Master"}
              </>
            )}
          </button>
        </div>
      </div>
      {/* Briefcase icon for visual reference of role-family context */}
      <div className="sr-only">
        <Briefcase />
      </div>
    </div>
  );
}
