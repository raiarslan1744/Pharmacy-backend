import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

export class SessionTokenManager {
  constructor({ secret = randomBytes(32), ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
    this.secret = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret));
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > DEFAULT_TTL_SECONDS) throw new TypeError('Session lifetime must be between one second and eight hours');
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  issueSuperAdmin(accountId, version = 1) {
    const subject = String(accountId ?? '');
    if (!/^\d+$/.test(subject)) throw new TypeError('Invalid Super Admin account identifier');
    const issuedAt = Math.floor(this.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      sub: subject,
      jti: randomUUID(),
      ver: version,
      role: 'superAdmin',
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
    })).toString('base64url');
    return { token: `${payload}.${this.#sign(payload)}`, expiresAt: (issuedAt + this.ttlSeconds) * 1000 };
  }

  verify(token) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = Buffer.from(this.#sign(parts[0]), 'base64url');
    let supplied;
    try { supplied = Buffer.from(parts[1], 'base64url'); } catch { return null; }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      const now = Math.floor(this.now() / 1000);
      if (claims.role !== 'superAdmin' || !/^\d+$/.test(String(claims.sub)) || !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60) return null;
      if (!/^[a-f0-9-]{36}$/.test(claims.jti) || !Number.isInteger(claims.ver) || claims.exp - claims.iat > DEFAULT_TTL_SECONDS) return null;
      return { sub: String(claims.sub), role: claims.role, exp: claims.exp, jti: claims.jti, ver: claims.ver };
    } catch {
      return null;
    }
  }

  #sign(payload) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
