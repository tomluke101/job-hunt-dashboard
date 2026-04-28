"use server";

import { extractFactBase, ExtractFactBaseOptions, ExtractFactBaseResult } from "@/lib/cv/extract";

export async function getFactBase(
  options: ExtractFactBaseOptions = {}
): Promise<ExtractFactBaseResult> {
  return extractFactBase(options);
}
