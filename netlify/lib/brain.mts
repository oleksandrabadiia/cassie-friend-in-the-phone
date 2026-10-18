// Cassie's ears and brain, shared by /api/hear, /api/chat and the faster /api/turn.
import { addUsage, getProfile, saveProfile, profileSummary } from "./common.mts";
import { CASSIE_PROMPT, FORMAT_RULES } from "./prompt.mts";

const HINT = "A five-year-old British boy called William talking to Cassie, his friend in the phone. Sometimes his mum Ara or dad James: 'Cassie, it's Mummy here', 'Daddy speaking', 'it's Ara', 'back to William'. Luka, Loly and Pop, dinosaurs, Spider-Man, phonics sounds like sss, mmm, ch, sh, th.";
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

const MOODS = new Set(["happy", "front", "think", "surprise", "wink", "tired", "story", "gentle", "excited"]);
const PRICE: Record<string, [number, number]> = { "gpt-4.1-mini": [0.4, 1.6], "gpt-4o-mini": [0.15, 0.6], "gpt-5-mini": [0.25, 2] };

const TOPICS: Record<string, string> = {
  maths: "William just tapped the MATHS button. Start a fun little counting or simple maths game right now (counting objects, one more/one less, simple adding with superheroes, dinosaurs or sweets). One question at a time.",
  phonics: "William just tapped the PHONICS button. Start a short superhero or dinosaur phonics mission now, using his Phase 3 sounds and the saved profile. One sound at a time.",
  world: "William just tapped the WORLD button. Share one amazing, simple fact about the world (countries, oceans, weather, volcanoes, people) and ask him a playful question about it.",
  animals: "William just tapped the ANIMALS button. Play an animal game: a 'which animal am I?' riddle, animal sounds, or an amazing animal fact. Keep it short.",
  quiz: "William just tapped the QUIZ button. Run a quick, easy quiz for a five-year-old, one question at a time, celebrating effort.",
  draw: "William just tapped the DRAW button. Suggest something fun and specific for him to draw (a silly monster, a dinosaur in a rocket, his own superhero), then ask him to describe it to you as he draws.",
  space: "William just tapped the SPACE button. Start a space adventure or share a simple space fact (planets, the Moon, rockets, astronauts) and ask one question.",
  dinos: "William just tapped the DINOSAURS button. Start a dinosaur game or adventure: roaring contest, 'guess the dinosaur', or a fact about T. rex, Triceratops or Stegosaurus. One thing at a time.",
  cars: "William just tapped the CARS button. Talk cars, racing cars, diggers, trains or monster trucks: a tiny race story or a 'what sound does it make' game.",
  story: "William just tapped the STORY button. Begin a short, silly made-up story and stop after two or three sentences to ask William what happens next. Use characters from your notes if you have any.",
  heroes: "William just tapped the SUPERHEROES button. Start a short superhero mission with Spider-Man, Batman, Superman or a hero he invents, and weave a little counting or a phonics sound into it.",
  surprise: "William just tapped the SURPRISE button. Pick something unexpected from his interests that you haven't done recently, preferably a learning game dressed up as fun, and jump straight in.",
};
export async function think(key: string, body: any): Promise<{ say: string; mood: string }> {
  return thinkStream(key, body, () => {});
}

