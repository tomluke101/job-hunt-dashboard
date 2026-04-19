"use server";

import { extractText } from "unpdf";

export async function parseDocument(formData: FormData): Promise<{ text: string }> {
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
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  }

  if (name.endsWith(".txt") || name.endsWith(".text")) {
    return { text: buffer.toString("utf-8") };
  }

  throw new Error("Unsupported file type. Please upload a PDF, Word document (.docx), or plain text (.txt) file.");
}
