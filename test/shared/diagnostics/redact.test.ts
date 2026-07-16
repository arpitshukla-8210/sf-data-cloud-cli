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

import { performance } from 'node:perf_hooks';
import { expect } from 'chai';
import { redact, redactString, isSecretKey, REDACTED, REDACTED_ERROR } from '../../../src/shared/diagnostics/redact.js';

describe('diagnostics/redact', () => {
  describe('redactString (value-shape patterns)', () => {
    it('masks a JWT (three base64url segments)', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
      const out = redactString(`token is ${jwt} ok`);
      expect(out).to.include(REDACTED);
      expect(out).to.not.include(jwt);
    });

    it('masks an OAuth Bearer credential (the token never survives)', () => {
      const out = redactString('Authorization: Bearer abc123.def-456_ghi');
      expect(out).to.include(REDACTED);
      expect(out).to.not.include('abc123.def-456_ghi');
    });

    it('masks a Salesforce session id (00D...!...)', () => {
      const sid = '00D5f000000abcdEAA!AQEAQK9wnotarealtokenvalue1234567890';
      const out = redactString(`sid=${sid}`);
      expect(out).to.not.include('AQEAQK9w');
    });

    it('masks a Salesforce refresh token (5Aep…)', () => {
      const rt = '5Aep861ThisIsNotARealRefreshTokenXYZ';
      expect(redactString(rt)).to.equal(REDACTED);
    });

    it('masks an inline key=value secret in free text', () => {
      const out = redactString('connecting with password=hunter2 and other stuff');
      expect(out).to.include(`password=${REDACTED}`);
      expect(out).to.not.include('hunter2');
    });

    it('leaves non-secret text untouched', () => {
      const clean = 'deployed 3 components in 42ms to dataspace default';
      expect(redactString(clean)).to.equal(clean);
    });
  });

  describe('isSecretKey (normalized key matching)', () => {
    it('matches across case and separator spellings', () => {
      for (const key of [
        'authorization',
        'Authorization',
        'access_token',
        'access-token',
        'accessToken',
        'X-Access-Token',
      ]) {
        expect(isSecretKey(key), key).to.equal(true);
      }
    });

    it('does not match ordinary keys', () => {
      for (const key of ['componentName', 'durationMs', 'count', 'status']) {
        expect(isSecretKey(key), key).to.equal(false);
      }
    });
  });

  describe('redact (deep traversal)', () => {
    it('drops the value under a secret key wholesale', () => {
      const out = redact({ authorization: 'Bearer secret', count: 3 }) as Record<string, unknown>;
      expect(out.authorization).to.equal(REDACTED);
      expect(out.count).to.equal(3);
    });

    it('recurses into nested objects and arrays', () => {
      const tokenKey = 'access_token';
      const out = redact({
        outer: { [tokenKey]: 'abc', items: [{ password: 'p' }, { ok: 1 }] },
      }) as { outer: Record<string, unknown> & { items: Array<Record<string, unknown>> } };
      expect(out.outer[tokenKey]).to.equal(REDACTED);
      expect(out.outer.items[0].password).to.equal(REDACTED);
      expect(out.outer.items[1].ok).to.equal(1);
    });

    it('returns a redacted CLONE, leaving the input unmutated', () => {
      const input = { password: 'keepme-in-original' };
      redact(input);
      expect(input.password).to.equal('keepme-in-original');
    });

    it('produces valid JSON (no unescaped sentinels)', () => {
      const out = redact({ a: 'Bearer x', b: { token: 'y' } });
      expect(() => JSON.stringify(out)).to.not.throw();
      expect(JSON.stringify(out)).to.include(REDACTED);
    });

    it('fails closed on a circular reference (never throws, never leaks)', () => {
      const cyclic: Record<string, unknown> = { name: 'x' };
      cyclic.self = cyclic;
      const out = redact(cyclic);
      // Traversal completes without throwing; the cycle collapses to a sentinel rather than looping.
      expect(() => JSON.stringify(out)).to.not.throw();
      expect(JSON.stringify(out)).to.include(REDACTED);
    });

    it('passes primitives through and drops non-serializable values', () => {
      expect(redact(42)).to.equal(42);
      expect(redact(true)).to.equal(true);
      expect(redact(null)).to.equal(null);
      expect(redact(() => 1)).to.equal(undefined);
    });
  });

  describe('ReDoS resistance', () => {
    it('processes a 16KiB adversarial input in well under 50ms', () => {
      // A long run of the lookbehind separator chars followed by no value — the classic catastrophic
      // backtracking trigger for an unbounded lookbehind. The bounded {1,4} form stays linear.
      const hostile = 'password' + '='.repeat(16 * 1024);
      const start = performance.now();
      const out = redactString(hostile);
      const elapsed = performance.now() - start;
      expect(elapsed, `redactString took ${elapsed.toFixed(1)}ms`).to.be.lessThan(50);
      expect(out).to.be.a('string');
    });
  });

  describe('exported sentinels', () => {
    it('are quote/backslash-free so redacted rows stay valid JSON', () => {
      for (const sentinel of [REDACTED, REDACTED_ERROR]) {
        expect(sentinel).to.not.match(/["\\]/);
      }
    });
  });
});
