import crypto from "node:crypto";

/**
 * TOTP（RFC 6238）的最小实现，只用 node:crypto，不引入新依赖。
 *
 * 为什么自己写：这个项目的依赖是锁死的，为了一个 40 行的算法去动 package.json
 * 不划算；而且算法足够简单，可以直接对 RFC 的测试向量做断言（见 _probe_totp.ts）。
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = "MornheIsland";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("非法的 Base32 密钥");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成新的随机密钥（Base32，默认 160 bit，与主流验证器一致） */
export function randomSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

export function totpStep(at: number = Date.now(), step = TOTP_STEP_SECONDS): number {
  return Math.floor(at / 1000 / step);
}

/** HOTP（RFC 4226），TOTP 的基础 */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secret: string, at: number = Date.now(), step = TOTP_STEP_SECONDS, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(at, step), digits);
}

/**
 * 校验一次性验证码。
 * @param window 允许的时间漂移步数（±1 步 = ±30 秒，容忍设备时钟误差）
 * @param after  已经用过的最大步数，用于防重放（同一个码不能用两次）
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { window?: number; step?: number; digits?: number; after?: number; at?: number } = {},
): { ok: boolean; step?: number; reason?: string } {
  const digits = opts.digits ?? TOTP_DIGITS;
  const step = opts.step ?? TOTP_STEP_SECONDS;
  const win = opts.window ?? 1;
  const clean = String(code || "").replace(/\s/g, "");

  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false, reason: "格式不正确" };
  if (!secret) return { ok: false, reason: "未设置密钥" };

  const cur = totpStep(opts.at ?? Date.now(), step);
  for (let d = -win; d <= win; d++) {
    const cand = cur + d;
    if (opts.after !== undefined && cand <= opts.after) continue;
    let expect = "";
    try {
      expect = hotp(secret, cand, digits);
    } catch {
      return { ok: false, reason: "密钥损坏" };
    }
    // 定长比较，避免时间侧信道
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(clean))) {
      return { ok: true, step: cand };
    }
  }
  return { ok: false, reason: "验证码不正确或已过期" };
}

/** 验证器扫码用的 otpauth:// 地址 */
export function otpauthUri(secret: string, account: string, issuer = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** 恢复码：用户丢了手机时的唯一退路，展示一次，只存哈希 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return crypto
    .createHash("sha256")
    .update(String(code || "").toUpperCase().replace(/[\s-]/g, ""))
    .digest("hex");
}
