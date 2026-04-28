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

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm font-serif text-slate-900">
        <header className="border-b border-slate-200 pb-4">
          <h1 className="text-2xl font-bold tracking-tight">{cv.contact.name || "—"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-600">
            {cv.contact.location && <span>{cv.contact.location}</span>}
            {cv.contact.email && (
              <>
                <span className="text-slate-300">·</span>
                <span>{cv.contact.email}</span>
              </>
            )}
            {cv.contact.phone && (
              <>
                <span className="text-slate-300">·</span>
                <span>{cv.contact.phone}</span>
              </>
            )}
            {cv.contact.linkedin && (
              <>
                <span className="text-slate-300">·</span>
                <span>{cv.contact.linkedin}</span>
              </>
            )}
          </div>
        </header>

        {cv.summary && (
          <Section title="Profile">
            <p className="text-sm leading-relaxed">{cv.summary}</p>
          </Section>
        )}

        {cv.roles.length > 0 && (
          <Section title="Experience">
            <div className="space-y-5">
              {cv.roles.map((r, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{r.title}</div>
                      <div className="text-sm text-slate-700">
                        {r.company}
                        {r.location ? ` · ${r.location}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs text-slate-500 tabular-nums">
                      {formatDate(r.startDate)} – {r.isCurrent ? "Present" : formatDate(r.endDate)}
                    </div>
                  </div>
                  {r.bullets.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                      {r.bullets.map((b, j) => (
                        <li key={j}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {cv.education.length > 0 && (
          <Section title="Education">
            <div className="space-y-3">
              {cv.education.map((e, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-sm font-semibold">{e.qualification}</div>
                    <div className="shrink-0 text-xs text-slate-500 tabular-nums">
                      {[e.startYear, e.endYear].filter(Boolean).join(" – ")}
                    </div>
                  </div>
                  <div className="text-sm text-slate-700">
                    {e.institution}
                    {e.classification ? ` · ${e.classification}` : ""}
                  </div>
                  {e.details && <p className="mt-1 text-xs text-slate-600">{e.details}</p>}
                </div>
              ))}
            </div>
          </Section>
        )}

        {cv.skills.length > 0 && (
          <Section title="Skills">
            <div className="space-y-2">
              {cv.skills.map((g, i) => (
                <div key={i} className="text-sm">
                  <span className="font-semibold">{g.category}: </span>
                  <span className="text-slate-700">{g.items.join(", ")}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {cv.certifications.length > 0 && (
          <Section title="Certifications">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {cv.certifications.map((c, i) => (
                <li key={i}>
                  {c.content}
                  {(c.issuer || c.year) && (
                    <span className="text-slate-500">
                      {" "}
                      ({[c.issuer, c.year].filter(Boolean).join(", ")})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {cv.languages.length > 0 && (
          <Section title="Languages">
            <div className="flex flex-wrap gap-2 text-sm">
              {cv.languages.map((l, i) => (
                <span key={i} className="text-slate-700">
                  {l.language} ({l.proficiency})
                  {i < cv.languages.length - 1 ? "  ·  " : ""}
                </span>
              ))}
            </div>
          </Section>
        )}

        {cv.interests.length > 0 && (
          <Section title="Interests">
            <p className="text-sm text-slate-700">{cv.interests.join(", ")}</p>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 border-b border-slate-200 pb-1 text-xs font-bold uppercase tracking-wider text-slate-700">
        {title}
      </h2>
      {children}
    </section>
  );
}
