import { NextResponse } from "next/server";
import { GEMINI_VOICES, kokoroVoices } from "@/lib/djvoice.mjs";
import { activeVoice } from "@/lib/settings.mjs";

export const dynamic = "force-dynamic";

// What the voice selector offers, and which one is live. Kokoro's list comes
// from its own server; Gemini's is fixed by the model. They are not
// interchangeable — a Gemini name is not a Kokoro voice — so the UI has to swap
// the whole list when the provider changes.
export async function GET() {
  const current = activeVoice();
  return NextResponse.json({
    current,
    providers: [
      { id: "gemini", label: "Gemini (better prosody, billed per character)", voices: GEMINI_VOICES },
      { id: "kokoro", label: "Kokoro (local, free, fast)", voices: await kokoroVoices() },
    ],
  });
}
