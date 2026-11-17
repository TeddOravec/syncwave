import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// Liveness probe for platform health checks (Render, Docker HEALTHCHECK, uptime
// monitors). Cheap on purpose — it must not touch yt-dlp or the network.
//
// `build` is the identity of this deployment. A tab left open across a deploy
// keeps running the old bundle while the server moves on, and a stale room looks
// completely healthy: the clock is the server's, so the only thing missing is the
// newest client code. The room polls this and reloads itself when it changes.
function buildId() {
  try {
    return readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "";
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "syncwave",
    uptime: process.uptime(),
    build: buildId(),
  });
}
