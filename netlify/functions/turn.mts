// One round trip: hear William, then decide what Cassie says (faster than two separate calls).
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, overBudget } from "../lib/common.mts";
import { transcribe, think, OpenAIError } from "../lib/brain.mts";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);
  const form = await req.formData();
  const seconds = Math.min(60, parseFloat(String(form.get("seconds") || "5")) || 5);
  let meta: any = {}; try { meta = JSON.parse(String(form.get("meta") || "{}")); } catch {}
  try {
    const heard = await transcribe(key, form.get("audio") as File, seconds);
    const messages = (Array.isArray(meta.messages) ? meta.messages : []).slice(-15);
    messages.push({ role: "user", content: (meta.parent ? "(Grown-up speaking) " : "") + (heard || "(William said something but it was too quiet or unclear to hear.)") });
    const reply = await think(key, { messages, minutesLeft: meta.minutesLeft, parent: !!meta.parent });
    return json({ heard, ...reply });
  } catch (e: any) { return json({ error: e instanceof OpenAIError ? e.code : "turn-failed" }, e?.status || 502); }
};

export const config: Config = { path: "/api/turn", method: "POST" };
