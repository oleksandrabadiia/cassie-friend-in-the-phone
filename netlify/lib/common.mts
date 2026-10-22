import { getStore } from "@netlify/blobs";

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Only devices that know the family code can use Cassie (and your OpenAI credit).
export function checkCode(req: Request): Response | null {
  const expected = Netlify.env.get("CASSIE_FAMILY_CODE");
  const got = req.headers.get("x-cassie-code") || "";
  if (!expected) return json({ error: "Family code is not set up on the server yet." }, 500);
  // forgiving: ignore capitals, spaces and any kind of dash or punctuation
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm(got) || norm(got) !== norm(expected)) return json({ error: "wrong-code" }, 401);
  return null;
}

export function openaiKey(): string | null {
  return Netlify.env.get("OPENAI_API_KEY") || null;
}

// ---------- spending guard (rough estimate, the hard cap is your OpenAI monthly limit) ----------
const store = () => getStore({ name: "cassie", consistency: "strong" });
const monthKey = () => "usage-" + new Date().toISOString().slice(0, 7);
const dayKey = () => "day-" + new Date().toISOString().slice(0, 10);

export async function getUsage() {
  const s = store();
  const month = ((await s.get(monthKey(), { type: "json" })) as any) || { usd: 0, turns: 0 };
  const day = ((await s.get(dayKey(), { type: "json" })) as any) || { usd: 0, turns: 0, speechSeconds: 0 };
  return { month, day };
}

// one at a time, so two updates in the same moment don't overwrite each other
let usageChain: Promise<unknown> = Promise.resolve();
export function addUsage(usd: number, speechSeconds = 0): Promise<void> {
  const next = usageChain.then(() => addUsageNow(usd, speechSeconds));
  usageChain = next.catch(() => {});
  return next;
}
async function addUsageNow(usd: number, speechSeconds: number) {
  const s = store();
  const { month, day } = await getUsage();
  month.usd += usd; month.turns += 1;
  day.usd += usd; day.turns += 1; day.speechSeconds += speechSeconds;
  await s.setJSON(monthKey(), month);
  await s.setJSON(dayKey(), day);
}

export function monthlyLimitUsd(): number {
  const v = parseFloat(Netlify.env.get("CASSIE_MONTHLY_LIMIT_USD") || "8");
  return isFinite(v) ? v : 8;
}

// remembered for a minute on a warm server, so most turns skip two storage reads
let budgetCache: { at: number; over: boolean } | null = null;
export async function overBudget(): Promise<boolean> {
  if (budgetCache && Date.now() - budgetCache.at < 60000) return budgetCache.over;
  const { month } = await getUsage();
  budgetCache = { at: Date.now(), over: month.usd >= monthlyLimitUsd() };
  return budgetCache.over;
}
// run bookkeeping after the reply has gone out (falls back to waiting if the platform can't)
export function later(ctx: any, p: Promise<unknown>): Promise<unknown> {
  const safe = p.catch(e => console.log("bookkeeping failed", e));
  if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(safe); return Promise.resolve(); }
  return safe;
}

// ---------- William's learning profile ----------
export type Profile = { practised: Record<string, number>; tricky: Record<string, number>; likes: string[]; memories: string[]; updated?: string };
const emptyProfile = (): Profile => ({ practised: {}, tricky: {}, likes: [], memories: [] });

export async function getProfile(): Promise<Profile> {
  const p = ((await store().get("profile", { type: "json" })) as Profile) || emptyProfile();
  if (!Array.isArray(p.memories)) p.memories = [];
  return p;
}
export async function saveProfile(p: Profile) {
  p.updated = new Date().toISOString();
  await store().setJSON("profile", p);
}
export async function resetProfile() {
  await store().setJSON("profile", emptyProfile());
}

export function profileSummary(p: Profile): string {
  const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
  const parts: string[] = [];
  const pr = top(p.practised), tr = top(p.tricky);
  if (pr.length) parts.push("Sounds/skills William has practised successfully: " + pr.join(", ") + ".");
  if (tr.length) parts.push("Sounds/skills he finds tricky (practise gently, without pressure): " + tr.join(", ") + ".");
  if (p.likes.length) parts.push("Things he has enjoyed: " + p.likes.slice(-10).join(", ") + ".");
  if (p.memories?.length) parts.push("Notes from earlier chats, dated (newest last). Don't repeat these games, jokes, facts or ideas; build on them instead:\n- " + p.memories.slice(-45).join("\n- "));
  return parts.length ? "SAVED LEARNING PROFILE\n" + parts.join("\n") : "SAVED LEARNING PROFILE\nNothing saved yet.";
}
