import { NextResponse } from "next/server";

export const runtime = "nodejs";
export async function POST() {
  return NextResponse.json({ error: "twilio_signature_and_twiml_not_implemented" }, { status: 501 });
}
