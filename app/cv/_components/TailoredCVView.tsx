"use client";

import type { TailoredCV } from "@/lib/cv/tailored-cv";
import { Target, AlertTriangle, Check, X } from "lucide-react";

interface Props {
  cv: TailoredCV;
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

function keywordPresent(body: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  // Word-boundary check for short terms; substring for multi-word phrases.
  if (!k.includes(" ") && k.length < 5) {
    return new RegExp(`\\b${escapeRegex(k)}\\b`, "i").test(body);
  }
  return body.includes(k);
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

export default function TailoredCVView({ cv }: Props) {
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
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                <Target size={12} /> Recruiter search terms ({presentCount}/{keywordChecks.length} surfaced)
              </div>
              <p className="mb-2 text-[11px] text-emerald-700/80">
                Recruiters run boolean searches for these terms. Green = literal match in your CV body. Amber = missing — refine to add it (only if the FactBase supports it).
              </p>
              <div className="flex flex-wrap gap-1.5">
                {keywordChecks.map((k, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                      k.present
                        ? "bg-emerald-600/10 text-emerald-900 border border-emerald-300"
                        : "bg-amber-100/60 text-amber-900 border border-amber-300"
                    }`}
                  >
                    {k.present ? <Check size={10} /> : <X size={10} />}
                    {k.keyword}
                  </span>
                ))}
              </div>
            </div>
          )}

          {cv.gaps.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
                <AlertTriangle size={12} /> Gaps — JD asks not in your profile ({cv.gaps.length})
              </div>
              <ul className="space-y-1 text-xs text-amber-900">
                {cv.gaps.map((g, i) => (
                  <li key={i}>• {g}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-amber-700">
                Add evidence on your Profile to close these. We don&apos;t paper over them.
              </p>
            </div>
          )}
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
          <Section title="Profile">
            <p className="text-justify">{cv.summary}</p>
          </Section>
        )}

        {cv.skills.length > 0 && (
          <Section title="Key Skills">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2
        className="mb-2 border-b border-slate-400 pb-0.5 font-bold uppercase text-slate-900"
        style={{ fontSize: "10.5pt", letterSpacing: "0.10em" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
