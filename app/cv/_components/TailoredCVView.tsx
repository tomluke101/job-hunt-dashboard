"use client";

import type { TailoredCV } from "@/lib/cv/tailored-cv";
import { Target, AlertTriangle } from "lucide-react";

interface Props {
  cv: TailoredCV;
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

function dateLine(start: string, end: string | null, isCurrent: boolean): string {
  const s = formatDate(start);
  const e = isCurrent ? "Present" : formatDate(end || "");
  if (s && e) return `${s} – ${e}`;
  return s || e || "";
}

const cvFontStack = `"Calibri", "Arial", "Helvetica", sans-serif`;

export default function TailoredCVView({ cv }: Props) {
  return (
    <div className="space-y-4">
      {(cv.jdKeywords.length > 0 || cv.gaps.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {cv.jdKeywords.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                <Target size={12} /> JD keywords surfaced ({cv.jdKeywords.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cv.jdKeywords.map((k, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-white/80 px-2 py-0.5 text-xs text-emerald-900"
                  >
                    {k}
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
        className="rounded-2xl border border-slate-200 bg-white px-10 py-9 shadow-sm text-slate-900"
        style={{ fontFamily: cvFontStack, fontSize: "11pt", lineHeight: 1.5 }}
      >
        <header className="mb-2">
          <h1 className="font-bold tracking-tight" style={{ fontSize: "22pt", lineHeight: 1.1 }}>
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
            <p>{cv.summary}</p>
          </Section>
        )}

        {cv.skills.length > 0 && (
          <Section title="Key Skills">
            <p>{cv.skills.join(", ")}</p>
          </Section>
        )}

        {cv.roles.length > 0 && (
          <Section title="Experience">
            <div className="space-y-4">
              {cv.roles.map((r, i) => {
                const dates = dateLine(r.startDate, r.endDate, r.isCurrent);
                return (
                  <div key={i}>
                    <div className="font-bold" style={{ fontSize: "11.5pt" }}>
                      {r.title}
                    </div>
                    <div className="text-slate-700">
                      {[r.company, r.location, dates ? <span key="d" className="text-slate-500">{dates}</span> : null]
                        .filter(Boolean)
                        .map((part, idx, arr) => (
                          <span key={idx}>
                            {part}
                            {idx < arr.length - 1 ? "  ·  " : ""}
                          </span>
                        ))}
                    </div>
                    {r.bullets.length > 0 && (
                      <ul className="mt-1.5 list-disc space-y-0.5 pl-6">
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
                return (
                  <div key={i}>
                    <div className="font-bold">
                      {e.qualification}
                      {years && (
                        <span className="ml-2 font-normal text-slate-500" style={{ fontSize: "10.5pt" }}>
                          ·  {years}
                        </span>
                      )}
                    </div>
                    <div className="text-slate-700">
                      {e.institution}
                      {e.classification ? `  ·  ${e.classification}` : ""}
                    </div>
                    {e.details && (
                      <p className="text-slate-600" style={{ fontSize: "10.5pt" }}>
                        {e.details}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {cv.certifications.length > 0 && (
          <Section title="Certifications">
            <ul className="list-disc space-y-0.5 pl-6">
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
    <section className="mt-4">
      <h2
        className="mb-1.5 border-b border-slate-400 pb-0.5 font-bold uppercase tracking-wider text-slate-800"
        style={{ fontSize: "11.5pt", letterSpacing: "0.06em" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
