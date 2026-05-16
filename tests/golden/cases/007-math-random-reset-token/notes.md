# Case 007 — password-reset token generated via Math.random

## What this case tests

Cybersec reviewer's ability to spot `Math.random()` used to mint a security-sensitive token (password-reset). This is a textbook **CWE-338 (Use of Cryptographically Weak Pseudo-Random Number Generator)** finding and is exactly the class of bug a senior security reviewer must catch on first glance — no cross-file reasoning required, no clever attack chain to construct, just pattern recognition on the literal call site.

## Why `Math.random` for security tokens is catastrophic

V8's `Math.random` is implemented as **xorshift128+**, a non-cryptographic PRNG. Its internal 128-bit state can be **fully recovered from as few as 3-5 consecutive outputs** using an SMT solver (z3) or published lattice-reduction code. Once the state is recovered, every past *and future* output is predictable.

Practical consequences for a password-reset flow:

1. Attacker requests a reset for their own throwaway account, captures the resulting token.
2. Attacker requests resets for several other throwaway accounts they control to harvest a contiguous run of `Math.random` outputs.
3. Attacker reconstructs PRNG state, predicts the next N tokens.
4. Attacker triggers a reset for the **victim's** account; the token landing in the victim's inbox is now known to the attacker before the email is even delivered.
5. Account takeover, fully silent, no brute force, no rate-limit signal.

Additional aggravating factors specific to this snippet:

- `.toString(36).slice(2)` produces a token of variable length (typically 11-12 chars of `[0-9a-z]`), which is **even weaker than the raw 53 bits** `Math.random` provides — base36 truncation discards entropy and yields tokens an attacker could brute-force online in some cases even without state recovery.
- No TTL on the stored token (the diff persists `resetToken` but not `resetTokenExpiresAt`), so a leaked or predicted token lives forever. This is a secondary finding (FIX-FOLLOWUP), not the headline.

## Correct implementation (what the reviewer should suggest)

`crypto.randomBytes(32).toString("base64url")` — Node's CSPRNG, 256 bits of entropy, URL-safe encoding, no leakage of internal state across calls. Plus a TTL column (`resetTokenExpiresAt`) and single-use semantics (clear on consume).

## Skill aspects exercised

- **Cybersec L5 reviewer**: instant pattern recognition for `Math.random` in a security context — must fire on the literal call, not require chain-of-thought to justify
- **CWE/OWASP fluency**: must cite CWE-338 (weak PRNG) and ideally A02:2021 (Cryptographic Failures)
- **Severity calibration**: this is BLOCK, not FIX-FOLLOWUP. A reviewer that downgrades to "consider using crypto.randomBytes" is failing the calibration test — predictable password-reset tokens are account-takeover-grade
- **Scope discipline**: the `db.user.update(...)` call that stores the token is fine; storage is not the bug, generation is. Reviewer must not invent a "tokens stored in plaintext" finding (they're not credentials at rest, they're short-lived bearer secrets; plaintext storage is conventional for reset tokens, though hashing is a nice-to-have FIX-FOLLOWUP — but not in this case's must-find list)

## Expected severity: BLOCK

Predictable password-reset tokens = silent account takeover for any user the attacker chooses. There is no mitigating factor, no compensating control elsewhere in the diff, and the fix is a one-line swap to `crypto.randomBytes`. This must block merge.
