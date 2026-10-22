// Cassie thinks out loud: her words stream back line by line as she writes them, so the phone can start speaking early.
// Body: { text?: string (what William said), start?: boolean, topic?: string, messages, minutesLeft, heardSeconds? }
// Response: newline-separated JSON: {"mood":"…"} first, then {"t":"words…"} … then {"done":true,"say":"…","mood":"…"} (or {"error":"…"}).
import type { Config, Context } from "@netlify/functions";
import { addUsage, checkCode, json, openaiKey, overBudget, later } from "../lib/common.mts";
import { thinkStream, speakerTag, OpenAIError } from "../lib/brain.mts";

export default async (req: Request, ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  const key = openaiKey(); if (!key) return json({ error: "no-key" }, 500);
  if (await overBudget()) return json({ error: "budget" }, 402);
  const body: any = await req.json().catch(() => ({}));
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-30);
  if (typeof body.text === "string") {
    const content = speakerTag(body) + (body.text.trim() || "(William said something but it was too quiet or unclear to hear.)");
    const last = messages[messages.length - 1];
    if (!(last && last.role === "user" && last.content === content)) messages.push({ role: "user", content });   // the phone usually sends it already
  }
  const heardSeconds = Math.min(60, Number(body.heardSeconds) || 0);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const jobs: Promise<unknown>[] = [];
        if (body.timings) console.log("phone timing", JSON.stringify(body.timings));   // the previous turn as the phone saw it
        const t0 = Date.now(), srv: Record<string, number | string> = {};
        if (heardSeconds > 0) jobs.push(addUsage(0.006 * heardSeconds / 60));   // live hearing is billed per minute of audio
        // {end} goes out the moment her spoken words are complete, so the phone can voice the last sentence straight away
        const out = await thinkStream(key, { ...body, messages }, t => { if (srv.firstToken == null) srv.firstToken = Date.now() - t0; send({ t }); }, m => { if (srv.firstToken == null) srv.firstToken = Date.now() - t0; send({ mood: m }); }, say => { srv.textEnd = Date.now() - t0; send({ end: true, say }); }, j => jobs.push(j), m => { srv.model = m; });
        srv.done = Date.now() - t0;
        console.log("talk timing", JSON.stringify(srv));
        send({ done: true, ...out, srv });
        await later(ctx, Promise.all(jobs));
      } catch (e: any) { send({ error: e instanceof OpenAIError ? e.code : "chat-failed" }); }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
};

export const config: Config = { path: "/api/talk", method: "POST" };
