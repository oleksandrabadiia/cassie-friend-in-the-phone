// Cassie's ears: turns William's recording into text.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, addUsage, overBudget } from "../lib/common.mts";

const HINT = "A five-year-old British boy called William talking to Cassie, his friend in the phone. Spider-Man, Batman, Superman, superheroes, phonics sounds like sss, mmm, ch, sh, th.";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);

  const form = await req.formData();
  const audio = form.get("audio") as File | null;
  const seconds = Math.min(60, parseFloat(String(form.get("seconds") || "5")) || 5);
  if (!audio || audio.size < 800) return json({ text: "" });

  for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
    const fd = new FormData();
    fd.append("file", audio, audio.name || "speech.m4a");
    fd.append("model", model);
    fd.append("language", "en");
    fd.append("prompt", HINT);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    if (r.ok) {
      const d: any = await r.json();
      await addUsage((model === "whisper-1" ? 0.006 : 0.003) * seconds / 60);
      return json({ text: (d.text || "").trim() });
    }
    const err = await r.text();
    console.log("transcribe failed", model, r.status, err.slice(0, 300));
    if (r.status === 401) return json({ error: "bad-key" }, 500);
    if (r.status === 429) return json({ error: "openai-limit" }, 429);
  }
  return json({ error: "hear-failed" }, 502);
};

export const config: Config = { path: "/api/hear", method: "POST" };
