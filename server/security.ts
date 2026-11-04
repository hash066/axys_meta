import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { isPublicHttpsOrigin } from "../services/providers/config.ts";
export function encrypt(text: string, key: string) {
  const k = Buffer.from(key, "base64");
  if (k.length !== 32)
    throw new Error("AXYS_TOKEN_KEY must be 32 bytes base64");
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", k, iv);
  return Buffer.concat([
    iv,
    c.update(text),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function decrypt(text: string, key: string) {
  const b = Buffer.from(text, "base64"),
    d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      b.subarray(0, 12),
    );
  d.setAuthTag(b.subarray(-16));
  return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
}
export function sign(value: string, key: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function required(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}
export function publicOrigin() {
  const u = new URL(required("AXYS_ORIGIN"));
  if (!isPublicHttpsOrigin(u.href))
    throw new Error("A public HTTPS AXYS_ORIGIN is required");
  return u.origin;
}
