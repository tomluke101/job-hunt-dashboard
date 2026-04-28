import { auth } from "@clerk/nextjs/server";
import { createHash } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { callAI } from "@/lib/ai-router";
import { getApiKeyValues } from "@/app/actions/api-keys";
import {
  AchievementFact,
  CertificationFact,
  ContactFact,
  EducationFact,
  Fact,
  FactBase,
  InterestFact,
  LanguageFact,
  RoleFact,
  SkillFact,
  SummaryFact,
} from "./factbase";

const newId = () => crypto.randomUUID();

interface CVParseResult {
  summary?: string;
  achievements?: { content: string; company?: string | null }[];
  educations?: {
    institution?: string;
    qualification?: string;
    classification?: string | null;
    startYear?: string | null;
    endYear?: string | null;
    details?: string | null;
  }[];
  certifications?: { content?: string; issuer?: string | null; year?: string | null }[];
  languages?: { language?: string; proficiency?: string }[];
  interests?: string[];
  unmatchedCompanies?: string[];
}

const CV_PARSER_SYSTEM = `You extract structured facts from a CV. Return ONLY a valid JSON object — no preamble, no markdown fences.

You will be given the CV text AND a list of the candidate's known employers. Your job is to extract:

- summary: the candidate's profile / personal statement section if present (a short paragraph at the top of the CV). Verbatim — do not rewrite. Empty string if no profile section.
- achievements: bullet points from each role's experience section. For each bullet, return { content, company } where:
   - content: the bullet text VERBATIM (do not rewrite, do not embellish, do not invent metrics)
   - company: the company name from the CV header for that role. We will match this against the known employers list.
- educations: degrees and qualifications. Return institution, qualification (e.g. "BSc Economics"), classification (e.g. "2:1", "First", "Distinction"), startYear, endYear, details (modules / dissertation / honours) if present.
- certifications: any certifications, professional qualifications, or notable courses. Return content (full name), issuer, year.
- languages: any language proficiencies. Return language and proficiency level.
- interests: any hobbies / interests / volunteering / extracurricular activities as short strings.
- unmatchedCompanies: any company names you found in the CV's experience section that don't appear in the known employers list — return as bare strings.

CRITICAL RULES:
- Do NOT extract contact info (name, email, phone, address, LinkedIn) — we already have these.
- Do NOT extract skills lists from a Skills section — we have those separately.
- Do NOT extract work-history dates or job titles — we have those separately.
- Do NOT invent, embellish, or summarise. If a bullet says "managed warehouse team", do not return "led cross-functional warehouse operations team".
- If a section is absent from the CV, return an empty array (or empty string for summary).
- Verbatim where possible. Trim whitespace, fix obvious encoding issues, but preserve substance exactly.

Return ONLY the JSON object, schema:
{
  "summary": string,
  "achievements": [{ "content": string, "company": string | null }],
  "educations": [{ "institution": string, "qualification": string, "classification": string | null, "startYear": string | null, "endYear": string | null, "details": string | null }],
  "certifications": [{ "content": string, "issuer": string | null, "year": string | null }],
  "languages": [{ "language": string, "proficiency": string }],
  "interests": [string],
  "unmatchedCompanies": [string]
}`;

export interface ExtractFactBaseOptions {
  cvId?: string;
}

export interface ExtractFactBaseResult {
  factBase?: FactBase;
  error?: string;
}

