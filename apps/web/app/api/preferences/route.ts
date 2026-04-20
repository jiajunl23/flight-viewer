import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase-server";

const prefsSchema = z.object({
  favorites: z.array(z.string()).default([]),
  filter_countries: z.array(z.string()).default([]),
  filter_airlines: z.array(z.string()).default([]),
  altitude_min: z.number().nullable().optional(),
  altitude_max: z.number().nullable().optional(),
  show_on_ground: z.boolean().default(true),
  region_lat: z.number().nullable().optional(),
  region_lon: z.number().nullable().optional(),
  region_radius_km: z.number().nullable().optional(),
  theme: z.enum(["day", "night", "blue-marble"]).default("day"),
});

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const supa = supabaseServer();
  const { data, error } = await supa
    .from("user_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ preferences: data ?? null });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauth" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const parsed = prefsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid prefs", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supa = supabaseServer();
  const { data, error } = await supa
    .from("user_preferences")
    .upsert(
      { user_id: userId, ...parsed.data, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ preferences: data });
}
