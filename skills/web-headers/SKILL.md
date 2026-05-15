---
description: Web security headers anti-patterns reference loaded by super-review:run. Covers CSP (nonces/strict-dynamic/Trusted Types), HSTS, CORS, COOP/COEP, Permissions-Policy, SRI, cookie attributes (Secure/HttpOnly/SameSite/__Host-/Partitioned/CHIPS), Referrer-Policy. Load when reviewing HTTP response code, middleware, edge config, or framework header settings.
---

# Web security headers review reference

HTTP-header-level hardening checks for the Cybersec L5 reviewer in [`super-review:run`](../run/SKILL.md). Auto-loaded when the diff touches middleware, `next.config`, `vercel.json`, `nginx.conf`, response-header setters, or cookie code.

---

## Anti-pattern: CSP with `'unsafe-inline'` and `'unsafe-eval'` in `script-src`
**Detection signal:** `Content-Security-Policy` value contains `'unsafe-inline'` for `script-src` or any `'unsafe-eval'`.
**Verbatim bad example:**
```ts
res.setHeader('Content-Security-Policy',
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'");
```
**Why it's wrong:** Defeats CSP's XSS mitigation entirely — inline `<script>` and `eval`/`new Function` execute attacker payloads.
**Fix:** Per-request nonce + `strict-dynamic`: `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline';` (legacy `unsafe-inline` is ignored by browsers that honor nonce/strict-dynamic, so it acts as fallback for ancient UAs).
**Review prompt one-liner:** Reject any CSP containing `'unsafe-eval'` or any `script-src` that mixes `'unsafe-inline'` without a nonce/hash + `'strict-dynamic'`.
**CWE:** CWE-79, CWE-1021.

## Anti-pattern: CSP missing `frame-ancestors` and `base-uri`
**Detection signal:** CSP without `base-uri 'none'` or `frame-ancestors`.
**Verbatim bad example:**
```ts
"default-src 'self'; script-src 'self' 'nonce-abc'"
```
**Why it's wrong:** `default-src` does *not* cover `base-uri` or `frame-ancestors`; attacker can inject `<base href="//evil/">` to redirect relative script URLs, bypassing nonced CSP; missing `frame-ancestors` re-enables clickjacking even with X-Frame-Options dropped.
**Fix:** Always add `base-uri 'none'; frame-ancestors 'none';` (or specific origins) explicitly.
**Review prompt one-liner:** Every CSP must explicitly set `base-uri` and `frame-ancestors`; do not rely on `default-src` fallback.
**CWE:** CWE-1021.

## Anti-pattern: Missing Trusted Types in modern app
**Detection signal:** No `require-trusted-types-for 'script'` directive; presence of `innerHTML`/`document.write`/`eval` in client bundles.
**Verbatim bad example:**
```ts
// CSP omits trusted-types entirely
"script-src 'nonce-abc' 'strict-dynamic'"
```
**Why it's wrong:** Even strict CSP allows DOM-XSS sinks (`Element.innerHTML`, `Range.createContextualFragment`, `Worker` ctor) to execute attacker strings. Trusted Types (baseline across major browsers since early 2026) forces typed values into sinks.
**Fix:** `require-trusted-types-for 'script'; trusted-types default app#html;` and emit values via `trustedTypes.createPolicy(...)`.
**Review prompt one-liner:** For any browser app with React/Vue/Svelte server-rendered HTML, require `Trusted Types` enforcement in CSP.
**CWE:** CWE-79.

## Anti-pattern: `Access-Control-Allow-Origin` reflecting `Origin` with credentials
**Detection signal:** `Access-Control-Allow-Origin: <req.headers.origin>` + `Access-Control-Allow-Credentials: true`; or `*` paired with credentials (browser rejects, but reflection is the real bug).
**Verbatim bad example:**
```ts
res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
res.setHeader('Access-Control-Allow-Credentials', 'true');
```
**Why it's wrong:** Any origin (including `https://evil.com`) can issue credentialed cross-site reads, exfiltrating authenticated responses (CSRF read).
**Fix:** Hardcoded allow-list; if multiple origins needed, check `req.headers.origin` against a Set and only then echo. Never combine `*` with `Allow-Credentials`.
**Review prompt one-liner:** Any CORS handler that echoes `Origin` must validate it against a static allow-list before responding, especially when credentials are allowed.
**CWE:** CWE-942, CWE-346.

