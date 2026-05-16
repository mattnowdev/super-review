# Case 001 — share-link bearer tokens leak to access logs

## What this case tests

Cybersec reviewer's ability to detect that a new `onRequest` access-log hook (PR-introduced) emits `request.url` raw, and that a sibling route file registers token-bearing paths like `/share-links/:token/preview`. Combining "this file logs the URL" + "this file registers tokens in URL paths" requires the reviewer to cross-reference two files in the diff.

Derived from the real finding on `aleksanderkaminski/Vellam#82` (super-review caught this on its second pass; we want the harness to confirm it stays caught).

## Skill aspects exercised

- **Cybersec L5 reviewer**: pattern recognition for OWASP A09 (logging failures) + CWE-532 (information exposure through log files)
- **Cross-file reasoning**: must connect the URL-logging hook to the share-link route definitions
- **Scope discipline**: the `sanitizeUrl` function in errorHandler.ts is pre-existing and works correctly; reviewer must NOT flag it as broken, only note it doesn't apply at the access-log boundary

## Expected severity: 🔴 BLOCK

Bearer tokens in plaintext logs is a credential-disclosure bug. Anyone with log read access (Datadog, Sentry, BetterStack, ops, third-party log SaaS) can hijack any unaccepted share link.
