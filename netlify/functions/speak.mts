// Cassie's voice: turns her words into soft, warm speech.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, addUsage, overBudget, later } from "../lib/common.mts";

const GOOGLE_VOICES = new Set(["en-GB-Chirp3-HD-Aoede", "en-GB-Chirp3-HD-Kore", "en-GB-Chirp3-HD-Leda", "en-GB-Chirp3-HD-Zephyr", "en-GB-Chirp3-HD-Sulafat", "en-GB-Chirp3-HD-Achernar"]);
const VOICES = new Set(["coral", "shimmer", "sage", "nova", "fable", "alloy", "ballad", "verse", "marin", "cedar"]);
const BASE = "Always a young woman's voice, never male. You are Cassie, a warm, playful young British woman with a smile in your voice, talking to William, a five-year-old boy. British accent. Natural, lively and expressive, like a fun big sister, never flat and never like reading aloud. Clear and a touch slower than adult pace. Stretchy phonics sounds like mmm or sss are held gently. ";
const STYLES: Record<string, string> = {
  front: BASE + "Friendly, relaxed, interested.",
  happy: BASE + "Delighted and giggly, bubbling with warmth, little laughs in the voice.",
  surprise: BASE + "Amazed! Big gasp of excitement, eyes-wide wonder, rising pitch.",
  think: BASE + "Curious and wondering, slower, thoughtful hmm-ing, like puzzling something out together.",
  wink: BASE + "Cheeky and teasing, holding back a giggle, playful comic timing, pause before the punchline.",
  tired: BASE + "Soft, calm and sleepy-cosy, slower, hushed bedtime-story voice.",
  story: BASE + "Storyteller: dramatic and hushed in the suspense, bright in the fun bits, doing little voices for characters.",
  gentle: BASE + "Very gentle and reassuring, slow and kind, like comforting a friend.",
  excited: BASE + "Super excited, fast and bouncy, cheering him on.",
};

export default async (req: Request, ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);

  const body: any = await req.json().catch(() => ({}));
  const t0 = Date.now();
  const text = String(body.text || "").slice(0, 600);
  if (!text) return json({ error: "no-text" }, 400);
  const style = STYLES[String(body.mood || "")] || STYLES.front;

  // Google voices (free allowance of 1 million characters a month)
  if (typeof body.voice === "string" && body.voice.startsWith("g:")) {
    const gname = body.voice.slice(2);
    if (!GOOGLE_VOICES.has(gname)) return json({ error: "bad-voice" }, 400);
    const gkey = Netlify.env.get("GOOGLE_TTS_KEY");
    if (!gkey) return json({ error: "no-google-key" }, 500);
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(gkey)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { text }, voice: { languageCode: "en-GB", name: gname }, audioConfig: { audioEncoding: "MP3", speakingRate: 0.95 } }),
    });
    if (!r.ok) {
      const err = await r.text(); console.log("google speak failed", r.status, err.slice(0, 400));
      return json({ error: r.status === 403 || r.status === 400 ? "bad-google-key" : "speak-failed" }, 502);
    }
    const d: any = await r.json();
    const bytes = Uint8Array.from(atob(d.audioContent || ""), (c) => c.charCodeAt(0));
    console.log("speak timing", JSON.stringify({ voice: gname, chars: text.length, total: Date.now() - t0 }));
    await later(ctx, addUsage(0, text.length / 15)); // inside Google's free monthly allowance
    return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  const voice = VOICES.has(body.voice) ? body.voice : "marin";

  const attempts = [
    { model: "gpt-4o-mini-tts", voice, input: text, instructions: style, response_format: "mp3" },
    { model: "tts-1", voice: ["shimmer", "nova", "fable", "alloy", "coral", "sage"].includes(voice) ? voice : "shimmer", input: text, response_format: "mp3", speed: 0.95 },
  ];
  for (const a of attempts) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(a),
    });
    if (r.ok) {
      console.log("speak timing", JSON.stringify({ model: a.model, voice, chars: text.length, firstByte: Date.now() - t0 }));
      const minutes = text.length / 900;
      await later(ctx, addUsage(a.model === "tts-1" ? text.length * 15 / 1e6 : 0.015 * minutes, minutes * 60));
      return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    const err = await r.text(); console.log("speak failed", a.model, r.status, err.slice(0, 300));
    if (r.status === 401) return json({ error: "bad-key" }, 500);
    if (r.status === 429) return json({ error: "openai-limit" }, 429);
  }
  return json({ error: "speak-failed" }, 502);
};

export const config: Config = { path: "/api/speak", method: "POST" };
