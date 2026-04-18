"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";
import type { Provider, Task } from "@/lib/ai-providers";

export type TaskPreferences = Partial<Record<Task, Provider | "auto">>;

export async function getTaskPreferences(): Promise<TaskPreferences> {
  const { userId } = await auth();
  if (!userId) return {};

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_task_preferences")
    .select("task, provider")
    .eq("user_id", userId);

  if (!data) return {};
  return Object.fromEntries(data.map((row) => [row.task, row.provider])) as TaskPreferences;
}

export async function setTaskPreference(task: Task, provider: Provider | "auto") {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("user_task_preferences")
    .upsert(
      { user_id: userId, task, provider, updated_at: new Date().toISOString() },
      { onConflict: "user_id,task" }
    );

  if (error) throw error;
  revalidatePath("/settings");
}
