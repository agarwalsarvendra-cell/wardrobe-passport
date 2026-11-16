import { adminNonce, adminSignIn, checkInvite, demoSignIn, join, sendCode, signOut, verifyCode } from "@/lib/auth";
import { UserError } from "@/lib/errors";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sign-in and joining. Body: { op: "join" | "check-invite" | "send-code" | "verify" | "demo" | "admin-nonce" | "admin" | "sign-out", ... }
export async function POST(req: Request) {
  return safely(async () => {
    const body = await req.json().catch(() => ({}));
    switch (body.op) {
      case "check-invite": return checkInvite(body.code);
      case "join": return join(body);
      case "send-code": return sendCode(body);
      case "verify": return verifyCode(body);
      case "demo": return demoSignIn(body);
      case "admin-nonce": return adminNonce();
      case "admin": return adminSignIn(body);
      case "sign-out": await signOut(); return { ok: true };
      default: throw new UserError("Unknown request.");
    }
  });
}
