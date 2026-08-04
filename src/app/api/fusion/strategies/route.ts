import { NextResponse } from "next/server";
import {
  getFusionStrategies,
  saveFusionStrategy,
  deleteFusionStrategy,
} from "@/lib/db/fusionStrategies";

export async function GET() {
  try {
    const strategies = getFusionStrategies(false);
    return NextResponse.json({ success: true, strategies });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.name || !Array.isArray(body.engines) || !body.synthesizer) {
      return NextResponse.json(
        { success: false, error: "Missing required fields (name, engines array, synthesizer)" },
        { status: 400 }
      );
    }

    const saved = saveFusionStrategy({
      id: body.id,
      name: body.name,
      description: body.description,
      engines: body.engines,
      synthesizer: body.synthesizer,
      systemPrompt: body.systemPrompt,
      enabled: body.enabled !== false,
    });

    return NextResponse.json({ success: true, strategy: saved });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id parameter" }, { status: 400 });
    }
    const success = deleteFusionStrategy(id);
    return NextResponse.json({ success });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
