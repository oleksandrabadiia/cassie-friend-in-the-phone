// Gives the phone a short-lived key for live hearing (streams William's voice to OpenAI as he speaks).
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, overBudget } from "../lib/common.mts";
import { liveEarsToken, OpenAIError } from "../lib/brain.mts";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);
  try { return json(await liveEarsToken(key)); }
  catch (e: any) { return json({ error: e instanceof OpenAIError ? e.code : "no-live" }, e?.status || 503); }
};

export const config: Config = { path: "/api/ears", method: "POST" };
