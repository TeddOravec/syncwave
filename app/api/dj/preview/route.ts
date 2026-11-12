import { NextRequest, NextResponse } from "next/server";
import { getRoom } from "@/lib/rooms.mjs";
import { composeBlurb, djEnabled } from "@/lib/dj.mjs";
import { synthesize, voiceEnabled } from "@/lib/djvoice.mjs";
import { activeVoice } from "@/lib/settings.mjs";

export const dynamic = "force-dynamic";

// Audition endpoint: what the host would say right now, and the audio for it.
// Deliberately side-effect free — nothing is queued and nothing is broadcast, so
// it is safe to call against a live room while judging the writing or a voice.
//
//   ?code=WORK            which room to write a blurb for
//   ?voice=bm_george      override the voice (defaults to the persona's)
//   ?provider=kokoro      override the TTS backend
//   ?text=...             speak this instead of composing (voice auditioning)
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const code = (p.get("code") || "").toUpperCase();
  const room = code ? getRoom(code) : null;

  // A voice can be auditioned without a room at all — pick the voice first,
  // then worry about what it is going to say.
  const override = p.get("text");
  if (!room && !override) {
    return NextResponse.json({ error: "no_room" }, { status: 404 });
  }
  if (!override && !djEnabled()) {
    return NextResponse.json({ error: "dj_disabled" }, { status: 409 });
  }

  const text = override ? override.slice(0, 320) : await composeBlurb(room);
  if (!text) return NextResponse.json({ error: "llm_empty" }, { status: 502 });

  const want = activeVoice();
  const voice = p.get("voice") || want.voice;
  const provider = p.get("provider") || want.provider;

  let audio = null;
  let voiceError = null;
  if (voiceEnabled()) {
    try {
      audio = await synthesize(text, { voice, provider });
    } catch (e) {
      voiceError = String((e as Error)?.message || e).slice(0, 200);
    }
  }

  return NextResponse.json({
    text,
    voice,
    provider,
    every: want.every,
    audioUrl: audio ? `/dj-audio/${audio.hash}.opus` : null,
    bytes: audio ? audio.bytes : null,
    cached: audio ? audio.cached : null,
    voiceError,
  });
}
