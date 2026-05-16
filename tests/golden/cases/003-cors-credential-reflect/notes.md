# Case 003 — CORS reflecting `Origin` with `Allow-Credentials: true`

## What this case tests

Web-headers + Cybersec reviewers' ability to detect a CORS handler that echoes `req.headers.origin` back as `Access-Control-Allow-Origin` AND sets `Access-Control-Allow-Credentials: true`. Any origin (including `https://evil.com`) can now issue credentialed cross-site reads, exfiltrating authenticated responses.

## Skill aspects exercised

- **`super-review:web-headers`** anti-pattern: `Access-Control-Allow-Origin` reflecting `Origin` with credentials
- **`super-review:cybersec`** anti-pattern: cross-origin authz / CSRF-read (CWE-942, CWE-346)
- **Scope discipline**: the `disabledReviewers` config may have `frontend` disabled but cybersec must still fire on backend middleware

## Expected severity: 🔴 BLOCK

Credentialed CORS reflection is a known data-exfil class; rated BLOCK because shipping this means every authenticated user's data can be read by any third-party site they happen to visit.

## Why this is a good test

Tests detection of a security pattern that requires reading TWO header-setting lines together — neither line alone is the bug; the bug is the combination. Single-line pattern matchers miss this.
