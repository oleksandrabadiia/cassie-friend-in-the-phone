// Cassie's ears and brain, shared by /api/hear, /api/chat and the faster /api/turn.
import { addUsage, getProfile, saveProfile, profileSummary } from "./common.mts";
import { CASSIE_PROMPT, FORMAT_RULES } from "./prompt.mts";

const HINT = "A five-year-old British boy, William, chatting to Cassie, his friend in the phone. Young child's speech: short, sometimes unclear or mispronounced, with ums and restarts. Write exactly what he says in British English. Names he uses: Cassie, Mummy, Daddy, Luka, Loly and Pop (guinea pigs), Harry Potter, Hogwarts. He may say single phonics sounds like sss, mmm, ch, sh, th, or words like dinosaur, LEGO, swimming. Sometimes a grown-up: 'it's Mummy here', 'Daddy speaking', 'back to William'.";
// "(Mummy speaking) " etc. — William is assumed unless a grown-up says who they are or taps the grown-up button
export function speakerTag(b: any): string {
  if (!b?.parent) return "";
  const who = b.speaker === "Mummy" || b.speaker === "Daddy" ? b.speaker : "A grown-up";
  return `(${who} speaking) `;
}
export class OpenAIError extends Error { constructor(public code: string, public status: number) { super(code); } }

