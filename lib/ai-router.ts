import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Mistral } from "@mistralai/mistralai";
import { Provider, PROVIDERS, Task, resolveProvider } from "./ai-providers";

export interface CallAIOptions {
  task: Task;
  prompt: string;
  systemPrompt?: string;
  userPreference?: Provider | "auto";
  connectedProviders: Partial<Record<Provider, string>>; // provider → api key
}

export interface CallAIResult {
  provider: Provider;
  model: string;
  text: string;
}

export async function callAI(options: CallAIOptions): Promise<CallAIResult> {
  const { task, prompt, systemPrompt, userPreference, connectedProviders } = options;

  const connected = new Set(
    (Object.keys(connectedProviders) as Provider[]).filter((p) => !!connectedProviders[p])
  );

  const provider = resolveProvider(task, userPreference, connected);
  if (!provider) {
    throw new Error(
      "No AI provider available for this task. Please connect at least one API key in Settings."
    );
  }

  const meta = PROVIDERS[provider];
  const apiKey = connectedProviders[provider]!;

  let text: string;

  switch (provider) {
    case "anthropic": {
      const client = new Anthropic({ apiKey });
      const res = await client.messages.create({
        model: meta.model,
        max_tokens: 2048,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      text = res.content[0].type === "text" ? res.content[0].text : "";
      break;
    }

    case "openai":
    case "groq":
    case "perplexity": {
      const client = new OpenAI({ apiKey, ...(meta.baseURL ? { baseURL: meta.baseURL } : {}) });
      const res = await client.chat.completions.create({
        model: meta.model,
        max_tokens: 2048,
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user" as const, content: prompt },
        ],
      });
      text = res.choices[0]?.message.content ?? "";
      break;
    }

    case "gemini": {
      const client = new GoogleGenerativeAI(apiKey);
      const model = client.getGenerativeModel({ model: meta.model });
      const full = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
      const res = await model.generateContent(full);
      text = res.response.text();
      break;
    }

    case "mistral": {
      const client = new Mistral({ apiKey });
      const res = await client.chat.complete({
        model: meta.model,
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          { role: "user" as const, content: prompt },
        ],
      });
      const content = res?.choices?.[0]?.message?.content;
      text = typeof content === "string" ? content : "";
      break;
    }
  }

  return { provider, model: meta.model, text: text ?? "" };
}
