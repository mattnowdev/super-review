---
description: Cryptography anti-patterns reference loaded by super-review:run. Covers weak RNG, AES-GCM IV reuse, AES-CBC padding oracles, JWT alg confusion, password-hashing parameters, RSA padding, TLS verification bypass, key separation, secrets in logs. Load when the diff touches `crypto`/`jose`/`jsonwebtoken`/`bcrypt`/`argon2` or auth code paths.
---

# Crypto review reference

Application-layer cryptographic anti-patterns for the Cybersec L5 reviewer in [`super-review:run`](../run/SKILL.md). Auto-loaded when the diff touches authentication, token generation, encryption, or signing code.

---

## Anti-pattern: `Math.random()` for security tokens
**Detection signal:** `Math.random()` near token/id/secret/nonce/csrf/session keywords
**Verbatim bad example:**
```ts
const resetToken = Math.random().toString(36).slice(2);
await db.user.update({ where: { id }, data: { resetToken } });
```
**Why it's wrong:** xorshift128+ state can be recovered from a handful of outputs; attacker predicts every future token in the process.
**Fix:** `crypto.randomBytes(32).toString('base64url')` server-side, `crypto.getRandomValues(new Uint8Array(32))` in browsers/edge.
**Review prompt one-liner:** Flag every `Math.random()` whose result reaches a token, id, password, nonce, salt, IV, session, csrf, or filename context.
**CWE:** CWE-338, CWE-330.

## Anti-pattern: AES-GCM IV reuse with the same key
**Detection signal:** static IV constants, `iv = Buffer.alloc(12)`, IV derived from sequence stored in user-controllable column, key+IV reused across messages.
**Verbatim bad example:**
```ts
const iv = Buffer.alloc(12, 0); // FIXED IV — catastrophic
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(plaintext), c.final()]);
const tag = c.getAuthTag();
```
**Why it's wrong:** One IV reuse leaks the GHASH authentication subkey H — attacker forges arbitrary ciphertexts under that key (NIST 800-38D §8.3); two messages with the same (K, IV) also XOR-leak the plaintexts.
**Fix:** Random 96-bit IV per message via `crypto.randomBytes(12)`; rekey before 2^32 messages; for high-volume, prefer XChaCha20-Poly1305 or AES-GCM-SIV.
**Review prompt one-liner:** Every `createCipheriv('aes-*-gcm', …)` / `AES/GCM` / `aead.Seal` — confirm the IV source is fresh random or strict monotonic counter never reused across key rotations.
**CWE:** CWE-323.

## Anti-pattern: AES-CBC without authentication (padding oracle)
**Detection signal:** `aes-256-cbc`, `AES/CBC/PKCS5Padding`, decrypt path that returns different error/status for padding vs MAC failure.
**Verbatim bad example:**
```ts
try {
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([d.update(ct), d.final()]);
} catch (e) {
  res.status(400).send('bad padding'); // ORACLE
}
```
**Why it's wrong:** Vaudenay padding oracle — attacker decrypts ciphertext byte-by-byte using differential response/timing.
**Fix:** Use AES-GCM, ChaCha20-Poly1305, or encrypt-then-HMAC-SHA-256 with `timingSafeEqual` on MAC before decrypt.
**Review prompt one-liner:** Any CBC-mode decrypt path must have an HMAC verified in constant time before unpadding.
**CWE:** CWE-310/CWE-696.

## Anti-pattern: `===` / `==` on HMAC, MAC, signature, or secret token
**Detection signal:** `===` adjacent to `crypto.createHmac`, `sign`, `digest`, `Bearer`, `signature`, `webhook`.
**Verbatim bad example:**
```ts
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
if (req.headers['x-signature'] !== expected) return res.status(401).end();
```
**Why it's wrong:** Byte-by-byte early-exit comparison leaks position of first mismatch; statistical timing recovers signature byte-by-byte.
**Fix:** `crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))` after length check; in Python use `hmac.compare_digest`; in Go `subtle.ConstantTimeCompare`.
**Review prompt one-liner:** Flag every equality comparison whose operands are HMAC outputs, signatures, password hashes, or session tokens unless it is a constant-time primitive.
**CWE:** CWE-208.

## Anti-pattern: bcrypt cost < 12 or password hashing with raw SHA-*/MD5
**Detection signal:** `bcrypt.hash(pwd, 10)`, `createHash('sha256').update(pwd)`, `md5(pwd)`.
**Verbatim bad example:**
```ts
const hash = await bcrypt.hash(password, 10);  // cost too low for 2026
// or worse:
const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
```
**Why it's wrong:** Modern GPU/ASIC rigs do >10^10 SHA-256/s; cost-10 bcrypt is <1ms/hash on cloud CPUs. Per OWASP, Argon2id is default; bcrypt is for legacy only at cost ≥ 12 with 72-byte input limit; PBKDF2-HMAC-SHA-256 needs ≥ 600,000 iterations.
**Fix:** Argon2id m=19 MiB, t=2, p=1 (minimum) or m=64 MiB, t=3, p=1 (recommended). Pre-hash with SHA-512 if input may exceed 72 bytes (bcrypt only).
**Review prompt one-liner:** Verify password hashing uses Argon2id with `m>=19456,t>=2,p=1`, or bcrypt cost ≥ 12, or PBKDF2-HMAC-SHA-256 iter ≥ 600k.
**OWASP/CWE:** CWE-916, OWASP ASVS V2.4.

