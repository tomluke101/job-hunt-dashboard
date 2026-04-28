import { AlertTriangle, FileText, RefreshCw } from "lucide-react";
import Link from "next/link";
import PageHeader from "../../_components/PageHeader";
import { getFactBase } from "@/app/actions/cv-tailoring";
import {
  AchievementFact,
  CertificationFact,
  ContactFact,
  countByKind,
  EducationFact,
  Fact,
  FactBase,
  FactKind,
  factsOfKind,
  InterestFact,
  LanguageFact,
  RoleFact,
  SkillFact,
  SummaryFact,
} from "@/lib/cv/factbase";

const KIND_LABELS: Record<FactKind, string> = {
  contact: "Contact",
  summary: "Profile / summary",
  role: "Roles (work history)",
  achievement: "Achievements (CV bullets)",
  skill: "Skills",
  education: "Education",
  certification: "Certifications",
  language: "Languages",
  interest: "Interests",
};

export default async function CVDebugPage() {
  const result = await getFactBase();

  return (
    <div className="p-8">
      <PageHeader
        title="CV FactBase — Phase 0 review"
        description="Every claim available to the tailoring pipeline. Source-attributed; nothing here is invented."
      />

      {result.error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          {result.error}
        </div>
      )}

      {result.factBase && <FactBaseView fb={result.factBase} />}
    </div>
  );
}

function FactBaseView({ fb }: { fb: FactBase }) {
  const counts = countByKind(fb);
  const total = fb.facts.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total facts" value={String(total)} />
        <Stat label="Roles" value={String(counts.role)} />
        <Stat label="Achievements" value={String(counts.achievement)} />
        <Stat label="Skills" value={String(counts.skill)} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <FileText className="h-3.5 w-3.5" />
          <span>
            Base CV: {fb.cvName ?? "—"}{" "}
            {fb.cvId ? <span className="text-slate-400">({fb.cvId.slice(0, 8)})</span> : null}
          </span>
          <span className="text-slate-300">·</span>
          <span>Generated: {new Date(fb.generatedAt).toLocaleString()}</span>
          <Link
            href="/cv/debug"
            className="ml-auto inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </Link>
        </div>
      </div>

      {fb.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-900">
            <AlertTriangle className="h-4 w-4" /> Warnings ({fb.warnings.length})
          </div>
          <ul className="space-y-1 text-sm text-amber-900">
            {fb.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        </div>
      )}

      {fb.unmatchedCompanies.length > 0 && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
          <div className="mb-2 text-sm font-medium text-violet-900">
            Companies in CV not in Work History ({fb.unmatchedCompanies.length})
          </div>
          <p className="mb-2 text-xs text-violet-900/80">
            Bullets under these employers won&apos;t be linked to a structured role until you add them on
            the Profile page.
          </p>
          <ul className="flex flex-wrap gap-2 text-sm text-violet-900">
            {fb.unmatchedCompanies.map((c, i) => (
              <li key={i} className="rounded-full bg-white/70 px-2 py-0.5">
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title={KIND_LABELS.contact} count={counts.contact}>
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {factsOfKind(fb, "contact").map((f: ContactFact) => (
            <li key={f.id} className="flex items-baseline gap-2">
              <span className="w-20 text-xs uppercase tracking-wide text-slate-400">{f.field}</span>
              <span className="text-slate-900">{f.content}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.summary} count={counts.summary}>
        {factsOfKind(fb, "summary").map((f: SummaryFact) => (
          <p key={f.id} className="text-sm text-slate-800">
            {f.content}
          </p>
        ))}
      </Section>

      <Section title={KIND_LABELS.role} count={counts.role}>
        <ul className="space-y-3">
          {factsOfKind(fb, "role").map((r: RoleFact) => {
            const achievementsForRole = factsOfKind(fb, "achievement").filter(
              (a) => a.roleId === r.id
            );
            return (
              <li key={r.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="font-medium text-slate-900">
                  {r.title} <span className="text-slate-500">at</span> {r.company}
                </div>
                <div className="text-xs text-slate-500">
                  {r.startDate || "?"} – {r.isCurrent ? "Present" : r.endDate || "?"}
                  {r.location ? ` · ${r.location}` : ""}
                  {r.employmentType ? ` · ${r.employmentType}` : ""}
                </div>
                {r.summary && <p className="mt-1 text-xs italic text-slate-600">{r.summary}</p>}
                {achievementsForRole.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-800">
                    {achievementsForRole.map((a) => (
                      <li key={a.id} className="pl-3">
                        • {a.content}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title={`${KIND_LABELS.achievement} unlinked to a known role`}
        count={
          factsOfKind(fb, "achievement").filter((a: AchievementFact) => !a.roleId).length
        }
      >
        <ul className="space-y-1 text-sm text-slate-800">
          {factsOfKind(fb, "achievement")
            .filter((a) => !a.roleId)
            .map((a) => (
              <li key={a.id}>
                • {a.content}
                {a.inferredCompany && (
                  <span className="ml-2 text-xs text-slate-500">
                    [CV company: {a.inferredCompany}]
                  </span>
                )}
              </li>
            ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.skill} count={counts.skill}>
        <ul className="space-y-2 text-sm">
          {factsOfKind(fb, "skill").map((s: SkillFact) => (
            <li key={s.id}>
              <div className="text-slate-900">{s.content}</div>
              {s.roleIds.length > 0 && (
                <div className="text-xs text-slate-500">
                  attributed to {s.roleIds.length} role{s.roleIds.length === 1 ? "" : "s"}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.education} count={counts.education}>
        <ul className="space-y-2 text-sm">
          {factsOfKind(fb, "education").map((e: EducationFact) => (
            <li key={e.id} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="font-medium text-slate-900">{e.qualification}</div>
              <div className="text-slate-700">{e.institution}</div>
              <div className="text-xs text-slate-500">
                {[e.classification, [e.startYear, e.endYear].filter(Boolean).join(" – ")]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {e.details && <p className="mt-1 text-xs text-slate-600">{e.details}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.certification} count={counts.certification}>
        <ul className="space-y-1 text-sm text-slate-800">
          {factsOfKind(fb, "certification").map((c: CertificationFact) => (
            <li key={c.id}>
              • {c.content}
              {(c.issuer || c.year) && (
                <span className="ml-2 text-xs text-slate-500">
                  {[c.issuer, c.year].filter(Boolean).join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.language} count={counts.language}>
        <ul className="flex flex-wrap gap-2 text-sm">
          {factsOfKind(fb, "language").map((l: LanguageFact) => (
            <li key={l.id} className="rounded-full bg-slate-100 px-3 py-1 text-slate-800">
              {l.content}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={KIND_LABELS.interest} count={counts.interest}>
        <ul className="flex flex-wrap gap-2 text-sm">
          {factsOfKind(fb, "interest").map((i: InterestFact) => (
            <li key={i.id} className="rounded-full bg-slate-100 px-3 py-1 text-slate-800">
              {i.content}
            </li>
          ))}
        </ul>
      </Section>

      <details className="rounded-xl border border-slate-200 bg-white p-4 text-xs">
        <summary className="cursor-pointer text-slate-600">Raw JSON</summary>
        <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-700">
          {JSON.stringify(fb, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-medium text-slate-900">{title}</h2>
        <p className="text-xs text-slate-400">none</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-900">
        {title} <span className="text-slate-400">({count})</span>
      </h2>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

// Suppress unused-import warnings for narrowed type guards used inline.
type _Used = Fact;
