"use client";

// Renders the structured HTML extracted from a .docx upload via mammoth.
// Mammoth's output is constrained (h1-h6, p, ul/ol/li, strong, em, br, table)
// and contains no scripts, but we still strip <script>/<style> as a precaution.

interface Props {
  html: string;
  maxHeightPx?: number;
}

const SCRIPT_OR_STYLE = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const EVENT_HANDLER_ATTR = /\son[a-z]+="[^"]*"/gi;

function sanitise(html: string): string {
  return html.replace(SCRIPT_OR_STYLE, "").replace(EVENT_HANDLER_ATTR, "");
}

export default function CVHtmlPreview({ html, maxHeightPx }: Props) {
  const safe = sanitise(html);
  return (
    <div
      className="cv-html-preview overflow-y-auto"
      style={maxHeightPx ? { maxHeight: maxHeightPx } : undefined}
    >
      <style>{`
        .cv-html-preview {
          font-family: Calibri, Arial, sans-serif;
          font-size: 11pt;
          line-height: 1.5;
          color: #111;
        }
        .cv-html-preview h1 { font-size: 20pt; font-weight: 700; margin: 0 0 6pt 0; line-height: 1.15; }
        .cv-html-preview h2 { font-size: 13pt; font-weight: 700; margin: 14pt 0 4pt 0; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #888; padding-bottom: 2pt; }
        .cv-html-preview h3 { font-size: 11.5pt; font-weight: 700; margin: 10pt 0 3pt 0; }
        .cv-html-preview h4 { font-size: 11pt; font-weight: 700; margin: 8pt 0 2pt 0; }
        .cv-html-preview p  { margin: 0 0 6pt 0; }
        .cv-html-preview ul, .cv-html-preview ol { margin: 4pt 0 6pt 22pt; padding: 0; }
        .cv-html-preview li { margin: 0 0 2pt 0; }
        .cv-html-preview strong { font-weight: 700; }
        .cv-html-preview em { font-style: italic; }
        .cv-html-preview a { color: #1d4ed8; text-decoration: underline; }
        .cv-html-preview img { max-width: 100%; height: auto; }
      `}</style>
      <div dangerouslySetInnerHTML={{ __html: safe }} />
    </div>
  );
}
