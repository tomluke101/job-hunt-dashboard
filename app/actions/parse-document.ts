"use server";

import { extractText } from "unpdf";

export interface ParseDocumentResult {
  text: string;          // plain text (for AI / search)
  html?: string;         // structured HTML when the source supports it (.docx)
}

export async function parseDocument(formData: FormData): Promise<ParseDocumentResult> {
  const file = formData.get("file") as File | null;
  if (!file) throw new Error("No file provided");

  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".pdf")) {
    const uint8 = new Uint8Array(buffer);
    const { text } = await extractText(uint8, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n") : text };
  }

  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const mammoth = await import("mammoth");
    // Run text + HTML extraction in parallel. Text is for AI/search, HTML is
    // for the rendered preview so the user sees the real CV structure.
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ buffer }),
      mammoth.convertToHtml(
        { buffer },
        {
          // Map common Word styles to clean semantic HTML. ATS won't see this
          // (we keep `text` separately) — this is purely for the preview.
          styleMap: [
            "p[style-name='Heading 1'] => h2:fresh",
            "p[style-name='Heading 2'] => h3:fresh",
            "p[style-name='Heading 3'] => h4:fresh",
            "p[style-name='Title'] => h1:fresh",
            "b => strong",
            "i => em",
          ],
        }
      ),
    ]);
    return { text: textResult.value, html: htmlResult.value };
  }

  if (name.endsWith(".txt") || name.endsWith(".text")) {
    return { text: buffer.toString("utf-8") };
  }

  throw new Error("Unsupported file type. Please upload a PDF, Word document (.docx), or plain text (.txt) file.");
}
