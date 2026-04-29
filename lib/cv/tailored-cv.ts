// TailoredCV is the structured output of the Match → Rewrite passes.
// It mirrors the shape of a finished CV but keeps everything as data so the
// UI can render it, the exporter can lay it out (Word / PDF), and the critic
// can validate every claim against the source FactBase.

export interface TailoredContact {
  name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
}

export interface TailoredRole {
  company: string;
  title: string;
  startDate: string;          // YYYY-MM
  endDate: string | null;     // YYYY-MM
  isCurrent: boolean;
  location: string | null;
  bullets: string[];
}

export interface TailoredEducation {
  qualification: string;
  institution: string;
  classification: string | null;
  startYear: string | null;
  endYear: string | null;
  details: string | null;
}

export interface TailoredCertification {
  content: string;
  issuer: string | null;
  year: string | null;
}

export interface TailoredLanguage {
  language: string;
  proficiency: string;
}

export interface TailoredSkillGroup {
  category: string;       // e.g. "Procurement & Supply Chain"
  items: string[];        // 3-5 short noun-phrase items in this group
}

export interface TailoredCV {
  contact: TailoredContact;
  summary: string;
  skills: TailoredSkillGroup[];   // 3-4 groups; each group renders as one categorised line
  roles: TailoredRole[];
  education: TailoredEducation[];
  certifications: TailoredCertification[];
  languages: TailoredLanguage[];
  interests: string[];

  jdKeywords: string[];   // top JD terms surfaced in the CV
  gaps: string[];         // JD requirements with no supporting FactBase evidence
}
