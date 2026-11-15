import { NextResponse } from "next/server";
import { friendly } from "./chain";
import { UserError } from "./actions";

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

/** Run a handler; always answer with JSON and a sentence a person can act on. */
export async function safely(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (e: any) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    const msg = friendly(e);
    return json({ error: msg }, msg.startsWith("Something went wrong") ? 500 : 400);
  }
}
