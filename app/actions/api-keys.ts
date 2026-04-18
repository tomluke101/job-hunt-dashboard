"use server";

import { auth } from "@clerk/nextjs/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { revalidatePath } from "next/cache";
import type { Provider } from "@/lib/ai-providers";

export type { Provider };

export interface ApiKey {
  provider: Provider;
  key_preview: string;
  created_at: string;
}

export async function getApiKeys(): Promise<ApiKey[]> {
  const { userId } = await auth();
  if (!userId) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_api_keys")
    .select("provider, key_preview, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return data ?? [];
}

// Returns actual key values — server-side only, never sent to client
export async function getApiKeyValues(): Promise<Partial<Record<Provider, string>>> {
  const { userId } = await auth();
  if (!userId) return {};

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from("user_api_keys")
    .select("provider, api_key")
    .eq("user_id", userId);

  if (!data) return {};
  return Object.fromEntries(data.map((row) => [row.provider, row.api_key]));
}

export async function saveApiKey(provider: Provider, key: string) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const key_preview = `${key.slice(0, 8)}...${key.slice(-4)}`;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("user_api_keys")
    .upsert(
      { user_id: userId, provider, api_key: key, key_preview },
      { onConflict: "user_id,provider" }
    );

  if (error) throw error;
  revalidatePath("/settings");
}

export async function deleteApiKey(provider: Provider) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorised");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("user_api_keys")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);

  if (error) throw error;
  revalidatePath("/settings");
}
