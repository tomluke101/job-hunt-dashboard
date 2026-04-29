// ATS-safe export of a TailoredCV.
// Single-column flow. Standard sans-serif font (Calibri/Arial/Helvetica).
// Date right-alignment uses a 2-cell single-row borderless table — the only
// reliable Word-HTML pattern for inline alignment without breaking ATS reading
// order (cells contain plain inline text only, no nested layout).

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

function dateRange(start: string, end: string | null, isCurrent: boolean): string {
  const s = fmtDate(start);
  const e = isCurrent ? "Present" : fmtDate(end || "");
  if (s && e) return `${s} – ${e}`;
  return s || e || "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Title-left + date-right alignment row. Borderless 2-cell table; ATS parses
// these as plain inline text in reading order.
function titleDateRow(titleHtml: string, dateText: string): string {
  return `<table cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 1pt 0">
    <tr>
      <td style="padding:0;vertical-align:baseline">${titleHtml}</td>
      <td style="padding:0;vertical-align:baseline;text-align:right;color:#555;font-size:10.5pt;white-space:nowrap">${escapeHtml(
        dateText
      )}</td>
    </tr>
  </table>`;
}

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
    `<div style="margin:0 0 10pt 0">
      <div style="font-size:24pt;font-weight:bold;letter-spacing:-0.01em;line-height:1.1;margin:0 0 4pt 0">${escapeHtml(cv.contact.name || "")}</div>
      <div style="font-size:10.5pt;color:#444">${contactBits.join(" &nbsp;·&nbsp; ")}</div>
    </div>`
  );

  // Profile
  if (cv.summary) {
    out.push(sectionHeading("Profile"));
    out.push(
      `<p style="font-size:11pt;line-height:1.5;margin:0 0 10pt 0;text-align:justify">${escapeHtml(cv.summary)}</p>`
    );
  }

  // Key Skills — categorised lines with bold category labels
  if (cv.skills.length > 0) {
    out.push(sectionHeading("Key Skills"));
    out.push(`<div style="margin:0 0 10pt 0">`);
    for (const g of cv.skills) {
      out.push(
        `<p style="font-size:11pt;line-height:1.55;margin:0 0 3pt 0"><span style="font-weight:bold">${escapeHtml(
          g.category
        )}:</span> <span style="color:#222">${g.items.map(escapeHtml).join(", ")}</span></p>`
      );
    }
    out.push(`</div>`);
  }

  // Experience
  if (cv.roles.length > 0) {
    out.push(sectionHeading("Experience"));
    for (const r of cv.roles) {
      const dates = dateRange(r.startDate, r.endDate, r.isCurrent);
      out.push(`<div style="margin:0 0 11pt 0">`);
      out.push(
        titleDateRow(
          `<span style="font-size:11.5pt;font-weight:bold">${escapeHtml(r.title)}</span>`,
          dates
        )
      );
      const sub = [escapeHtml(r.company), r.location ? escapeHtml(r.location) : null]
        .filter(Boolean)
        .join(" &nbsp;·&nbsp; ");
      if (sub) {
        out.push(
          `<div style="font-size:11pt;color:#222;margin:0 0 3pt 0">${sub}</div>`
        );
      }
      if (r.bullets.length > 0) {
        out.push(
          `<ul style="margin:2pt 0 0 18pt;padding:0;font-size:11pt;line-height:1.5">
            ${r.bullets.map((b) => `<li style="margin:0 0 3pt 0">${escapeHtml(b)}</li>`).join("")}
          </ul>`
        );
      }
      out.push(`</div>`);
    }
  }

  // Education
  if (cv.education.length > 0) {
    out.push(sectionHeading("Education"));
    for (const e of cv.education) {
      const years = [e.startYear, e.endYear].filter(Boolean).join(" – ");
      out.push(`<div style="margin:0 0 7pt 0">`);
      out.push(
        titleDateRow(
          `<span style="font-size:11pt;font-weight:bold">${escapeHtml(e.qualification)}</span>`,
          years
        )
      );
      const subBits = [
        escapeHtml(e.institution),
        e.classification ? escapeHtml(e.classification) : null,
      ]
        .filter(Boolean)
        .join(" &nbsp;·&nbsp; ");
      if (subBits) {
        out.push(
          `<div style="font-size:11pt;color:#222;margin:0 0 1pt 0">${subBits}</div>`
        );
      }
      if (e.details) {
        out.push(
          `<div style="font-size:10.5pt;color:#555;margin:0">${escapeHtml(e.details)}</div>`
        );
      }
      out.push(`</div>`);
    }
  }

  // Certifications
  if (cv.certifications.length > 0) {
    out.push(sectionHeading("Certifications"));
    out.push(
      `<ul style="margin:0 0 8pt 18pt;padding:0;font-size:11pt;line-height:1.5">
        ${cv.certifications
          .map((c) => {
            const meta = [c.issuer, c.year].filter(Boolean).join(", ");
            return `<li style="margin:0 0 3pt 0">${escapeHtml(c.content)}${
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
      `<p style="font-size:11pt;line-height:1.5;margin:0 0 8pt 0">${cv.languages
        .map((l) =>
          l.proficiency ? `${escapeHtml(l.language)} (${escapeHtml(l.proficiency)})` : escapeHtml(l.language)
        )
        .join(", ")}</p>`
    );
  }

  // Interests
  if (cv.interests.length > 0) {
    out.push(sectionHeading("Interests"));
    out.push(
      `<p style="font-size:11pt;line-height:1.5;margin:0 0 8pt 0">${cv.interests
        .map(escapeHtml)
        .join(", ")}</p>`
    );
  }

  return out.join("\n");
}

function sectionHeading(label: string): string {
  return `<div style="font-size:10.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.10em;color:#1a1a1a;border-bottom:0.75pt solid #888;padding:0 0 2pt 0;margin:14pt 0 6pt 0">${escapeHtml(
    label
  )}</div>`;
}

export function tailoredCVToWordHtml(cv: TailoredCV): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif;color:#111;max-width:680px;margin:36pt auto;padding:0 18pt">${renderBody(
    cv
  )}</body></html>`;
}

export function tailoredCVToPrintHtml(cv: TailoredCV): string {
  return `<!DOCTYPE html><html><head><title>${escapeHtml(cv.contact.name || "CV")}</title>
<style>
  @page { size: A4; margin: 18mm 18mm; }
  body { font-family: Calibri, Arial, sans-serif; color: #111; max-width: 680px; margin: 0 auto; padding: 12pt 0 0 0; }
  table { page-break-inside: avoid; }
  ul { page-break-inside: avoid; }
  li { page-break-inside: avoid; }
  div { page-break-inside: avoid; }
</style>
</head><body>${renderBody(cv)}<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},150);});<\/script></body></html>`;
}

export function cvFileBaseName(cv: TailoredCV, companyName?: string, roleName?: string): string {
  const candidate = [cv.contact.name, roleName, companyName, "CV"]
    .filter(Boolean)
    .join("-");
  return candidate.replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").toLowerCase() || "cv";
}
