"use server";

import { extractFactBase, ExtractFactBaseOptions, ExtractFactBaseResult } from "@/lib/cv/extract";
import {
  tailorCV as tailorCVImpl,
  refineTailoredCV as refineTailoredCVImpl,
  TailorInput,
  RefineInput,
  TailorResult,
} from "@/lib/cv/tailor";

export async function getFactBase(
  options: ExtractFactBaseOptions = {}
): Promise<ExtractFactBaseResult> {
  return extractFactBase(options);
}

export async function tailorCV(input: TailorInput): Promise<TailorResult> {
  return tailorCVImpl(input);
}

export async function refineTailoredCV(input: RefineInput): Promise<TailorResult> {
  return refineTailoredCVImpl(input);
}
