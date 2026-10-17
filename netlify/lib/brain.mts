// Cassie's ears and brain, shared by /api/hear, /api/chat and the faster /api/turn.
import { addUsage, getProfile, saveProfile, profileSummary } from "./common.mts";
import { CASSIE_PROMPT, FORMAT_RULES } from "./prompt.mts";

const HINT = "A five-year-old British boy called William talking to Cassie, his friend in the phone. Spider-Man, Batman, Superman, superheroes, phonics sounds like sss, mmm, ch, sh, th.";
export class OpenAIError extends Error { constructor(public code: string, public status: number) { super(code); } }

export async function transcribe(key: string, audio: File, seconds: number): Promise<string> {
  if (!audio || audio.size < 800) return "";
  for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
    const fd = new FormData();
    fd.append("file", audio, audio.name || "speech.m4a");
    fd.append("model", model); fd.append("language", "en"); fd.append("prompt", HINT);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
    if (r.ok) { const d: any = await r.json(); await addUsage((model === "whisper-1" ? 0.006 : 0.003) * seconds / 60); return (d.text || "").trim(); }
    const err = await r.text(); console.log("transcribe failed", model, r.status, err.slice(0, 300));
    if (r.status === 401) throw new OpenAIError("bad-key", 500);
    if (r.status === 429) throw new OpenAIError("openai-limit", 429);
  }
  throw new OpenAIError("hear-failed", 502);
}

const MOODS = new Set(["happy", "front", "think", "surprise", "wink", "tired"]);
const PRICE: Record<string, [number, number]> = { "gpt-4.1-mini": [0.4, 1.6], "gpt-4o-mini": [0.15, 0.6], "gpt-5-mini": [0.25, 2] };

export async function think(key: string, body: any): Promise<{ say: string; mood: string }> {
  const history = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
  const minutesLeft = typeof body.minutesLeft === "number" ? body.minutesLeft : 20;
  const profile = await getProfile();

  const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", hour: "2-digit", minute: "2-digit" });
  const situation = [
    `It is ${now} (UK time).`,
    body.start ? "William has just opened the app. Greet him." : "",
    minutesLeft <= 2 ? `Only about ${Math.max(0, Math.round(minutesLeft))} minute(s) of Cassie time are left today. Start wrapping up kindly: suggest a break, playing, drawing or time with family, and say goodbye warmly.` : "",
  ].filter(Boolean).join(" ");

  const messages = [
    { role: "system", content: CASSIE_PROMPT },
    { role: "system", content: profileSummary(profile) },
    { role: "system", content: situation + "\n\n" + FORMAT_RULES },
    ...history.map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 1500) })),
  ];
  if (body.start && !history.length) messages.push({ role: "user", content: "(William opens the app and looks at you.)" });

  const models = [Netlify.env.get("CASSIE_MODEL"), "gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"].filter(Boolean) as string[];
  for (const model of models) {
    const payload: any = { model, messages, response_format: { type: "json_object" } };
    if (!model.startsWith("gpt-5")) { payload.temperature = 0.8; payload.max_tokens = 300; } else { payload.max_completion_tokens = 900; payload.reasoning_effort = "minimal"; }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.text(); console.log("chat failed", model, r.status, err.slice(0, 300));
      if (r.status === 401) throw new OpenAIError("bad-key", 500);
      if (r.status === 429) throw new OpenAIError("openai-limit", 429);
      continue;
    }
    const d: any = await r.json();
    const p = PRICE[model] || [0.4, 1.6];
    await addUsage(((d.usage?.prompt_tokens || 0) * p[0] + (d.usage?.completion_tokens || 0) * p[1]) / 1e6);
    let out: any = {};
    try { out = JSON.parse(d.choices?.[0]?.message?.content || "{}"); } catch { out = { say: d.choices?.[0]?.message?.content || "" }; }
    const say = String(out.say || "").replace(/[*_#`]/g, "").trim() || "Ooh, say that again for me?";
    const mood = MOODS.has(out.mood) ? out.mood : "front";
    // remember learning progress
    try {
      const norm = (a: any) => (Array.isArray(a) ? a : []).map((x: any) => String(x).toLowerCase().trim()).filter((x: string) => x && x.length < 40).slice(0, 6);
      const pr = norm(out.practised), tr = norm(out.tricky), lk = norm(out.likes);
      if (pr.length || tr.length || lk.length) {
        for (const s of pr) profile.practised[s] = (profile.practised[s] || 0) + 1;
        for (const s of tr) profile.tricky[s] = (profile.tricky[s] || 0) + 1;
        for (const s of lk) if (!profile.likes.includes(s)) profile.likes.push(s);
        profile.likes = profile.likes.slice(-30);
        await saveProfile(profile);
      }
    } catch (e) { console.log("profile save failed", e); }
    return { say, mood };
  }
  throw new OpenAIError("chat-failed", 502);
}
