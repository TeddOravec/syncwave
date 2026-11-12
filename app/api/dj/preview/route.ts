import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms.mjs";
import { composeBlurb, djEnabled } from "@/lib/dj.mjs";
import { synthesize, voiceEnabled } from "@/lib/djvoice.mjs";

export const dynamic = "force-dynamic";

// Audition endpoint: what the host would say right now, and the audio for it.
// Deliberately side-effect free — nothing is queued and nothing is broadcast, so
// it is safe to call against a live room while judging the writing.
export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get("code") || "").toUpperCase();
  const room = getRoom(code);
  if (!room) return NextResponse.json({ error: "no_room" }, { status: 404 });
  if (!djEnabled()) return NextResponse.json({ error: "dj_disabled" }, { status: 409 });

  const text = await composeBlurb(room);
  if (!text) return NextResponse.json({ error: "llm_empty" }, { status: 502 });

  let audio = null;
  let voiceError = null;
  if (voiceEnabled()) {
    try {
      audio = await synthesize(text);
    } catch (e) {
      voiceError = String((e as Error)?.message || e).slice(0, 200);
    }
  }

  return NextResponse.json({
    text,
    audioUrl: audio ? `/dj-audio/${audio.hash}.opus` : null,
    bytes: audio ? audio.bytes : null,
    cached: audio ? audio.cached : null,
    voiceError,
  });
}