export async function extractFactBase(
  options: ExtractFactBaseOptions = {}
): Promise<ExtractFactBaseResult> {
  try {
    const { userId } = await auth();
    if (!userId) return { error: "Not signed in" };

    const supabase = await createServerSupabaseClient();

    const [profileResult, employersResult, skillsResult, skillEmployersResult, cvsResult] =
      await Promise.all([
        supabase.from("user_profile").select("*").eq("user_id", userId).maybeSingle(),
        supabase
          .from("user_employers")
          .select("*")
          .eq("user_id", userId)
          .order("is_current", { ascending: false })
          .order("end_date", { ascending: false, nullsFirst: true })
          .order("start_date", { ascending: false }),
        supabase
          .from("user_skills")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: true }),
        supabase.from("user_skill_employers").select("skill_id, employer_id"),
        supabase
          .from("user_cvs")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
      ]);

    const profile = profileResult.data ?? null;
    const employers = employersResult.data ?? [];
    const skills = skillsResult.data ?? [];
    const skillLinks = skillEmployersResult.data ?? [];
    const cvs = cvsResult.data ?? [];

    const cv = options.cvId
      ? cvs.find((c) => c.id === options.cvId)
      : cvs.find((c) => c.is_default) ?? cvs[0];

    const facts: Fact[] = [];
    const warnings: string[] = [];
    const employerIdToFactId = new Map<string, string>();

    // 1. Contact constants from user_profile
    if (profile?.full_name) facts.push(makeContact("name", profile.full_name));
    if (profile?.email) facts.push(makeContact("email", profile.email));
    if (profile?.phone) facts.push(makeContact("phone", profile.phone));
    if (profile?.location) facts.push(makeContact("location", profile.location));
    if (profile?.linkedin_url) facts.push(makeContact("linkedin", profile.linkedin_url));
    if (profile?.headline) facts.push(makeContact("headline", profile.headline));

    // 2. Roles from work history
    for (const e of employers) {
      const roleFact: RoleFact = {
        id: newId(),
        kind: "role",
        content: `${e.role_title} at ${e.company_name}`,
        source: { origin: "work_history", refId: e.id },
        company: e.company_name,
        title: e.role_title,
        startDate: e.start_date ? String(e.start_date).slice(0, 7) : "",
        endDate: e.end_date ? String(e.end_date).slice(0, 7) : null,
        isCurrent: !!e.is_current,
        location: e.location ?? null,
        employmentType: e.employment_type ?? null,
        summary: e.summary ?? null,
      };
      facts.push(roleFact);
      employerIdToFactId.set(e.id, roleFact.id);
    }

    // 3. Skills with employer attributions
    const linksBySkill = new Map<string, string[]>();
    for (const link of skillLinks) {
      const list = linksBySkill.get(link.skill_id) ?? [];
      list.push(link.employer_id);
      linksBySkill.set(link.skill_id, list);
    }
    for (const s of skills) {
      const linkedEmployerIds = linksBySkill.get(s.id) ?? [];
      const roleIds = linkedEmployerIds
        .map((eid) => employerIdToFactId.get(eid))
        .filter((x): x is string => !!x);
      const skillFact: SkillFact = {
        id: newId(),
        kind: "skill",
        content: s.polished_text || s.raw_text,
        source: { origin: "skills", refId: s.id },
        rawText: s.raw_text,
        polishedText: s.polished_text || null,
        roleIds,
      };
      facts.push(skillFact);
    }

    // 4. AI parse of the base CV (summary, achievements, education, certs, languages, interests)
    let unmatchedCompanies: string[] = [];

    if (!cv) {
      warnings.push(
        "No base CV found. Add one to your Profile to enable Tailor mode (or use Build-from-scratch)."
      );
    } else if (!cv.content || !cv.content.trim()) {
      warnings.push("Base CV is empty. Re-upload the CV file in your Profile.");
    } else {
      // Build a hash capturing everything that affects the AI parse: the CV
      // content AND the known employer list (used in the prompt for matching).
      const knownEmployersBlock = employers
        .map(
          (e, i) =>
            `${i + 1}. company: "${e.company_name}" | title: "${e.role_title}" | dates: ${
              e.start_date ? String(e.start_date).slice(0, 7) : "?"
            }–${e.is_current ? "Present" : e.end_date ? String(e.end_date).slice(0, 7) : "?"}`
        )
        .join("\n");
      const cacheHash = createHash("sha256")
        .update(cv.content)
        .update("\n--EMPLOYERS--\n")
        .update(knownEmployersBlock)
        .digest("hex");

      let parsed: CVParseResult | null = null;

      const cached = await supabase
        .from("cv_parsed_cache")
        .select("parsed, content_hash")
        .eq("cv_id", cv.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (cached.data && cached.data.content_hash === cacheHash) {
        parsed = cached.data.parsed as CVParseResult;
      }

      if (!parsed) {
        const keys = await getApiKeyValues();
        if (Object.keys(keys).length === 0) {
          warnings.push(
            "No AI provider connected — CV bullets, education, and certifications were not extracted. Add an API key in Settings."
          );
        } else {
          try {
            const result = await callAI({
              task: "cv-tailor",
              connectedProviders: keys,
              systemPrompt: CV_PARSER_SYSTEM,
              prompt: `Known employers (use these to match achievements):\n${
                knownEmployersBlock || "(none — no work history entered yet)"
              }\n\nCV TEXT:\n${cv.content.slice(0, 15000)}`,
            });

            parsed = safeParseJSON(result.text) as CVParseResult | null;
            if (parsed) {
              const upsert = await supabase.from("cv_parsed_cache").upsert(
                {
                  cv_id: cv.id,
                  user_id: userId,
                  content_hash: cacheHash,
                  parsed,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "cv_id" }
              );
              if (upsert.error) {
                console.error("[extractFactBase] cache upsert failed:", upsert.error);
              }
            } else {
              warnings.push(
                "CV parse returned non-JSON output. Bullets, education, and certifications were not extracted."
              );
            }
          } catch (e) {
            console.error("[extractFactBase] CV parse failed:", e);
            warnings.push(
              "CV parse failed: " +
                (e instanceof Error ? e.message : "unknown error") +
                ". Tailor mode can still run on Work History and Skills only."
            );
          }
        }
      }

      if (parsed) {
        if (parsed.summary && parsed.summary.trim()) {
          const summaryFact: SummaryFact = {
            id: newId(),
            kind: "summary",
            content: parsed.summary.trim(),
            source: { origin: "cv", refId: cv.id },
          };
          facts.push(summaryFact);
        }

        const employersByCompany = new Map<string, string>();
        for (const e of employers) {
          const factId = employerIdToFactId.get(e.id);
          if (factId) employersByCompany.set(normaliseCompany(e.company_name), factId);
        }

        for (const a of parsed.achievements ?? []) {
          const content = (a.content ?? "").trim();
          if (!content) continue;
          const companyKey = a.company ? normaliseCompany(a.company) : "";
          const matchedRoleId = companyKey ? employersByCompany.get(companyKey) ?? null : null;
          const achievementFact: AchievementFact = {
            id: newId(),
            kind: "achievement",
            content,
            source: { origin: "cv", refId: cv.id },
            roleId: matchedRoleId,
            inferredCompany: matchedRoleId ? null : (a.company ?? null),
          };
          facts.push(achievementFact);
        }

        for (const ed of parsed.educations ?? []) {
          const institution = (ed.institution ?? "").trim();
          const qualification = (ed.qualification ?? "").trim();
          if (!institution || !qualification) continue;
          const eduFact: EducationFact = {
            id: newId(),
            kind: "education",
            content: `${qualification}, ${institution}${
              ed.classification ? ` (${ed.classification.trim()})` : ""
            }`,
            source: { origin: "cv", refId: cv.id },
            institution,
            qualification,
            classification: ed.classification?.trim() || null,
            startYear: ed.startYear?.trim() || null,
            endYear: ed.endYear?.trim() || null,
            details: ed.details?.trim() || null,
          };
          facts.push(eduFact);
        }

        for (const c of parsed.certifications ?? []) {
          const content = (c.content ?? "").trim();
          if (!content) continue;
          const certFact: CertificationFact = {
            id: newId(),
            kind: "certification",
            content,
            source: { origin: "cv", refId: cv.id },
            issuer: c.issuer?.trim() || null,
            year: c.year?.trim() || null,
          };
          facts.push(certFact);
        }

        for (const l of parsed.languages ?? []) {
          const language = (l.language ?? "").trim();
          if (!language) continue;
          const proficiency = (l.proficiency ?? "").trim();
          const langFact: LanguageFact = {
            id: newId(),
            kind: "language",
            content: proficiency ? `${language} (${proficiency})` : language,
            source: { origin: "cv", refId: cv.id },
            language,
            proficiency,
          };
          facts.push(langFact);
        }

        for (const i of parsed.interests ?? []) {
          const trimmed = String(i || "").trim();
          if (!trimmed) continue;
          const interestFact: InterestFact = {
            id: newId(),
            kind: "interest",
            content: trimmed,
            source: { origin: "cv", refId: cv.id },
          };
          facts.push(interestFact);
        }

        unmatchedCompanies = (parsed.unmatchedCompanies ?? [])
          .map((s) => String(s || "").trim())
          .filter(Boolean);
      }
    }

    return {
      factBase: {
        userId,
        cvId: cv?.id ?? null,
        cvName: cv?.name ?? null,
        generatedAt: new Date().toISOString(),
        facts,
        unmatchedCompanies,
        warnings,
      },
    };
  } catch (e) {
    console.error("[extractFactBase] unexpected:", e);
    return { error: e instanceof Error ? e.message : "FactBase extraction failed." };
  }
}

function makeContact(field: ContactFact["field"], value: string): ContactFact {
  return {
    id: newId(),
    kind: "contact",
    content: value,
    source: { origin: "profile" },
    field,
  };
}

function safeParseJSON(text: string): unknown {
  try {
    const trimmed = (text ?? "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normaliseCompany(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llc|inc|incorporated|gmbh|sa|ag|co\.?|company|group|holdings)\b/g, "")
    .replace(/[^\w]/g, "")
    .trim();
}