## Anti-pattern: HSTS without `includeSubDomains` and `preload` (and short max-age)
**Detection signal:** `Strict-Transport-Security: max-age=` < 31536000; missing `includeSubDomains`; missing `preload`.
**Verbatim bad example:**
```ts
res.setHeader('Strict-Transport-Security', 'max-age=3600');
```
**Why it's wrong:** Attacker on hostile network downgrades first visit; one-hour `max-age` expires before user returns.
**Fix:** `max-age=63072000; includeSubDomains; preload` and submit to [hstspreload.org](https://hstspreload.org).
**Review prompt one-liner:** HSTS must have max-age ≥ 1 year, `includeSubDomains`, and `preload` for production HTTPS apps.

## Anti-pattern: Cookies without `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite`
**Detection signal:** `Set-Cookie:` without `Secure`, `HttpOnly`, or `SameSite`; session cookie not using `__Host-` prefix.
**Verbatim bad example:**
```ts
res.cookie('session', token, { httpOnly: true }); // no Secure, no SameSite
```
**Why it's wrong:** Cookie can be set/overwritten by sibling subdomain, sent over HTTP, attached to cross-site POST (CSRF), or read by document.cookie.
**Fix:** `Set-Cookie: __Host-session=...; Secure; HttpOnly; Path=/; SameSite=Lax` (or `Strict` for high-value). `__Host-` enforces no Domain attribute, Path=/, Secure.
**Review prompt one-liner:** Session/auth cookies must use `__Host-` prefix, `Secure`, `HttpOnly`, and explicit `SameSite`.
**CWE:** CWE-1004, CWE-614, CWE-352.

## Anti-pattern: Third-party iframe cookies missing `Partitioned` (CHIPS)
**Detection signal:** Embeddable widget setting cross-site cookie without `Partitioned`.
**Verbatim bad example:**
```ts
res.setHeader('Set-Cookie', '_widget=abc; SameSite=None; Secure');
```
**Why it's wrong:** Chrome 115+ default-blocks unpartitioned third-party cookies; Firefox ETP-Strict partitions all third-party cookies by default; widget breaks silently.
**Fix:** `Set-Cookie: __Host-_widget=abc; SameSite=None; Secure; Partitioned; Path=/`.
**Review prompt one-liner:** Any `SameSite=None` cookie set from an embeddable/iframe context must include `Partitioned`.

## Anti-pattern: Missing COOP/COEP for cross-origin isolation
**Detection signal:** App uses `SharedArrayBuffer`, `performance.now()` high-res timers, or WASM threads but no `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp|credentialless`.
**Why it's wrong:** Spectre side channels are unmitigated; SharedArrayBuffer is silently disabled; tab can be referenced via `window.opener` for tab-nabbing.
**Fix:** `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` (less invasive than `require-corp`), and `Cross-Origin-Resource-Policy: same-origin` on owned assets.
**Review prompt one-liner:** Any app using SAB or precise timers must set COOP `same-origin` + COEP `credentialless` (or `require-corp`).

## Anti-pattern: Referrer-Policy leaking tokens in URL
**Detection signal:** No `Referrer-Policy` header (browser default varies) or `unsafe-url`; password-reset/magic-link URLs containing tokens in query string.
**Verbatim bad example:**
```html
<!-- Reset link: https://app/reset?token=abc123 -->
<!-- No Referrer-Policy → token sent to every third-party asset on the page -->
```
**Why it's wrong:** First page load after click sends the URL (including token) in the `Referer` header to every analytics/CDN/font origin.
**Fix:** `Referrer-Policy: strict-origin-when-cross-origin` globally; move tokens to POST body / fragment / first-party only paths.
**Review prompt one-liner:** Set `Referrer-Policy` explicitly and verify no auth tokens appear in URL query parameters.
**CWE:** CWE-598.

## Anti-pattern: Missing Permissions-Policy lockdown
**Detection signal:** No `Permissions-Policy` header at all.
**Why it's wrong:** Third-party iframes/scripts inherit ability to request camera, microphone, geolocation, payment, USB, serial, bluetooth, browsing-topics, FLoC/interest-cohort. Even denied user prompts are phishing surface.
**Fix:** `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=(), interest-cohort=()` — opt-in only what you use.
**Review prompt one-liner:** Production responses must include a `Permissions-Policy` that denies all sensitive features by default.

## Anti-pattern: Subresource Integrity missing on third-party scripts
**Detection signal:** `<script src="https://cdn.tld/lib.js">` without `integrity=`.
**Verbatim bad example:**
```html
<script src="https://cdn.example.com/widget.js"></script>
```
**Why it's wrong:** CDN compromise / takeover (Polyfill.io 2024) silently injects malicious JS into every visitor.
**Fix:** `<script src="..." integrity="sha384-..." crossorigin="anonymous">` and pin versioned URLs; or self-host.
**Review prompt one-liner:** Every cross-origin `<script>` or `<link rel="stylesheet">` in HTML must carry an `integrity` attribute or be self-hosted.
**CWE:** CWE-353.

## Anti-pattern: X-Frame-Options without CSP `frame-ancestors`
**Detection signal:** Only `X-Frame-Options: DENY` set; no `frame-ancestors` in CSP.
**Why it's wrong:** Modern browsers prefer `frame-ancestors`; some embedding contexts (e.g. PDF viewers, custom UAs) honor only the CSP form. XFO does not support multiple allowed origins.
**Fix:** Set both: `X-Frame-Options: DENY` plus `Content-Security-Policy: frame-ancestors 'none'`.
**Review prompt one-liner:** Verify both XFO and CSP `frame-ancestors` are present and consistent.
**CWE:** CWE-1021.

## Sources
- [MDN — CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
- [MDN — require-trusted-types-for](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for)
- [MDN — CHIPS Partitioned cookies](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies)
- [MDN — Strict-Transport-Security](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security)
- [hstspreload.org](https://hstspreload.org)
