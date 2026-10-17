// Cassie's ears: turns William's recording into text.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, overBudget } from "../lib/common.mts";
import { transcribe, OpenAIError } from "../lib/brain.mts";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);
  const form = await req.formData();
  const seconds = Math.min(60, parseFloat(String(form.get("seconds") || "5")) || 5);
  try { return json({ text: await transcribe(key, form.get("audio") as File, seconds) }); }
  catch (e: any) { return json({ error: e instanceof OpenAIError ? e.code : "hear-failed" }, e?.status || 502); }
};

export const config: Config = { path: "/api/hear", method: "POST" };
