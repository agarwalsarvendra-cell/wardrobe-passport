// QuickNode Streams webhook: an independent feed of both contracts on Arc.
// QuickNode pushes every log the marketplace (V3) and protection contracts emit; this
// route checks the signature, decodes each log with the matching ABI and stores it in
// chain_events. The ledger then shows which actions the chain feed confirms, so members
// don't have to trust our own database.
import crypto from "node:crypto";
import { ethers } from "ethers";
import { CFG } from "@/lib/config";
import { iface, piface } from "@/lib/chain";
import { q } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamEvent = { txHash: string; logIndex: number; blockNumber: number; blockTime: number | null; address?: string; topics: string[]; data: string };

function validSignature(secret: string, nonce: string, ts: string, raw: string, given: string) {
  const expected = crypto.createHmac("sha256", secret).update(nonce + ts + raw, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// JSON-safe copy of decoded args (bigints become strings).
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  return v;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function decode(e: StreamEvent): { name: string; args: Record<string, unknown>; contract: string } {
  // Pick the ABI by the emitting contract; if the filter didn't send the address, try both.
  const order = same(e.address, CFG.protection) ? [["protection", piface], ["passport", iface]] : [["passport", iface], ["protection", piface]];
  for (const [label, f] of order as [string, ethers.Interface][]) {
    try {
      const parsed = f.parseLog({ topics: e.topics, data: e.data });
      if (!parsed) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => { args[input.name || String(i)] = plain(parsed.args[i]); });
      return { name: parsed.name, args, contract: label };
    } catch { /* not this ABI */ }
  }
  return { name: "Unknown", args: {}, contract: same(e.address, CFG.protection) ? "protection" : "passport" };
}

export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.QN_STREAM_SECRET;
  const nonce = req.headers.get("x-qn-nonce");
  const ts = req.headers.get("x-qn-timestamp");
  const sig = req.headers.get("x-qn-signature");
  if (!secret) return new Response("not configured", { status: 500 });
  if (!nonce || !ts || !sig) return new Response("missing headers", { status: 400 });
  if (!validSignature(secret, nonce, ts, raw, sig)) return new Response("bad signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("ok", { status: 200 }); }
  // The filter returns { events: [...] }. Accept a wrapped or batched shape too.
  const batches = Array.isArray(body) ? body : [body?.data ?? body];
  const events: StreamEvent[] = batches.flatMap((b: any) => (Array.isArray(b) ? b : [b])).flatMap((b: any) => b?.events ?? []);

  let stored = 0;
  for (const e of events) {
    if (!e?.txHash || !Array.isArray(e.topics)) continue;
    const d = decode(e);
    const rows = await q(
      `insert into chain_events (tx_hash, log_index, block_number, block_time, event, args, contract)
       values ($1, $2, $3, to_timestamp($4), $5, $6, $7)
       on conflict (tx_hash, log_index) do nothing returning tx_hash`,
      [e.txHash.toLowerCase(), e.logIndex, e.blockNumber, e.blockTime ?? Math.floor(Date.now() / 1000), d.name, JSON.stringify(d.args), d.contract],
    );
    stored += rows.length;
  }
  // Always 2xx after a valid signature, or the stream pauses after 3 failures.
  return Response.json({ ok: true, stored });
}
