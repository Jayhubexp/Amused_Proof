import 'dotenv/config';

// Centralised environment handling. No secrets are hard-coded anywhere.
export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI || null,
  museSparkApiKey: process.env.MUSE_SPARK_API_KEY || null,
  museSparkBaseUrl: process.env.MUSE_SPARK_BASE_URL || 'https://api.meta.ai/v1',
  museSparkModel: process.env.MUSE_SPARK_MODEL || 'muse-spark-1.3',
  museSparkTimeoutMs: Number(process.env.MUSE_SPARK_TIMEOUT_MS ?? 20000),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // WebAuthn relying party. Localhost defaults work for local development;
  // production MUST set an https origin, matching rpId, and COOKIE_SECURE=true.
  rpName: process.env.WEBAUTHN_RP_NAME || 'CivicProof AI',
  rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
  webauthnOrigin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173',
  cookieSecure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 3600000),
  // Optional JSON snapshot path so the memory store survives API restarts.
  // Unset by default (pure memory); MongoDB remains the preferred durable backend.
  storeFile: process.env.STORE_FILE || null,
  isProduction: process.env.NODE_ENV === 'production',
  // One-time token that authorises creation of the founding organizer account.
  // Single-use (consumed atomically on first success) and checked with a
  // constant-time compare. Unset disables the bootstrap endpoint entirely.
  organizerSetupToken: process.env.ORGANIZER_SETUP_TOKEN || null,
  organizerSessionTtlMs: Number(process.env.ORGANIZER_SESSION_TTL_MS ?? 3600000),
};