## Anti-pattern: JWT alg confusion / `alg: none` / `kid` injection
**Detection signal:** `jwt.verify(token, key)` without `algorithms` allow-list; `kid` value used as filesystem path, DB key, or URL.
**Verbatim bad example:**
```ts
const payload = jwt.verify(token, publicKey); // accepts any alg in header
// kid loaded from header without validation
const key = fs.readFileSync(`/keys/${decoded.header.kid}.pem`);
```
**Why it's wrong:** Attacker forges header `{"alg":"HS256"}` and signs with the *public* key as HMAC secret — verifier treats RSA pub key as shared secret. `alg:none` bypass strips signature entirely. `kid` traversal (`../../etc/passwd`, `'; DROP TABLE`) loads attacker-chosen key or triggers SQLi.
**Fix:** Always pin `algorithms: ['RS256']` (or `'EdDSA'`); reject `kid` not matching `^[a-f0-9-]{1,64}$` against a static allow-list; prefer JWK Set with `kid` lookup, never filesystem concat.
**Review prompt one-liner:** Every `jwt.verify` must pass an explicit `algorithms` allow-list and validate `kid` against a hardcoded set or JWKS.
**CWE:** CWE-347, CWE-345, CWE-22.

## Anti-pattern: JWT missing `exp`/`aud`/`iss`/`nbf` validation
**Detection signal:** `jwt.decode(` (decode-only) used in auth flow; absent `audience`/`issuer` options in `verify`.
**Verbatim bad example:**
```ts
const claims = jwt.decode(token); // decode != verify
if (claims.sub) req.userId = claims.sub;
```
**Why it's wrong:** `decode` does not check signature; even after `verify`, missing audience check lets a token issued for service A be replayed at service B.
**Fix:** `jwt.verify(token, key, { algorithms:['RS256'], audience:'api.example.com', issuer:'https://idp.example.com', clockTolerance: 30 })`.
**Review prompt one-liner:** Flag any `jwt.decode` in an auth path and any `verify` without `audience` + `issuer` + algorithm pin.
**CWE:** CWE-345.

## Anti-pattern: RSA-PKCS1v1.5 encryption / 1024-bit RSA / ECDSA nonce reuse
**Detection signal:** `RSA/ECB/PKCS1Padding`, `padding: constants.RSA_PKCS1_PADDING`, `generateKeyPairSync('rsa', { modulusLength: 1024 })`, custom ECDSA signer pulling `k` from non-deterministic source.
**Verbatim bad example:**
```ts
crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, plaintext);
```
**Why it's wrong:** PKCS#1 v1.5 encryption is Bleichenbacher-attackable; NIST SP 800-131A recommends migration to RSA-OAEP. 1024-bit RSA is below 112-bit security since 2014. ECDSA with reused `k` instantly leaks the private key (Sony PS3; RFC 6979 deterministic-k mitigates).
**Fix:** OAEP-SHA-256 for encryption, PSS-SHA-256 for signatures, ≥ 3072-bit RSA, Ed25519 where possible, RFC 6979 deterministic ECDSA otherwise.
**Review prompt one-liner:** Reject PKCS1v1.5 encryption padding, modulus < 2048, and any ECDSA path that does not use deterministic-k or a vetted library.
**CWE:** CWE-780, CWE-326, CWE-323.

## Anti-pattern: TLS verification disabled
**Detection signal:** `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False` (Python `requests`), `InsecureSkipVerify: true` (Go), `--insecure` flag in production code.
**Verbatim bad example:**
```ts
const agent = new https.Agent({ rejectUnauthorized: false });
axios.get(internalUrl, { httpsAgent: agent });
```
**Why it's wrong:** Any on-path attacker (corporate proxy, compromised egress) MITMs traffic transparently; was the root cause of multiple npm-registry token thefts.
**Fix:** Trust system CAs; if a private CA is needed, load it explicitly via `ca:` option and pin.
**Review prompt one-liner:** Block any change introducing `rejectUnauthorized:false`, `verify=False`, `InsecureSkipVerify`, or `NODE_TLS_REJECT_UNAUTHORIZED` env override.
**CWE:** CWE-295.

## Anti-pattern: Same key for encryption and signing (no domain separation)
**Detection signal:** one symmetric `key` constant used by both `createCipheriv` and `createHmac`; one RSA key used for both `sign` and `decrypt`.
**Verbatim bad example:**
```ts
const KEY = process.env.MASTER_KEY;
encrypt(KEY, data); sign(KEY, data); // same key, two purposes
```
**Why it's wrong:** Breaks formal security proofs; attacks on one mode (e.g. signing oracle) compromise the other.
**Fix:** HKDF-derive purpose-specific subkeys: `HKDF(master, salt, 'enc-v1', 32)`, `HKDF(master, salt, 'mac-v1', 32)`.
**Review prompt one-liner:** Any single key used for >1 cryptographic purpose must be replaced with HKDF-derived subkeys.
**CWE:** CWE-323.

## Anti-pattern: Secrets in error messages, logs, or process env dumps
**Detection signal:** `console.error(err)` where `err` may serialize headers; Sentry `extra: req.headers`; `JSON.stringify(process.env)` in debug routes; `.env` in `git status`.
**Verbatim bad example:**
```ts
catch (e) { logger.error('db connect failed', { dsn: process.env.DATABASE_URL, err: e }); }
```
**Why it's wrong:** Logs flow to third-party SaaS (Datadog, Sentry, BetterStack) with broader access than DB credentials; DSNs include passwords.
**Fix:** Redact via deny-list (`DATABASE_URL`, `*_SECRET`, `*_TOKEN`, `authorization`, `cookie`) at logger transport layer; tools like `pino-noir`.
**Review prompt one-liner:** Verify every logger has a secret-redaction transport configured and that no log payload includes raw `process.env`, `req.headers`, or connection strings.
**CWE:** CWE-532, CWE-209.

## What good looks like

### CSPRNG for every secret-bearing identifier
```ts
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('base64url'); // 256 bits, URL-safe
// browser/edge:
const buf = new Uint8Array(32);
crypto.getRandomValues(buf);
```
**Why it works:** `randomBytes` / `getRandomValues` sources from the OS CSPRNG; state cannot be recovered; 256-bit entropy is well above any guessing budget.
**Affirm:** Every token / session id / reset code / share link uses `crypto.randomBytes` (Node) or `crypto.getRandomValues` (Web), never `Math.random()` or `Date.now()`.

### Constant-time comparison for secrets
```ts
import { timingSafeEqual } from 'node:crypto';
const a = Buffer.from(received, 'hex'), b = Buffer.from(expected, 'hex');
if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).end();
```
**Why it works:** Comparison time is independent of where bytes diverge; statistical timing attacks cannot recover the secret byte-by-byte.
**Affirm:** Every HMAC / signature / session-token / password-hash comparison uses `timingSafeEqual` (or language equivalent: `hmac.compare_digest` / `subtle.ConstantTimeCompare`).

### Argon2id with documented parameters
```ts
import argon2 from 'argon2';
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536,   // 64 MiB
  timeCost: 3,
  parallelism: 1,
});
```
**Why it works:** Argon2id is the OWASP default; explicit parameters mean cost can be tuned in one place; memory cost defeats GPU/ASIC attackers.
**Affirm:** Password hashing uses Argon2id with `memoryCost ≥ 19456` and `timeCost ≥ 2`, OR bcrypt with `cost ≥ 12`, parameters committed to code.

### HKDF for purpose-specific subkeys
```ts
import { hkdfSync } from 'node:crypto';
const enc = hkdfSync('sha256', master, salt, 'enc-v1', 32);
const mac = hkdfSync('sha256', master, salt, 'mac-v1', 32);
```
**Why it works:** One stored secret; subkeys are independent for distinct purposes (encryption vs MAC); compromise of one doesn't affect the other.
**Affirm:** Any code that needs > 1 key uses HKDF-derived subkeys from a single master, never reuses one key across purposes.

### JWT verify with explicit algorithm + audience + issuer pin
```ts
const payload = jwt.verify(token, publicKey, {
  algorithms: ['RS256'],
  audience: 'api.example.com',
  issuer: 'https://idp.example.com',
  clockTolerance: 30,
});
```
**Why it works:** Defeats alg confusion (HS256 forged using RS256 public key); rejects tokens issued for other services; clock-tolerance window absorbs benign skew.
**Affirm:** Every `jwt.verify` pins `algorithms`, `audience`, `issuer`; no `jwt.decode` in any auth path.

## Sources
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [NIST SP 800-38D — GCM](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf)
- [NIST SP 800-131A Rev. 2](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-131Ar2.pdf)
- [Neil Madden — GCM and random nonces](https://neilmadden.blog/2024/05/23/galois-counter-mode-and-random-nonces/)
- [PortSwigger — JWT attacks](https://portswigger.net/web-security/jwt)
- [RFC 6979 — Deterministic ECDSA](https://www.rfc-editor.org/rfc/rfc6979)
