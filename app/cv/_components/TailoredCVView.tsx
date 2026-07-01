"use client";

import type { TailoredCV } from "@/lib/cv/tailored-cv";
import { Target, AlertTriangle, Check, X } from "lucide-react";

interface Props {
  cv: TailoredCV;
  // Optional actions rendered inline on the Profile section heading. Used by
  // the CV tailor page to surface [Edit / Adapt to this JD / Reset to Master]
  // adjacent to the Profile content. Not rendered in print/Word output —
  // these are screen-only UI affordances.
  profileActions?: React.ReactNode;
  // Optional banner rendered immediately ABOVE the Profile section heading.
  // Used for contextual prompts like "Save this auto-generated Profile as
  // your first Master?" so the CTA sits right next to the Profile it relates
  // to, not floating above the whole CV. print:hidden.
  profileBanner?: React.ReactNode;
  // Optional footer rendered immediately BELOW the Profile paragraph (but
  // INSIDE the CV card). Used for the ProfileStrengthCard so the honesty
  // layer sits visually attached to the Profile it scores. print:hidden.
  profileFooter?: React.ReactNode;
  // Optional actions rendered inline on the Key Skills section heading —
  // used to surface "Strengthen Skills" button so the user can run the
  // JD-vs-FactBase audit + re-tailor with confirmed skills. print:hidden.
  skillsActions?: React.ReactNode;
}