export async function transcribe(key: string, audio: File, seconds: number): Promise<string> {
  if (!audio || audio.size < 800) return "";
  for (const model of [Netlify.env.get("CASSIE_HEAR_MODEL") || "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]) {
    const fd = new FormData();
    fd.append("file", audio, audio.name || "speech.m4a");
    fd.append("model", model); fd.append("language", "en"); fd.append("prompt", HINT);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
    if (r.ok) { const d: any = await r.json(); await addUsage((model.includes("mini") ? 0.003 : 0.006) * seconds / 60); return (d.text || "").trim(); }
    const err = await r.text(); console.log("transcribe failed", model, r.status, err.slice(0, 300));
    if (r.status === 401) throw new OpenAIError("bad-key", 500);
    if (r.status === 429) throw new OpenAIError("openai-limit", 429);
  }
  throw new OpenAIError("hear-failed", 502);
}

const MOODS = new Set(["happy", "front", "think", "surprise", "wink", "tired", "story", "gentle", "excited"]);
const PRICE: Record<string, [number, number]> = { "gpt-4.1-mini": [0.4, 1.6], "gpt-4o-mini": [0.15, 0.6], "gpt-5-mini": [0.25, 2] };

const TOPICS: Record<string, string> = {
  maths: "William just tapped the MATHS button. Start a fun little counting or simple maths game right now and keep it going for several rounds (counting objects, one more/one less, simple adding with superheroes, dinosaurs or sweets). One question at a time.",
  phonics: "William just tapped the PHONICS button. Start a short, funny phonics mission now with a character you have not used recently (dinosaur, Loly and Pop, a Hogwarts owl, a pirate, a robot, a pumpkin… never superheroes), using his Phase 3 sounds and the saved profile. One sound at a time.",
  world: "William just tapped the WORLD button. Share one amazing, simple fact about the world (countries, oceans, weather, volcanoes, people) and ask him a playful question about it.",
  animals: "William just tapped the ANIMALS button. Play an animal game: a 'which animal am I?' riddle, animal sounds, or an amazing animal fact. Keep it short.",
  quiz: "William just tapped the QUIZ button. Run a quick, easy quiz for a five-year-old: about five questions, one at a time, reacting to each answer before asking the next.",
  draw: "William just tapped the DRAW button. Suggest one specific, unexpected drawing or craft idea from your drawing list that you have not suggested before (check the notes), explain the first tiny step, then ask him to describe it as he goes.",
  space: "William just tapped the SPACE button. Start a space adventure or share a simple space fact (planets, the Moon, rockets, astronauts) and ask one question.",
  dinos: "William just tapped the DINOSAURS button. Start a dinosaur game or adventure: roaring contest, 'guess the dinosaur', or a fact about T. rex, Triceratops or Stegosaurus. One thing at a time.",
  cars: "William just tapped the CARS button. Talk cars, racing cars, diggers, trains or monster trucks: a tiny race story or a 'what sound does it make' game.",
  story: "William just tapped the STORY button. Begin a short, silly made-up story and stop after two or three sentences to ask William what happens next. Use characters from your notes if you have any.",
  heroes: "William just tapped the SUPERHEROES button. Start a short superhero mission with Spider-Man, Batman, Superman or a hero he invents, and weave a little counting or a phonics sound into it.",
  surprise: "William just tapped the SURPRISE button. Pick something unexpected from his interests (never superheroes) that you haven't done recently, preferably a learning game dressed up as fun, and jump straight in.",
};
const ACTIVITY_NAMES: Record<string, string> = { maths: "maths game", phonics: "phonics mission", world: "world facts chat", animals: "animal game", quiz: "quiz", draw: "drawing activity", space: "space adventure", dinos: "dinosaur game", cars: "cars game", story: "story you are making up together", heroes: "superhero mission", surprise: "game" };
// What's coming up, so Cassie can talk about Halloween, birthdays and Christmas at the right time.
function upcoming(): string {
  const uk = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
  const y = uk.getFullYear();
  const days = (m: number, d: number) => { let t = new Date(y, m - 1, d); if (t < uk) t = new Date(y + 1, m - 1, d); return Math.round((t.getTime() - uk.getTime()) / 864e5); };
  const list: [string, number][] = [["Halloween", days(10, 31)], ["Bonfire Night (fireworks)", days(11, 5)], ["Daddy's birthday (James, 10 December) — help William plan and make a birthday card for Daddy", days(12, 10)], ["William's birthday (he turns " + (y - 2020 + (uk.getMonth() === 11 && uk.getDate() > 20 ? 1 : 0)) + ")", days(12, 20)], ["Christmas Day", days(12, 25)], ["New Year's Day", days(1, 1)], ["Valentine's Day", days(2, 14)], ["Pancake Day-ish / spring", days(3, 1)], ["Easter-time (spring)", days(4, 5)]];
  const soon = list.filter(([, d]) => d <= 45).sort((a, b) => a[1] - b[1]);
  if (!soon.length) return "";
  return "Coming up: " + soon.map(([n, d]) => `${n} in ${d === 0 ? "0 days (TODAY!)" : d + " days"}`).join("; ") + ". Mention these naturally now and then, not every reply.";
}

// "Thursday evening, 22 October, 7:33 pm (a school day)" — spelled out so Cassie never has to work it out from numbers.
function whenIsIt(): string {
  const uk = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
  const h = uk.getHours(), wd = uk.getDay();
  const part = h < 5 ? "the middle of the night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 19 ? "early evening" : h < 21 ? "evening" : "late evening";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const school = (d: number) => d >= 1 && d <= 5;
  const clock = uk.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
  const date = uk.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const tmrw = days[(wd + 1) % 7];
  return `RIGHT NOW it is ${days[wd]} ${part}, ${date}, ${clock} UK time. Today is ${school(wd) ? "a school day" : "the weekend"}; tomorrow is ${tmrw}, ${school((wd + 1) % 7) ? "a school day" : "not a school day"}${wd === 0 && h < 12 ? "; his swimming lesson is this morning at 11:30" : wd === 0 && h >= 12 ? "; he had swimming this morning" : wd === 6 ? "; swimming is tomorrow at 11:30" : ""}. (School holidays may differ; if he says there's no school, believe him.) Use this: say good morning / good evening properly, know whether school happened today, and after 7:30pm steer gently towards bed.`;
}

export async function think(key: string, body: any): Promise<{ say: string; mood: string }> {
  return thinkStream(key, body, () => {});
}

// Streams Cassie's words as they are written (onText gets each new bit), then returns the whole reply + mood.
export async function thinkStream(key: string, body: any, onText: (t: string) => void, onMood: (m: string) => void = () => {}, onEnd: (say: string) => void = () => {}, defer?: (p: Promise<unknown>) => void, onModel: (m: string) => void = () => {}): Promise<{ say: string; mood: string }> {
  const history = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const minutesLeft = typeof body.minutesLeft === "number" ? body.minutesLeft : 20;
  const profile = await getProfile();

  const situation = [
    whenIsIt(),
    upcoming(),
    body.start && body.resume && history.length ? "William has come back to the app after a little break. The conversation above is from earlier today. Welcome him back warmly in a fresh way and offer to carry on with what you were doing (say what it was), or do something new. One question only." : "",
    body.start && !(body.resume && history.length) ? (body.parent ? "A grown-up has just opened the app in Parent Mode. Greet them warmly and briefly." : "William has just opened the app. Greet him warmly and ask how he is or what he has been doing today. One question only.") : "",
    !body.topic && body.activity && ACTIVITY_NAMES[body.activity] && !body.parent ? `You are in the middle of the ${ACTIVITY_NAMES[body.activity]} William picked a moment ago (see the conversation). KEEP IT GOING: react to what he just said, then give the next question, clue, step or part of the story, one at a time. Don't wrap it up after one go, and don't drift back to 'how was your day' chat. Your dated notes are from EARLIER days: a note saying you played this game before does not mean this game is over. Only stop if he says he wants to do something else, changes the subject, or seems bored; then follow him.` : "",
    body.topic ? TOPICS[body.topic] || "" : "",
    body.parent ? `PARENT MODE IS ON: ${body.speaker === "Mummy" ? "William's mum Ara" : body.speaker === "Daddy" ? "William's dad James" : "a grown-up (William's mum Ara or dad James; you don't know which yet, so don't guess — if it matters, ask)"} is speaking to you now, not William. Talk to them as an adult, warmly, following the PARENT MODE rules. Messages marked (Mummy speaking), (Daddy speaking) or (A grown-up speaking) are theirs.` : "WHO IS TALKING: William. Only the phone can switch to a grown-up, and it marks those messages (Mummy speaking) etc. There is no such mark now, so it is William even if the words mention Mummy or Daddy ('it's Mummy's birthday', 'Daddy's here' just means Daddy came in). Never switch to talking to a grown-up on your own. Other voices in the room may get mixed in; if a message makes no sense coming from William, gently ask him what he meant.",
    minutesLeft <= 2 ? `Only about ${Math.max(0, Math.round(minutesLeft))} minute(s) of Cassie time are left today. Start wrapping up kindly: suggest a break, playing, drawing or time with family, and say goodbye warmly.` : "",
  ].filter(Boolean).join(" ");

  const messages = [
    { role: "system", content: CASSIE_PROMPT },
    { role: "system", content: profileSummary(profile) },
    { role: "system", content: situation + "\n\n" + FORMAT_RULES },
    ...history.map((m: any) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 1500) })),
  ];
  if (body.start) messages.push({ role: "user", content: body.parent ? "(A grown-up opens the app.)" : history.length ? "(William opens the app again.)" : "(William opens the app and looks at you.)" });

  const models = [Netlify.env.get("CASSIE_MODEL"), "gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini"].filter(Boolean) as string[];
  for (const model of models) {
    const payload: any = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (!model.startsWith("gpt-5")) { payload.temperature = 0.9; payload.max_tokens = 260; } else { payload.max_completion_tokens = 900; payload.reasoning_effort = "minimal"; }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    onModel(model);
    if (!r.ok || !r.body) {
      const err = await r.text(); console.log("chat failed", model, r.status, err.slice(0, 300));
      if (r.status === 401) throw new OpenAIError("bad-key", 500);
      if (r.status === 429) throw new OpenAIError("openai-limit", 429);
      continue;
    }
    // read the SSE stream; everything before "###" is spoken, the JSON after it is bookkeeping
    let full = "", sent = 0, usage: any = null, pending = "", headMood = "", head = 0, ended = false;
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
      if (cut >= 0 && !ended) { ended = true; onEnd(speakable.replace(/[*_#`]/g, "").trim()); }
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
    const run = (j: Promise<unknown>) => defer ? defer(j) : j;
    await run(addUsage(((usage?.prompt_tokens || 0) * p[0] + (usage?.completion_tokens || 0) * p[1]) / 1e6));
    flush();
    full = full.slice(Math.max(0, head));
    const cut = full.indexOf("###");
    let out: any = {};
    if (cut >= 0) { try { out = JSON.parse(full.slice(cut + 3).trim()); } catch { out = {}; } }
    else { try { const j = JSON.parse(full); if (j && typeof j.say === "string") { out = j; full = j.say; sent = 0; } } catch {} }   // in case it answered in the old JSON style
    const say = (cut >= 0 ? full.slice(0, cut) : full).replace(/[*_#`]/g, "").trim() || "Ooh, say that again for me?";
    if (sent < say.length) onText(say.slice(sent));
    const mood = MOODS.has(headMood) ? headMood : MOODS.has(out.mood) ? out.mood : "front";
    // remember learning progress (after the reply has gone out when possible)
    const keep = async () => { try {
      const norm = (a: any) => (Array.isArray(a) ? a : []).map((x: any) => String(x).toLowerCase().trim()).filter((x: string) => x && x.length < 40).slice(0, 6);
      const pr = norm(out.practised), tr = norm(out.tricky), lk = norm(out.likes);
      const mem = (Array.isArray(out.remember) ? out.remember : []).map((x: any) => String(x).trim()).filter((x: string) => x && x.length < 160).slice(0, 2);
      if (mem.length) {
        const stamp = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
        for (const m of mem) if (!profile.memories.some(x => x.endsWith(m))) profile.memories.push(`${stamp}: ${m}`);
        profile.memories = profile.memories.slice(-120);
      }
      if (pr.length || tr.length || lk.length || mem.length) {
        for (const s of pr) profile.practised[s] = (profile.practised[s] || 0) + 1;
        for (const s of tr) profile.tricky[s] = (profile.tricky[s] || 0) + 1;
        for (const s of lk) if (!profile.likes.includes(s)) profile.likes.push(s);
        profile.likes = profile.likes.slice(-30);
        await saveProfile(profile);
      }
    } catch (e) { console.log("profile save failed", e); } };
    await run(keep());
    return { say, mood };
  }
  throw new OpenAIError("chat-failed", 502);
}

// Live ears: a short-lived key so the phone can stream William's voice straight to OpenAI while he talks.
export async function liveEarsToken(key: string): Promise<{ token: string; api: "ga" | "beta"; model: string; expires: number }> {
  const model = Netlify.env.get("CASSIE_LIVE_MODEL") || "gpt-4o-transcribe";   // the full model hears young children much better than the mini one
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
