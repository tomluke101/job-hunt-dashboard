// ATS-safe export of a TailoredCV.
// Single-column. Standard sans-serif fonts. No tables, no text-boxes, no
// images, no headers/footers. Section headings are plain text, NOT styled
// with <h1>/<h2> background colours that confuse parsers.

import type { TailoredCV } from "./tailored-cv";

const MONTHS = [
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

function fmtDate(ym: string | null | undefined): string {
  if (!ym) return "";
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  if (!m) return ym;
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return ym;
  return `${MONTHS[month - 1]} ${m[1]}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Body of the CV — shared by Word + PDF exports.
// Uses INLINE styles (Word strips/ignores <style> tags reliably; inline wins).
function renderBody(cv: TailoredCV): string {
  const out: string[] = [];

  // Header — name + contact line
  const contactBits = [
    cv.contact.location,
    cv.contact.email,
    cv.contact.phone,
    cv.contact.linkedin,
  ]
    .filter(Boolean)
    .map((s) => escapeHtml(String(s)));

  out.push(
    `<div style="margin:0 0 6pt 0">
      <div style="font-size:18pt;font-weight:bold;margin:0 0 2pt 0">${escapeHtml(cv.contact.name || "")}</div>
      <div style="font-size:10pt;color:#333">${contactBits.join(" &nbsp;·&nbsp; ")}</div>
    </div>`
  );

  // Profile
  if (cv.summary) {
    out.push(sectionHeading("Profile"));
    out.push(
      `<p style="font-size:10.5pt;line-height:1.45;margin:0 0 8pt 0">${escapeHtml(cv.summary)}</p>`
    );
  }

  // Key Skills
  if (cv.skills.length > 0) {
    out.push(sectionHeading("Key Skills"));
    out.push(
      `<p style="font-size:10.5pt;line-height:1.45;margin:0 0 8pt 0">${cv.skills.map(escapeHtml).join(" &nbsp;·&nbsp; ")}</p>`
    );
  }

  // Experience
  if (cv.roles.length > 0) {
    out.push(sectionHeading("Experience"));
    for (const r of cv.roles) {
      const dateLine = `${fmtDate(r.startDate)} – ${r.isCurrent ? "Present" : fmtDate(r.endDate || "")}`;
      out.push(
        `<div style="margin:0 0 10pt 0">
          <div style="font-size:11pt;font-weight:bold;margin:0">${escapeHtml(r.title)}</div>
          <div style="font-size:10.5pt;margin:0 0 1pt 0">${escapeHtml(r.company)}${
            r.location ? ` &nbsp;·&nbsp; ${escapeHtml(r.location)}` : ""
          } &nbsp;·&nbsp; <span style="color:#555">${escapeHtml(dateLine)}</span></div>
          ${
            r.bullets.length > 0
              ? `<ul style="margin:4pt 0 0 18pt;padding:0;font-size:10.5pt;line-height:1.45">
                  ${r.bullets.map((b) => `<li style="margin:0 0 2pt 0">${escapeHtml(b)}</li>`).join("")}
                </ul>`
              : ""
          }
        </div>`
      );
    }
  }

  // Education
  if (cv.education.length > 0) {
    out.push(sectionHeading("Education"));
    for (const e of cv.education) {
      const years = [e.startYear, e.endYear].filter(Boolean).join(" – ");
      out.push(
        `<div style="margin:0 0 6pt 0;font-size:10.5pt;line-height:1.45">
          <div style="font-weight:bold">${escapeHtml(e.qualification)}${
            years ? ` <span style="font-weight:normal;color:#555;font-size:10pt"> &nbsp;·&nbsp; ${escapeHtml(years)}</span>` : ""
          }</div>
          <div>${escapeHtml(e.institution)}${
            e.classification ? ` &nbsp;·&nbsp; ${escapeHtml(e.classification)}` : ""
          }</div>
          ${e.details ? `<div style="font-size:10pt;color:#555">${escapeHtml(e.details)}</div>` : ""}
        </div>`
      );
    }
  }

  // Certifications
  if (cv.certifications.length > 0) {
    out.push(sectionHeading("Certifications"));
    out.push(
      `<ul style="margin:0 0 6pt 18pt;padding:0;font-size:10.5pt;line-height:1.45">
        ${cv.certifications
          .map((c) => {
            const meta = [c.issuer, c.year].filter(Boolean).join(", ");
            return `<li style="margin:0 0 2pt 0">${escapeHtml(c.content)}${
              meta ? ` <span style="color:#555">(${escapeHtml(meta)})</span>` : ""
            }</li>`;
          })
          .join("")}
      </ul>`
    );
  }

  // Languages
  if (cv.languages.length > 0) {
    out.push(sectionHeading("Languages"));
    out.push(
      `<p style="font-size:10.5pt;line-height:1.45;margin:0 0 6pt 0">${cv.languages
        .map((l) => `${escapeHtml(l.language)} (${escapeHtml(l.proficiency || "—")})`)
        .join(" &nbsp;·&nbsp; ")}</p>`
    );
  }

  // Interests
  if (cv.interests.length > 0) {
    out.push(sectionHeading("Interests"));
    out.push(
      `<p style="font-size:10.5pt;line-height:1.45;margin:0 0 6pt 0">${cv.interests
        .map(escapeHtml)
        .join(", ")}</p>`
    );
  }

  return out.join("\n");
}

function sectionHeading(label: string): string {
  return `<div style="font-size:11pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid #888;padding:0 0 1pt 0;margin:10pt 0 4pt 0">${escapeHtml(
    label
  )}</div>`;
}

export function tailoredCVToWordHtml(cv: TailoredCV): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif;color:#111;max-width:680px;margin:30pt auto;padding:0">${renderBody(
    cv
  )}</body></html>`;
}

export function tailoredCVToPrintHtml(cv: TailoredCV): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(cv.contact.name || "CV")}</title>
<style>
  @page { size: A4; margin: 18mm 18mm; }
  body { font-family: Calibri, Arial, sans-serif; color: #111; max-width: 680px; margin: 0 auto; padding: 12pt 0 0 0; }
</style>
</head><body>${renderBody(cv)}<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},150);});<\/script></body></html>`;
}

export function cvFileBaseName(cv: TailoredCV, companyName?: string, roleName?: string): string {
  const candidate = [cv.contact.name, roleName, companyName, "CV"]
    .filter(Boolean)
    .join("-");
  return candidate.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").toLowerCase() || "cv";
}
