# Cassie — William's friend in the phone

Cassie is a voice companion app for William (5, UK, Year 1 phonics). It's a plasticine character
his mum Ara designed with him. Live at **https://hello-cassie.netlify.app** (Netlify project `hello-cassie`,
site id `e0bfb4d9-acc8-4546-b923-026ba7047f79`). Deploys automatically from the `main` branch of
GitHub `oleksandrabadiia/cassie-friend-in-the-phone` (push → live in ~1 min).

Ara is not a developer. Explain things for a total beginner, step by step, and never paste secrets into chat.

## How it works

- **Phone app** (`public/`): one page, installable to the Home Screen. Pure HTML/CSS/JS, no build step.
  - `index.html` — layout + styles. Clay look: logo top-left, clay cog top-right (settings), Cassie's face,
    2-line scrolling caption, purple clay talk button, 12 cream clay topic tiles in two rows.
  - `engine.js` — Cassie's face: canvas animation from cut-out layers in `img/` (face, hair strands,
    googly pupils, mouth shapes, 3/4 turn frames, shadow). Exposes `window.CassieFace`
    (`mode`, `mood`, `speaking`, `level`, `giggle`, `jump`, `rollEyes`). No eyelids/blinking (Ara removed them).
  - `app.js` — conversation loop, daily time limit, parent settings, voice list, idle behaviour. Key parts: `Ears`
    (live hearing WebSocket, with preroll buffer and automatic fallback after 2 failures), `startListening` (MediaRecorder
    as backup + VAD, pause `S.pause` = 0.5 s), `talkStream` + `Speaker` (sentence-by-sentence voicing of the streamed
    reply, "Hmm…" filler only if the first sentence takes >350 ms), barge-in interval (William talking over Cassie
    interrupts her; adaptive threshold so her own voice in the mic doesn't trigger it).
  - `pcm-worklet.js` — AudioWorklet that turns the mic into 24 kHz 16-bit 100 ms chunks for live hearing.
  - `img/btn/*.webp` — clay buttons cut from Ara's design sheets. `talk-blank.webp` is the disc without
    the mic, used behind the listening/thinking/speaking icons.
- **Server** (`netlify/functions/`, TypeScript `.mts`): keeps the API keys hidden and enforces limits.
  - `talk.mts` `/api/talk` — **the main one**: streams Cassie's reply as newline JSON (`{mood}`, `{t:"words"}`…, `{done,say,mood}`)
    so the phone can voice the first sentence while the rest is still being written. Body: `{text|start|topic, messages, minutesLeft, heardSeconds}`.
  - `ears.mts` `/api/ears` — mints a 10-minute OpenAI client secret for **live hearing** (the phone streams William's
    voice over a WebSocket to OpenAI's realtime transcription while he talks, so the words are ready when he stops).
    Tries the current `client_secrets` API, then the older `transcription_sessions` one. Model via `CASSIE_LIVE_MODEL`
    (default `gpt-4o-mini-transcribe`, ~$0.003/min of audio).
  - `turn.mts` `/api/turn` — fallback round trip: upload the recording, transcribe, think (used when live hearing is off/fails).
  - `chat.mts` `/api/chat` — think only, non-streaming (legacy). `hear.mts` `/api/hear` — transcribe only (legacy).
  - `speak.mts` `/api/speak` — text to speech (OpenAI `gpt-4o-mini-tts` voices, or Google Chirp 3 HD
    voices when `GOOGLE_TTS_KEY` is set; voice ids starting `g:` are Google).
  - `status.mts` `/api/status` — parent screen data; `POST {action:"reset-profile"}` clears memory.
  - `lib/prompt.mts` — **Cassie's personality and conversation flow** (edit this to change how she behaves).
  - `lib/brain.mts` — transcribe + think, topic-button prompts (`TOPICS`), learning-profile updates.
  - `lib/common.mts` — family-code check, spend tracking (Netlify Blobs store `cassie`), William's profile
    (`practised`, `tricky`, `likes`, `memories`).
- **Models**: hearing `gpt-4o-mini-transcribe` (live over realtime, or file upload) → `whisper-1`; brain `gpt-4o-mini` →
  `gpt-4.1-mini` → `gpt-5-mini` (override with env `CASSIE_MODEL`), streamed; voice `gpt-4o-mini-tts` → `tts-1`.
- **Reply format** (`lib/prompt.mts` `FORMAT_RULES`): line 1 `@mood`, then the spoken words, then `###{json bookkeeping}`.
  `thinkStream` in `brain.mts` parses it as it streams (also tolerates the old all-JSON style).

## Conversation flow (what Ara wants)

1. Greet William and ask how he is / what he did today. Listen first.
2. Then offer learning dressed as play (phonics, counting, quiz, facts, story-making, drawing).
3. Fun/superheroes last, as a treat — superheroes are deliberately de-emphasised.
4. Follow his lead; listen more than talk; short replies; one question at a time.

Speed matters to William: live hearing while he talks, 0.5 s end-of-speech pause, streamed reply voiced sentence by
sentence, a pre-made "Hmm…"/"Ooh!" clip only if the first sentence is slow, and he can talk over her to interrupt.
Parent toggles: "Live hearing" and "William can talk over Cassie" (both on by default). Idle: silly jump/eye-roll at 25 s, a spoken call-out at 50 s (max twice/session),
sleepy at 90 s.

## Secrets & settings (Netlify env vars, Production context)

- `OPENAI_API_KEY` — required. **The one in use was once pasted into chat; Ara should rotate it.**
- `GOOGLE_TTS_KEY` — optional, enables the free Google voices.
- `CASSIE_FAMILY_CODE` — `pebble-moon-35` (checked ignoring case/spaces/dashes). Typed once per device.
- `CASSIE_MONTHLY_LIMIT_USD` — soft cap, default 8. The hard cap is the OpenAI monthly budget.
- `CASSIE_MODEL` — optional brain override.
Changing an env var needs a redeploy (push an empty commit, or Netlify → Deploys → Trigger deploy).

## Parent settings (in the app)

Tap the clay cog 3 times quickly → answer a sum. Daily minutes (per device, default 20), +10 minutes,
keep-listening toggle, show-words toggle (off hides the caption and Cassie grows), voice list with ▶
previews, month spend estimate, William's practised/tricky/likes + memories, clear progress, change code.

## Working on it

- Edit files in `public/` or `netlify/`; `node --check public/app.js`; bundle-check functions with
  `npx -y esbuild@0.24.0 netlify/functions/<f>.mts --bundle --platform=node --format=esm --external:@netlify/* --outfile=/tmp/x.mjs`.
- Preview locally: `python3 -m http.server 8770 --directory public` + Playwright (iPhone 14 Pro device)
  with `localStorage.cassie.code` set; API routes must be mocked locally (no keys here).
- Bump `?v=N` on `app.js`/`engine.js` script tags in `index.html` when they change (cache busting).
- Commit and push to `main`; Netlify builds it. Then tell Ara to close and reopen Cassie.
- Keep everything child-safe, keep keys server-side, and keep the clay look consistent
  (cut-outs with soft, light shadows; no drawn/vector UI).

## Things Ara has asked for / decided

- Face: use the "listening" sheet as the single head; expressions via pupils + mouth only; no eyelids.
- Voices: soft female; Marin/Shimmer/Sage closest to ChatGPT's Sol (Sol itself is not available via API).
- Cheapest viable setup; GPT-Live rejected as too expensive (~£12–25/mo).
- Topic tiles: maths, phonics, world, animals, quiz, draw, space, dinos, cars, story, heroes, surprise.
- Button press feedback: violet contour glow.