// Check whether a JD keyword surfaces verbatim (or as a clear stem) anywhere
// in the rendered CV body. Recruiter boolean searches hit literal strings.
function buildBodyText(cv: TailoredCV): string {
  return [
    cv.summary,
    ...cv.skills.flatMap((g) => [g.category, ...g.items]),
    ...cv.roles.flatMap((r) => [r.title, r.company, r.location ?? "", ...r.bullets]),
    ...cv.education.flatMap((e) =>
      [e.qualification, e.institution, e.classification, e.details].filter(Boolean) as string[]
    ),
    ...cv.certifications.flatMap((c) => [c.content, c.issuer, c.year].filter(Boolean) as string[]),
  ]
    .join(" \n ")
    .toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Generic trailing words that recruiters sometimes append to keywords but
// which the body often omits ("ERP systems" vs body's bare "ERP"). When a
// multi-word keyword ends with one of these tails, we also accept a
// word-boundary match on the bare head term.
const GENERIC_TRAILING_TAILS = new Set([
  "system", "systems",
  "tool", "tools", "tooling",
  "software", "platform", "platforms",
  "application", "applications", "apps",
  "suite", "package",
  "framework", "frameworks",
  "skills", "skill",
  "knowledge", "experience",
]);

function keywordPresent(body: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  // Word-boundary check for short single-word terms.
  if (!k.includes(" ") && k.length < 5) {
    return new RegExp(`\\b${escapeRegex(k)}\\b`, "i").test(body);
  }
  // Multi-word: try the full phrase as substring first.
  if (body.includes(k)) return true;
  // Fallback for "X SUFFIX" patterns where SUFFIX is a generic trailing
  // word ("ERP systems" → also accept "ERP" word-boundary match in body;
  // "MRP tools" → "MRP"; "BI platforms" → "BI"; "Programming knowledge"
  // → "Programming"). Without this, every "X systems"/"X tools" JD
  // keyword falsely reads as missing whenever the body uses just "X".
  const words = k.split(/\s+/);
  if (words.length === 2 && GENERIC_TRAILING_TAILS.has(words[1])) {
    const bareTerm = words[0];
    // Bare term must be ≥2 chars to avoid noise; use word-boundary.
    if (bareTerm.length >= 2) {
      return new RegExp(`\\b${escapeRegex(bareTerm)}\\b`, "i").test(body);
    }
  }
  return false;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDate(ym: string | null | undefined): string {
  if (!ym) return "";
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  if (!m) return ym;
  const month = parseInt(m[2], 10);
  const year = m[1];
  if (month < 1 || month > 12) return ym;
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function dateRange(start: string, end: string | null, isCurrent: boolean): string {
  const s = formatDate(start);
  const e = isCurrent ? "Present" : formatDate(end || "");
  if (s && e) return `${s} – ${e}`;
  return s || e || "";
}

const cvFontStack = `"Calibri", "Arial", "Helvetica", sans-serif`;

export default function TailoredCVView({
  cv,
  profileActions,
  profileBanner,
  profileFooter,
  skillsActions,
}: Props) {
  const bodyText = buildBodyText(cv);
  const keywordChecks = cv.jdKeywords.map((k) => ({
    keyword: k,
    present: keywordPresent(bodyText, k),
  }));
  const presentCount = keywordChecks.filter((k) => k.present).length;

  return (
    <div className="space-y-4">
      {(cv.jdKeywords.length > 0 || cv.gaps.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {cv.jdKeywords.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5">
              <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-700">
                  <Target size={11} className="text-slate-500" /> Recruiter search terms
                </div>
                <div className="text-[10px] font-medium text-slate-500">
                  <span className="text-emerald-700 font-semibold">{presentCount}</span>
                  <span className="text-slate-400"> of </span>
                  <span className="font-semibold">{keywordChecks.length}</span>
                  <span className="text-slate-400"> surfaced</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {keywordChecks.map((k, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                      k.present
                        ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                        : "bg-slate-50 text-slate-500 border border-slate-200"
                    }`}
                    title={
                      k.present
                        ? `"${k.keyword}" appears in your CV body — recruiter boolean searches will hit.`
                        : `"${k.keyword}" missing — strengthen via Skills audit or add evidence on your Profile.`
                    }
                  >
                    {k.present ? (
                      <Check size={8} className="text-emerald-600" />
                    ) : (
                      <span className="text-slate-400">·</span>
                    )}
                    {k.keyword}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Gaps panel removed 2026-05-25 — Strengthen Skills (interactive
              checklist next to Skills heading) replaces it. The read-only
              passive list duplicated work and added visual noise without
              giving the user a path to fix the gaps. */}
        </div>
      )}

      <div
        className="rounded-2xl border border-slate-200 bg-white px-12 py-10 shadow-sm text-slate-900"
        style={{ fontFamily: cvFontStack, fontSize: "11pt", lineHeight: 1.5 }}
      >
        <header className="mb-3">
          <h1 className="font-bold tracking-tight" style={{ fontSize: "24pt", lineHeight: 1.1 }}>
            {cv.contact.name || "—"}
          </h1>
          <div className="mt-1 text-slate-600" style={{ fontSize: "10.5pt" }}>
            {[cv.contact.location, cv.contact.email, cv.contact.phone, cv.contact.linkedin]
              .filter(Boolean)
              .join("  ·  ")}
          </div>
        </header>

        {cv.summary && (
          <>
            {profileBanner && (
              <div className="mt-4 print:hidden">{profileBanner}</div>
            )}
            <Section title="Profile" actions={profileActions}>
              <p className="text-justify">{cv.summary}</p>
              {profileFooter && (
                <div className="mt-3 print:hidden">{profileFooter}</div>
              )}
            </Section>
          </>
        )}

        {cv.skills.length > 0 && (
          <Section title="Key Skills" actions={skillsActions}>
            <div className="space-y-1">
              {cv.skills.map((g, i) => (
                <p key={i} style={{ lineHeight: 1.55 }}>
                  <span className="font-bold">{g.category}:</span>{" "}
                  <span className="text-slate-800">{g.items.join(", ")}</span>
                </p>
              ))}
            </div>
          </Section>
        )}

        {cv.roles.length > 0 && (
          <Section title="Experience">
            <div className="space-y-3">
              {cv.roles.map((r, i) => {
                const dates = dateRange(r.startDate, r.endDate, r.isCurrent);
                const sub = [r.company, r.location].filter(Boolean).join("  ·  ");
                return (
                  <div key={i}>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="font-bold" style={{ fontSize: "11.5pt" }}>
                        {r.title}
                      </div>
                      {dates && (
                        <div
                          className="shrink-0 text-slate-500 tabular-nums whitespace-nowrap"
                          style={{ fontSize: "10.5pt" }}
                        >
                          {dates}
                        </div>
                      )}
                    </div>
                    {sub && <div className="text-slate-800">{sub}</div>}
                    {r.bullets.length > 0 && (
                      <ul className="mt-1 list-disc space-y-1 pl-6">
                        {r.bullets.map((b, j) => (
                          <li key={j}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {cv.education.length > 0 && (
          <Section title="Education">
            <div className="space-y-2">
              {cv.education.map((e, i) => {
                const years = [e.startYear, e.endYear].filter(Boolean).join(" – ");
                const sub = [e.institution, e.classification].filter(Boolean).join("  ·  ");
                return (
                  <div key={i}>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="font-bold">{e.qualification}</div>
                      {years && (
                        <div
                          className="shrink-0 text-slate-500 tabular-nums whitespace-nowrap"
                          style={{ fontSize: "10.5pt" }}
                        >
                          {years}
                        </div>
                      )}
                    </div>
                    {sub && <div className="text-slate-800">{sub}</div>}
                    {e.details && (
                      <div className="text-slate-600" style={{ fontSize: "10.5pt" }}>
                        {e.details}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {cv.certifications.length > 0 && (
          <Section title="Certifications">
            <ul className="list-disc space-y-1 pl-6">
              {cv.certifications.map((c, i) => {
                const meta = [c.issuer, c.year].filter(Boolean).join(", ");
                return (
                  <li key={i}>
                    {c.content}
                    {meta && <span className="text-slate-500"> ({meta})</span>}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {cv.languages.length > 0 && (
          <Section title="Languages">
            <p>
              {cv.languages
                .map((l) => (l.proficiency ? `${l.language} (${l.proficiency})` : l.language))
                .join(", ")}
            </p>
          </Section>
        )}

        {cv.interests.length > 0 && (
          <Section title="Interests">
            <p>{cv.interests.join(", ")}</p>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-end justify-between gap-3 border-b border-slate-400 pb-0.5">
        <h2
          className="font-bold uppercase text-slate-900"
          style={{ fontSize: "10.5pt", letterSpacing: "0.10em" }}
        >
          {title}
        </h2>
        {actions && (
          <div className="flex items-center gap-1.5 print:hidden -mb-1">
            {actions}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}
