// Parent screen: spending, progress and checks.
import type { Config, Context } from "@netlify/functions";
import { checkCode, json, openaiKey, getUsage, getProfile, resetProfile, monthlyLimitUsd } from "../lib/common.mts";

export default async (req: Request, _ctx: Context) => {
  const bad = checkCode(req); if (bad) return bad;
  if (req.method === "POST") {
    const body: any = await req.json().catch(() => ({}));
    if (body.action === "reset-profile") { await resetProfile(); return json({ ok: true }); }
    return json({ error: "unknown" }, 400);
  }
  const { month, day } = await getUsage();
  return json({ keyReady: !!openaiKey(), month, day, monthlyLimitUsd: monthlyLimitUsd(), profile: await getProfile() });
};

export const config: Config = { path: "/api/status", method: ["GET", "POST"] };
