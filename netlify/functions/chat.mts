// Cassie's brain: decides what she says, using her personality prompt.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, overBudget } from "../lib/common.mts";
import { think, OpenAIError } from "../lib/brain.mts";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);
  const body: any = await req.json().catch(() => ({}));
  try { return json(await think(key, body)); }
  catch (e: any) { return json({ error: e instanceof OpenAIError ? e.code : "chat-failed" }, e?.status || 502); }
};

export const config: Config = { path: "/api/chat", method: "POST" };
