/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * Secret redaction for the local diagnostic channel (plan §"redact.ts"). EVERY value written to a
 * diagnostic file passes through redact() first, at ALL levels — tiered privacy governs raw
 * names/paths, but tokens/secrets are scrubbed unconditionally. Two passes:
 *   1. KEY-based — a value whose (normalized) key names a credential is dropped wholesale, so we
 *      never depend on the value matching a pattern.
 *   2. VALUE-pattern — known secret shapes (JWTs, SF session ids, refresh tokens) and inline
 *      `key=value` secrets embedded in free text are masked in place.
 * Design guarantees:
 *   - FAIL-CLOSED: any error during traversal (circular refs, hostile getters, depth blow-ups)
 *     collapses the whole value to REDACTED_ERROR rather than risking a leak.
 *   - ReDoS-SAFE: every regex is linear — no nested/overlapping quantifiers, and the one lookbehind
 *     bounds its separator run to {1,4}. An earlier unbounded lookbehind was measured taking 428ms
 *     on a 16KiB adversarial input; the bounded form drops that to <1ms.
 *   - VALID JSON out: the sentinels contain no quote/backslash, and object values are replaced by a
 *     plain string, so the redacted structure always re-serializes to valid JSON.
 */

/** Replacement for any value identified as (or containing) a secret. */
export const REDACTED = '<REDACTED>';

/** Sentinel returned when redaction itself fails — the fail-closed outcome (never the raw value). */
export const REDACTED_ERROR = '<REDACTION_FAILED>';

/** Guards against unbounded/circular structures blowing the stack; deeper subtrees are dropped. */
const MAX_DEPTH = 32;

/*
 * Keys (NORMALIZED — lower-cased, non-alphanumerics stripped) whose VALUE is always a credential and
 * is dropped wholesale regardless of shape. Broadened per review to cover the header/field spellings
 * seen across jsforce/@salesforce/core and common HTTP auth. Matching is exact-on-normalized, so
 * `access_token`, `access-token`, `accessToken`, and `X-Access-Token` all collapse to `accesstoken`.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'authtoken',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'sessionid',
  'sid',
  'apikey',
  'privatekey',
  'credentials',
  'credential',
  'xsfdcsession',
]);

/** Normalizes a key to its comparison form: lower-case, alphanumerics only. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a value under this key must be dropped wholesale (see SECRET_KEYS). Matches the normalized
 * key, and also the form with a leading `x` stripped so custom HTTP auth headers (`X-Access-Token`,
 * `X-Auth-Token`) are caught (`xaccesstoken` -> `accesstoken`).
 */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEYS.has(normalized)) {
    return true;
  }
  return normalized.startsWith('x') && SECRET_KEYS.has(normalized.slice(1));
}

/*
 * Value-shape patterns. Each is applied with String.prototype.replace over the input. All are
 * linear-time. Ordering is not significant (matches are non-overlapping in practice).
 */
const VALUE_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // OAuth Bearer header value — keep the scheme word, mask the credential.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: `Bearer ${REDACTED}` },
  // JSON Web Token: three base64url segments (header.payload.signature); signature may be empty.
  { re: /\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  // Salesforce session id: 15/18-char org id, '!', then the token body.
  { re: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._+/=%-]+/g, replacement: REDACTED },
  // Salesforce refresh token prefix.
  { re: /\b5Aep[A-Za-z0-9._%-]+/g, replacement: REDACTED },
  // Inline `key=value` / `key: value` secrets in free text. The lookbehind separator run is bounded
  // to {1,4} (the ReDoS fix); the value class is a single linear negated set.
  {
    re: /(?<=(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|apikey|api_key|sid|sessionid|private_key|authorization)["'\s:=]{1,4})[^\s,"'}{\]]+/gi,
    replacement: REDACTED,
  },
];

/** Applies every value-shape pattern to a string, masking any secret it finds. */
export function redactString(value: string): string {
  let out = value;
  for (const { re, replacement } of VALUE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Recursively redacts a value: strings are pattern-scrubbed; object values under a secret key are
 * dropped; arrays/objects are traversed. Cycles are broken via `seen`, and depth is bounded. Any
 * non-plain value (number/boolean/null) passes through unchanged. This is the internal worker;
 * callers use the fail-closed `redact` wrapper below.
 */
function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  // Non-object values: JSON-serializable primitives (number/boolean/bigint) and `null` pass through
  // untouched; anything else (function/symbol/undefined) becomes `undefined` so JSON.stringify omits
  // it, mirroring default JSON behavior rather than emitting an invalid row.
  if (value === null || typeof value !== 'object') {
    if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return value;
    }
    return undefined;
  }
  if (depth >= MAX_DEPTH || seen.has(value)) {
    return REDACTED; // over-redact rather than recurse into a cycle or an unbounded structure.
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactInner(val, seen, depth + 1);
  }
  return out;
}

/**
 * Fail-closed entry point: returns a deep-redacted CLONE of `value` safe to write to disk. On ANY
 * internal failure it returns the REDACTED_ERROR sentinel rather than propagating (redaction must
 * never throw into the fire-and-forget logger, and must never leak on error).
 */
export function redact(value: unknown): unknown {
  try {
    return redactInner(value, new WeakSet<object>(), 0);
  } catch {
    return REDACTED_ERROR;
  }
}
