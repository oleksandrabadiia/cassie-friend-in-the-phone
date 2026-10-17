// Cassie's voice: turns her words into soft, warm speech.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, addUsage, overBudget } from "../lib/common.mts";

const VOICES = new Set(["coral", "shimmer", "sage", "nova", "fable", "alloy", "ballad", "verse", "marin", "cedar"]);
const STYLE = "You are Cassie, a warm, soft, gentle young British woman with a smile in your voice, talking to a five-year-old boy. Speak calmly and clearly, a little slower than normal, playful and kind, never shouty. Stretchy phonics sounds like mmm or sss should be held gently.";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);

  const body: any = await req.json().catch(() => ({}));
  const text = String(body.text || "").slice(0, 600);
  const voice = VOICES.has(body.voice) ? body.voice : "coral";
  if (!text) return json({ error: "no-text" }, 400);

  const attempts = [
    { model: "gpt-4o-mini-tts", voice, input: text, instructions: STYLE, response_format: "mp3" },
    { model: "tts-1", voice: ["shimmer", "nova", "fable", "alloy", "coral", "sage"].includes(voice) ? voice : "shimmer", input: text, response_format: "mp3", speed: 0.95 },
  ];
  for (const a of attempts) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(a),
    });
    if (r.ok) {
      const minutes = text.length / 900;
      await addUsage(a.model === "tts-1" ? text.length * 15 / 1e6 : 0.015 * minutes, minutes * 60);
      return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    const err = await r.text(); console.log("speak failed", a.model, r.status, err.slice(0, 300));
    if (r.status === 401) return json({ error: "bad-key" }, 500);
    if (r.status === 429) return json({ error: "openai-limit" }, 429);
  }
  return json({ error: "speak-failed" }, 502);
};

export const config: Config = { path: "/api/speak", method: "POST" };
