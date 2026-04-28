// FactBase: the truth-grounded source of every claim a tailored CV can make.
//
// Every Fact has a traceable source (profile constants, work history, skills,
// or the base CV). The downstream Match → Rewrite → Critic pipeline is forbidden
// from inventing claims that do not appear in this FactBase.

export type FactSource = {
  origin: "profile" | "cv" | "work_history" | "skills";
  refId?: string;
};

export type FactKind =
  | "contact"
  | "summary"
  | "role"
  | "achievement"
  | "skill"
  | "education"
  | "certification"
  | "language"
  | "interest";

export interface ContactFact {
  id: string;
  kind: "contact";
  content: string;
  source: FactSource;
  field: "name" | "email" | "phone" | "location" | "linkedin" | "headline";
}

export interface SummaryFact {
  id: string;
  kind: "summary";
  content: string;
  source: FactSource;
}

export interface RoleFact {
  id: string;
  kind: "role";
  content: string;
  source: FactSource;
  company: string;
  title: string;
  startDate: string;
  endDate: string | null;
  isCurrent: boolean;
  location: string | null;
  employmentType: string | null;
  summary: string | null;
}

export interface AchievementFact {
  id: string;
  kind: "achievement";
  content: string;
  source: FactSource;
  roleId: string | null;
  inferredCompany: string | null;
}

export interface SkillFact {
  id: string;
  kind: "skill";
  content: string;
  source: FactSource;
  rawText: string;
  polishedText: string | null;
  roleIds: string[];
}

export interface EducationFact {
  id: string;
  kind: "education";
  content: string;
  source: FactSource;
  institution: string;
  qualification: string;
  classification: string | null;
  startYear: string | null;
  endYear: string | null;
  details: string | null;
}

export interface CertificationFact {
  id: string;
  kind: "certification";
  content: string;
  source: FactSource;
  issuer: string | null;
  year: string | null;
}

export interface LanguageFact {
  id: string;
  kind: "language";
  content: string;
  source: FactSource;
  language: string;
  proficiency: string;
}

export interface InterestFact {
  id: string;
  kind: "interest";
  content: string;
  source: FactSource;
}

export type Fact =
  | ContactFact
  | SummaryFact
  | RoleFact
  | AchievementFact
  | SkillFact
  | EducationFact
  | CertificationFact
  | LanguageFact
  | InterestFact;

export interface FactBase {
  userId: string;
  cvId: string | null;
  cvName: string | null;
  generatedAt: string;
  facts: Fact[];
  unmatchedCompanies: string[];
  warnings: string[];
}

export function factsOfKind<K extends Fact["kind"]>(
  fb: FactBase,
  kind: K
): Extract<Fact, { kind: K }>[] {
  return fb.facts.filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);
}

export function factById(fb: FactBase, id: string): Fact | undefined {
  return fb.facts.find((f) => f.id === id);
}

export function countByKind(fb: FactBase): Record<FactKind, number> {
  const counts: Record<FactKind, number> = {
    contact: 0,
    summary: 0,
    role: 0,
    achievement: 0,
    skill: 0,
    education: 0,
    certification: 0,
    language: 0,
    interest: 0,
  };
  for (const f of fb.facts) counts[f.kind]++;
  return counts;
}
