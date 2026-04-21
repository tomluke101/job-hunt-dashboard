"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";

export type Status = "considering" | "applied" | "interview" | "offer" | "rejected" | "withdrawn";

export interface Application {
  id: string;
  user_id: string;
  role: string;
  company: string;
  location: string;
  status: Status;
  stage: string;
  applied_date: string;
  salary?: string;
  url?: string;
  notes?: string;
  category?: string;
  work_location?: "onsite" | "remote" | "hybrid";
  job_description?: string;
  created_at: string;
}

export async function getApplications(): Promise<Application[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("applications")
    .select("*")
    .eq("user_id", userId)
    .order("applied_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) { console.error(error); return []; }
  return data ?? [];
}

export async function createApplication(input: Omit<Application, "id" | "user_id" | "created_at">) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .insert({ ...input, user_id: userId });

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}

export async function updateApplication(id: string, input: Partial<Omit<Application, "id" | "user_id" | "created_at">>) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .update(input)
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}

export async function deleteApplication(id: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}

export async function bulkUpdateStatus(ids: string[], status: Status) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .update({ status })
    .in("id", ids)
    .eq("user_id", userId);

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}

export async function bulkDeleteApplications(ids: string[]) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .delete()
    .in("id", ids)
    .eq("user_id", userId);

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}

export async function bulkImportApplications(apps: Omit<Application, "id" | "user_id" | "created_at">[]) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("applications")
    .insert(apps.map((a) => ({ ...a, user_id: userId })));

  if (error) throw error;
  revalidatePath("/tracker");
  revalidatePath("/");
}
