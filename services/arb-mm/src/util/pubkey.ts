import { PublicKey } from "@solana/web3.js";

export type MaybePubkey = string | PublicKey | { publicKey?: PublicKey } | null | undefined;

export function asPublicKey(value?: MaybePubkey): PublicKey | undefined {
  if (!value) return undefined;
  try {
    if (value instanceof PublicKey) return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      return new PublicKey(trimmed);
    }
    if ((value as any)?.publicKey instanceof PublicKey) {
      return (value as any).publicKey as PublicKey;
    }
    if (typeof (value as any)?.toBase58 === "function" && typeof (value as any)?.toBuffer === "function") {
      return value as PublicKey;
    }
    if (Array.isArray(value)) {
      return new PublicKey(Uint8Array.from(value as number[]));
    }
    const buf = (value as any)?.toBuffer?.();
    if (buf && buf.length === 32) {
      return new PublicKey(buf);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function requirePublicKey(value: MaybePubkey, hint?: string): PublicKey {
  const pk = asPublicKey(value);
  if (!pk) throw new Error(hint ? `invalid_public_key_${hint}` : "invalid_public_key");
  return pk;
}