// Streams Cassie's words as they are written (onText gets each new bit), then returns the whole reply + mood.
export async function thinkStream(key: string, body: any, onText: (t: string) => void, onMood: (m: string) => void = () => {}): Promise<{ say: string; mood: string }> {
  const history = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
  const minutesLeft = typeof body.minutesLeft === "number" ? body.minutesLeft : 20;
  const profile = await getProfile();

  const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const situation = [
    `It is ${now} (UK time).`,
    body.start ? "William has just opened the app. Greet him warmly and ask how he is or what he has been doing today. One question only." : "",
    body.topic ? TOPICS[body.topic] || "" : "",
    body.parent ? "PARENT MODE IS ON: a grown-up (William's mum Ara or dad James) is speaking to you now, not William. Talk to them as an adult, warmly, following the PARENT MODE rules. Messages marked (Grown-up speaking) are theirs." : "",
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
    const payload: any = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (!model.startsWith("gpt-5")) { payload.temperature = 0.9; payload.max_tokens = 260; } else { payload.max_completion_tokens = 900; payload.reasoning_effort = "minimal"; }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!r.ok || !r.body) {
      const err = await r.text(); console.log("chat failed", model, r.status, err.slice(0, 300));
      if (r.status === 401) throw new OpenAIError("bad-key", 500);
      if (r.status === 429) throw new OpenAIError("openai-limit", 429);
      continue;
    }
    // read the SSE stream; everything before "###" is spoken, the JSON after it is bookkeeping
    let full = "", sent = 0, usage: any = null, pending = "", headMood = "", head = 0;
    const reader = r.body.getReader(), dec = new TextDecoder();
    const flush = () => {
      if (!head) { // the first line may be "@mood"
        if (full.startsWith("@")) { const nl = full.indexOf("\n"); if (nl < 0) return; headMood = full.slice(1, nl).trim().toLowerCase(); head = nl + 1; }
        else if (full.trim().length) head = -1; else return;
        onMood(MOODS.has(headMood) ? headMood : "front");
      }
      const body = full.slice(Math.max(0, head));
      if (body.trimStart().startsWith("{")) return;   // old JSON style: wait for the end
      const cut = body.indexOf("###");
      let speakable = cut >= 0 ? body.slice(0, cut).replace(/\s+$/, "") : body;
      if (cut < 0) { // hold back a possible half-written "###" or trailing newline
        const m = speakable.match(/\n?#{0,2}$/); if (m && m[0]) speakable = speakable.slice(0, -m[0].length);
      }
      if (speakable.length > sent) { onText(speakable.slice(sent)); sent = speakable.length; }
    };
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      pending += dec.decode(value, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
        try { const j: any = JSON.parse(data); if (j.usage) usage = j.usage; const d = j.choices?.[0]?.delta?.content; if (d) { full += d; flush(); } } catch {}
      }
    }
    const p = PRICE[model] || [0.4, 1.6];
    await addUsage(((usage?.prompt_tokens || 0) * p[0] + (usage?.completion_tokens || 0) * p[1]) / 1e6);
    flush();
    full = full.slice(Math.max(0, head));
    const cut = full.indexOf("###");
    let out: any = {};
    if (cut >= 0) { try { out = JSON.parse(full.slice(cut + 3).trim()); } catch { out = {}; } }
    else { try { const j = JSON.parse(full); if (j && typeof j.say === "string") { out = j; full = j.say; sent = 0; } } catch {} }   // in case it answered in the old JSON style
    const say = (cut >= 0 ? full.slice(0, cut) : full).replace(/[*_#`]/g, "").trim() || "Ooh, say that again for me?";
    if (sent < say.length) onText(say.slice(sent));
    const mood = MOODS.has(headMood) ? headMood : MOODS.has(out.mood) ? out.mood : "front";
    // remember learning progress
    try {
      const norm = (a: any) => (Array.isArray(a) ? a : []).map((x: any) => String(x).toLowerCase().trim()).filter((x: string) => x && x.length < 40).slice(0, 6);
      const pr = norm(out.practised), tr = norm(out.tricky), lk = norm(out.likes);
      const mem = (Array.isArray(out.remember) ? out.remember : []).map((x: any) => String(x).trim()).filter((x: string) => x && x.length < 160).slice(0, 2);
      if (mem.length) { for (const m of mem) if (!profile.memories.includes(m)) profile.memories.push(m); profile.memories = profile.memories.slice(-60); }
      if (pr.length || tr.length || lk.length || mem.length) {
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

// Live ears: a short-lived key so the phone can stream William's voice straight to OpenAI while he talks.
export async function liveEarsToken(key: string): Promise<{ token: string; api: "ga" | "beta"; model: string; expires: number }> {
  const model = Netlify.env.get("CASSIE_LIVE_MODEL") || "gpt-4o-mini-transcribe";
  const H = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  // current API
  let r = await fetch("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: H, body: JSON.stringify({
    expires_after: { anchor: "created_at", seconds: 600 },
    session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model, language: "en", prompt: HINT }, turn_detection: null, noise_reduction: { type: "near_field" } } } },
  }) });
  if (r.ok) { const d: any = await r.json(); return { token: d.value || d.client_secret?.value, api: "ga", model, expires: d.expires_at || 0 }; }
  const e1 = await r.text(); console.log("client_secrets failed", r.status, e1.slice(0, 300));
  if (r.status === 401) throw new OpenAIError("bad-key", 500);
  // older API
  r = await fetch("https://api.openai.com/v1/realtime/transcription_sessions", { method: "POST", headers: { ...H, "OpenAI-Beta": "realtime=v1" }, body: JSON.stringify({
    input_audio_format: "pcm16", input_audio_transcription: { model, language: "en", prompt: HINT }, turn_detection: null, input_audio_noise_reduction: { type: "near_field" },
  }) });
  if (r.ok) { const d: any = await r.json(); return { token: d.client_secret?.value, api: "beta", model, expires: d.client_secret?.expires_at || 0 }; }
  const e2 = await r.text(); console.log("transcription_sessions failed", r.status, e2.slice(0, 300));
  throw new OpenAIError("no-live", 503);
}
