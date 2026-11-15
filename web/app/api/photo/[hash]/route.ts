import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

// Serves a photo by its SHA-256 fingerprint. The same fingerprint is stored in the passport on Arc.
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("Not found", { status: 404 });
  const rows = await q("select mime, bytes from photos where hash = $1", [hash]);
  if (!rows[0]) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(rows[0].bytes), {
    headers: { "content-type": rows[0].mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
