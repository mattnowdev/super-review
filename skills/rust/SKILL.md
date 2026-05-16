---
description: Rust 1.75+ / Edition 2024 anti-patterns reference loaded by super-review:run when the diff touches Rust code. Covers async-trait stable, let-chains, async closures, tokio cancellation safety, error modeling (thiserror/anyhow), borrow vs clone, unsafe discipline, and modern ecosystem (axum, tracing, bytes). Patterns clippy misses. Load when `*.rs` files in diff, or `Cargo.toml` / `Cargo.lock` modified.
---

# Rust review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies Rust code. `cargo clippy -- -W clippy::pedantic` catches the obvious cases — what follows is the residue it misses: invariants the compiler can't see, cancellation hazards, and ecosystem-specific traps.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness** and **Concurrency** reviewer prompts when it detects `*.rs` in the diff or sees `Cargo.toml` / `Cargo.lock` modifications. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: `unwrap()` / `expect("...")` without an invariant comment
**Detection signal:** `.unwrap()` or `.expect("…")` on `Result`/`Option` in non-test code, with no neighboring comment explaining why the variant is unreachable.
**Verbatim bad code:**
```rust
let port = std::env::var("PORT").unwrap().parse::<u16>().unwrap();
```
**Why it's wrong:** Two panics on a code path the reader can't audit. `expect("…")` without a comment tells the runtime what string to print but tells the reviewer nothing about why the panic is impossible.
**Fix:** Justify the invariant in a `// SAFETY:` / `// INVARIANT:` comment, or propagate with `?`:
```rust
// INVARIANT: PORT is validated in main() before any worker spawns.
let port: u16 = std::env::var("PORT").expect("PORT validated in main").parse()?;
```
**Review prompt one-liner:** For every `.unwrap()` / `.expect()` outside of tests, is there a comment above it stating why the error variant is unreachable?

## Anti-pattern: `Clone` overuse where a borrow would do
**Detection signal:** `.to_string()`, `.clone()`, or `.to_owned()` on values that are read once and not stored, especially in function parameters or return paths that already accept `&str` / `&[T]`.
**Verbatim bad code:**
```rust
fn greet(name: &str) -> String {
    let n = name.to_string();   // pointless allocation
    format!("Hi {n}")
}
```
**Why it's wrong:** Each clone is a heap allocation on a hot path; the borrow checker would have accepted the original `&str`. In long pipelines this compounds into measurable latency and GC-style pause patterns (allocator pressure).
**Fix:** Pass borrows; only own when storing or sending across thread boundaries:
```rust
fn greet(name: &str) -> String { format!("Hi {name}") }
```
**Review prompt one-liner:** Does each `.clone()` / `.to_string()` either store the owned value, send it across an `await`/thread boundary, or have a comment explaining why a borrow doesn't suffice?

## Anti-pattern: `Arc<Mutex<T>>` for cross-thread state where a channel or actor fits
**Detection signal:** `Arc<Mutex<...>>` or `Arc<RwLock<...>>` shared across `tokio::spawn` tasks that mostly *mutate* the inner value rather than read it.
**Verbatim bad code:**
```rust
let state = Arc::new(Mutex::new(Vec::new()));
for i in 0..10 {
    let s = state.clone();
    tokio::spawn(async move { s.lock().await.push(i); });
}
```
**Why it's wrong:** Every write contends the lock; lock-across-await risks holding the mutex across a yield point (`std::sync::Mutex` would deadlock; `tokio::sync::Mutex` serializes but kills concurrency). The intent is "send work to one owner" — that's a channel.
**Fix:** Move ownership to a single actor task; send mutations via `tokio::sync::mpsc`:
```rust
let (tx, mut rx) = mpsc::channel::<u32>(32);
tokio::spawn(async move { let mut v = Vec::new(); while let Some(i) = rx.recv().await { v.push(i); } });
```
**Review prompt one-liner:** For each `Arc<Mutex<T>>` shared across tasks, would an mpsc channel + single-owner actor express the access pattern more clearly?

## Anti-pattern: Async cancellation unsoundness — invariants break when the future is dropped mid-await
**Detection signal:** `async fn` that mutates external state in stages with `.await` points between stages, used inside `tokio::select!`, `timeout`, or any caller that may drop the future.
**Verbatim bad code:**
```rust
async fn transfer(from: &mut Account, to: &mut Account, amount: u64) {
    from.balance -= amount;          // step 1
    network_sync().await;            // ← if dropped here, money vanishes
    to.balance += amount;            // step 2 (may never run)
}
```
**Why it's wrong:** Dropping a future at an `.await` point is normal in tokio (`select!` drops the loser; `timeout` drops on elapse). Any function whose intermediate state is observable must be cancel-safe. See [tokio.rs/tokio/topics/shutdown](https://tokio.rs/tokio/topics/shutdown) and the cancellation-safety table in `tokio::select!` docs.
**Fix:** Stage the mutation atomically (commit at the end), use `tokio::spawn` to detach and own completion, or document `// NOT CANCEL-SAFE` and ensure callers never cancel.
**Review prompt one-liner:** For each `async fn` used inside `select!` / `timeout`, is dropping the future at any `.await` point safe — or is there a comment explicitly marking it not-cancel-safe?

## Anti-pattern: Manual `Send` / `Sync` impls without an invariant comment
**Detection signal:** `unsafe impl Send for X {}` or `unsafe impl Sync for X {}` with no comment above.
**Verbatim bad code:**
```rust
struct RawPtrWrapper(*mut u8);
unsafe impl Send for RawPtrWrapper {}
unsafe impl Sync for RawPtrWrapper {}
```
**Why it's wrong:** `Send`/`Sync` are unsafe traits because the compiler trusts you about thread-safety it cannot verify. An undocumented impl is a future-aliasing-UB landmine; the next maintainer has no way to validate the invariant.
**Fix:** Document the invariant precisely (what makes the pointer safe to share — exclusive ownership, immutability, external synchronization), or refactor to use a type that's already `Send`/`Sync` (e.g., `Arc<T>` where `T: Send + Sync`).
**Review prompt one-liner:** Does every `unsafe impl Send` / `unsafe impl Sync` have a `// SAFETY:` comment stating the invariant that makes cross-thread access sound?

## Anti-pattern: `Box<dyn Error>` in library APIs
**Detection signal:** A public function in a `lib.rs` returning `Result<T, Box<dyn Error>>` or `Result<T, Box<dyn Error + Send + Sync>>`.
**Verbatim bad code:**
```rust
pub fn parse_config(s: &str) -> Result<Config, Box<dyn std::error::Error>> { … }
```
**Why it's wrong:** Callers cannot pattern-match on error variants, cannot recover selectively, and cannot map errors to HTTP status codes / metrics. The type erases the only information the API contract owes its consumers. Per [rust-lang.org/error-handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html), libraries owe their callers a typed error.
**Fix:** Define a `thiserror::Error` enum with one variant per failure mode:
```rust
#[derive(thiserror::Error, Debug)]
pub enum ConfigError {
    #[error("missing field: {0}")]
    MissingField(&'static str),
    #[error("invalid TOML: {0}")]
    Toml(#[from] toml::de::Error),
}
```
**Review prompt one-liner:** Does any public library function return `Box<dyn Error>` / `anyhow::Error` instead of a typed error enum that callers can match on?

## Anti-pattern: `#[allow(...)]` without a justification comment
**Detection signal:** `#[allow(dead_code)]`, `#[allow(clippy::…)]`, `#[allow(unused)]` at item or block level with no surrounding `// reason:` comment.
**Verbatim bad code:**
```rust
#[allow(clippy::too_many_arguments)]
fn build_request(a: u32, b: u32, c: u32, d: u32, e: u32, f: u32, g: u32, h: u32) -> Request { … }
```
**Why it's wrong:** `#[allow]` mutes a lint that fired because the code is genuinely outside the norm; without a reason, the next maintainer can't tell if the lint should now apply (e.g., after a refactor).
**Fix:** Use the `reason` field stabilized in Rust 1.81 (`#[allow(clippy::too_many_arguments, reason = "FFI shape mirrors C struct")]`) or add a `// reason:` comment immediately above.
**Review prompt one-liner:** Does every `#[allow(...)]` carry a `reason = "…"` or a comment explaining why the lint is muted here?

## Anti-pattern: `unsafe` block without `// SAFETY:` comment
**Detection signal:** `unsafe { … }` with no `// SAFETY:` line directly above stating the invariants the caller must uphold.
**Verbatim bad code:**
```rust
let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
```
**Why it's wrong:** `unsafe` is a contract; the comment is the contract text. Without it, audits, fuzzing triage, and future refactors cannot prove the call site still satisfies the precondition. The `clippy::undocumented_unsafe_blocks` lint exists for this reason — see [rust-lang.github.io/rust-clippy](https://rust-lang.github.io/rust-clippy/master/index.html#undocumented_unsafe_blocks).
**Fix:**
```rust
// SAFETY: `ptr` is non-null and points to `len` initialized u8s for the lifetime of `buf`.
let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
```
**Review prompt one-liner:** Does every `unsafe { … }` have a `// SAFETY:` comment that names the precondition and explains why this call site satisfies it?

## Anti-pattern: Panicking in library code (`panic!`, `assert!`, indexing, integer overflow)
**Detection signal:** `panic!()`, `unreachable!()`, `todo!()`, `arr[i]`, `slice[range]`, `a / b`, `a - b` in a library crate where `i`/`b`/overflow is caller-controlled.
**Verbatim bad code:**
```rust
pub fn first_word(s: &str) -> &str {
    let bytes = s.as_bytes();
    &s[..bytes.iter().position(|&b| b == b' ').unwrap()] // panics on no-space input
}
```
**Why it's wrong:** Libraries cannot choose their callers; a panic crashes the consumer's process. Indexing, slicing, division, and arithmetic-on-untrusted-input are all panic sources.
**Fix:** Return `Result` / `Option`; use `.checked_*` / `.get(i)` / `.split_once(' ')`:
```rust
pub fn first_word(s: &str) -> Option<&str> { s.split_once(' ').map(|(w, _)| w).or(Some(s)) }
```
**Review prompt one-liner:** Can any public library function panic on caller-controlled input via indexing, arithmetic, `unwrap`, or explicit `panic!` — without that being documented in the function's panic section?

## Anti-pattern: `String` parameter where `impl AsRef<str>` / `&str` accepts more
**Detection signal:** `fn f(name: String)` for a function that reads the string and doesn't store it.
**Verbatim bad code:**
```rust
fn log_event(name: String) { tracing::info!("{name}"); }
log_event("startup".to_string()); // caller forced to allocate
```
**Why it's wrong:** `String` parameter forces every caller to own — even those holding a `&str`, `&String`, or `Cow<'_, str>`. The function reads-only; the borrow is enough.
**Fix:** Accept `&str` for the common case, `impl AsRef<str>` when the function genuinely needs to accept multiple owned/borrowed shapes, or `impl Into<String>` when it *will* store the value.
**Review prompt one-liner:** For each `String` / `Vec<T>` / `PathBuf` parameter, does the function actually store the owned value, or would a borrow / `AsRef` accept more callers without allocation?

## Anti-pattern: `Vec<u8>` on hot path where `Bytes` / `BytesMut` avoids copies
**Detection signal:** `Vec<u8>` in HTTP body handling, message-bus payloads, or any path that does many `.clone()` / slice-and-pass operations on byte buffers.
**Verbatim bad code:**
```rust
fn fan_out(payload: Vec<u8>, subscribers: &[Subscriber]) {
    for s in subscribers { s.send(payload.clone()); } // full copy per subscriber
}
```
**Why it's wrong:** `Vec<u8>::clone()` is `O(n)` allocation+memcpy. The `bytes` crate's [`Bytes`](https://docs.rs/bytes/latest/bytes/struct.Bytes.html) type uses refcounted shared storage; `.clone()` is `O(1)` and zero-copy. Axum, Hyper, Tonic, Tokio-codec all use `Bytes` natively.
**Fix:**
```rust
fn fan_out(payload: bytes::Bytes, subscribers: &[Subscriber]) {
    for s in subscribers { s.send(payload.clone()); } // refcount bump, no copy
}
```
**Review prompt one-liner:** On any byte-buffer hot path with cloning/slicing, is the type `Bytes` / `BytesMut` rather than `Vec<u8>`?

## Anti-pattern: `Result<T, ()>` (use `Option<T>` or a real error)
**Detection signal:** Functions returning `Result<T, ()>` — a `Result` whose error carries zero information.
**Verbatim bad code:**
```rust
fn lookup(id: u32) -> Result<User, ()> { … }
```
**Why it's wrong:** The `Result` shape signals "this can fail and the failure matters" but `()` carries no information about *what* failed. If absence is the only outcome, use `Option<T>`; if there are distinct failures, use a typed error.
**Fix:** `Option<User>` when absent is fine; `Result<User, LookupError>` when failures need diagnosis.
**Review prompt one-liner:** Does any `Result<T, ()>` exist where `Option<T>` (semantic absence) or a typed error (diagnosable failure) would convey more?

## Anti-pattern: `.collect::<Vec<_>>()` then immediate iteration
**Detection signal:** `.collect::<Vec<_>>().iter()` / `.collect::<Vec<_>>().into_iter()` / collecting a chain just to pass it to another iterator consumer in the next line.
**Verbatim bad code:**
```rust
let names: Vec<String> = users.iter().map(|u| u.name.clone()).collect();
for n in &names { println!("{n}"); }
// `names` is never used again
```
**Why it's wrong:** The `Vec` allocation is throwaway; the iterator chain would have streamed the values without heap traffic. On large inputs this doubles memory and adds an alloc/drop cycle.
**Fix:** Drop the `.collect()` and chain directly: `for n in users.iter().map(|u| &u.name) { println!("{n}"); }`. Use `.collect()` only when you need an indexed/owned container.
**Review prompt one-liner:** Does any `.collect::<Vec<_>>()` get re-iterated immediately without being stored, indexed, or returned?

## Anti-pattern: `tokio::spawn` without handling the `JoinHandle`
**Detection signal:** `tokio::spawn(async move { … });` with the returned `JoinHandle` dropped — no `.await`, no storage, no `JoinSet`.
**Verbatim bad code:**
```rust
tokio::spawn(async move { process(item).await });
// JoinHandle dropped → caller can't observe completion, panic, or cancellation
```
**Why it's wrong:** A dropped `JoinHandle` *detaches* the task (it keeps running) but you lose: (a) panic propagation — panics become silent log lines in tokio's worker; (b) backpressure — no way to bound concurrent tasks; (c) graceful shutdown — no way to wait for in-flight work. See [tokio.rs/tokio/topics/shutdown](https://tokio.rs/tokio/topics/shutdown).
**Fix:** Store handles in a `tokio::task::JoinSet`, or `.await` them, or use a bounded `Semaphore` to gate spawns. For fire-and-forget logging tasks, do it explicitly with a `// detached: …` comment.
**Review prompt one-liner:** For each `tokio::spawn(…)`, is the `JoinHandle` stored/awaited/joined — or is there a comment explaining why detach is intentional?

## Anti-pattern: Lifetime elision over-relied on; explicit annotations would document intent
**Detection signal:** Public API with multiple input references and a returned reference, relying on elision rules so the reader has to mentally reconstruct which input the output borrows from.
**Verbatim bad code:**
```rust
pub fn select(haystack: &str, needle: &str, fallback: &str) -> &str { … }
// elision picks haystack's lifetime — caller has to read the body to know
```
**Why it's wrong:** Elision is fine for one-input/one-output; for multi-input APIs it forces the reader (and rustdoc) to guess which input the output's lifetime ties to. Explicit lifetimes are documentation.
**Fix:** Name the tie:
```rust
pub fn select<'h>(haystack: &'h str, needle: &str, fallback: &'h str) -> &'h str { … }
```
**Review prompt one-liner:** For each public function with multiple input references and a returned reference, do explicit lifetimes document which input the output borrows from?

## What good looks like

### Library error with `thiserror`, binary error with `anyhow`
```rust
// lib.rs — typed, matchable, documented
#[derive(thiserror::Error, Debug)]
pub enum ParseError {
    #[error("unexpected eof at byte {0}")]
    UnexpectedEof(usize),
    #[error("invalid utf8: {0}")]
    Utf8(#[from] std::str::Utf8Error),
}

// main.rs — context-rich for humans reading logs
fn main() -> anyhow::Result<()> {
    let cfg = parse_config(&path).with_context(|| format!("loading config from {path:?}"))?;
    Ok(())
}
```
**Why it works:** Libraries owe callers a typed error they can pattern-match; binaries owe operators rich context strings. Mixing the two breaks both contracts. See [docs.rs/thiserror](https://docs.rs/thiserror) and [docs.rs/anyhow](https://docs.rs/anyhow).
**Affirm:** Library crates expose `thiserror` enums; binary entry points wrap with `anyhow::Context`.

### `?` operator with explicit `From` impls
```rust
#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

async fn fetch_and_store(url: &str) -> Result<(), AppError> {
    let body = reqwest::get(url).await?.text().await?;  // ? lifts reqwest::Error
    sqlx::query!("INSERT INTO blobs (body) VALUES ($1)", body).execute(&pool).await?; // ? lifts sqlx::Error
    Ok(())
}
```
**Why it works:** `#[from]` generates the `From` impl; `?` operator delegates conversion. No explicit `.map_err` noise; failure paths are one character.
**Affirm:** Error enums use `#[from]` for converting foreign errors; `?` propagates without `.map_err` boilerplate.

### `tokio::select!` with `biased` for prioritized branches
```rust
loop {
    tokio::select! {
        biased; // poll in declaration order; required when ordering matters
        _ = shutdown.notified() => break,
        Some(req) = rx.recv() => handle(req).await,
    }
}
```
**Why it works:** Default `select!` polls in pseudo-random order to avoid starvation; `biased;` makes shutdown signals always win over work intake, guaranteeing prompt drain. Per [tokio.rs/tokio/tutorial/select](https://tokio.rs/tokio/tutorial/select).
**Affirm:** `tokio::select!` blocks use `biased;` when one branch (shutdown, deadline) must take priority.

### `tracing` over `println!` / `eprintln!`
```rust
#[tracing::instrument(skip(pool), fields(user_id = %user_id))]
async fn lookup_user(pool: &PgPool, user_id: Uuid) -> Result<User, AppError> {
    tracing::debug!("starting lookup");
    sqlx::query_as!(User, "SELECT … WHERE id=$1", user_id).fetch_one(pool).await.map_err(Into::into)
}
```
**Why it works:** Structured fields, span context, filtering by `RUST_LOG`, OTLP export, no allocations when disabled. `println!` blocks on stdout lock and produces unparseable strings.
**Affirm:** Diagnostic output goes through `tracing` macros, not `println!`/`eprintln!`, in any code beyond throwaway examples.

### Newtype pattern for domain IDs
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct UserId(pub Uuid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct OrderId(pub Uuid);

fn charge(user: UserId, order: OrderId) { … }
// charge(order_id, user_id) ← compile error, can't swap
```
**Why it works:** Two `Uuid` parameters can be swapped at the call site; two newtypes cannot. The compiler enforces the domain distinction at zero runtime cost. `#[serde(transparent)]` keeps the wire format unchanged.
**Affirm:** Domain identifiers (user, order, tenant, etc.) are distinct newtypes around their primitive, not bare `Uuid` / `i64` / `String`.

## Sources
- [tokio.rs — graceful shutdown & cancellation safety](https://tokio.rs/tokio/topics/shutdown)
- [tokio.rs — select! tutorial](https://tokio.rs/tokio/tutorial/select)
- [docs.rs/thiserror](https://docs.rs/thiserror/latest/thiserror/)
- [docs.rs/anyhow](https://docs.rs/anyhow/latest/anyhow/)
- [docs.rs/bytes — `Bytes` zero-copy buffers](https://docs.rs/bytes/latest/bytes/struct.Bytes.html)
- [rust-lang.github.io/rust-clippy — undocumented_unsafe_blocks](https://rust-lang.github.io/rust-clippy/master/index.html#undocumented_unsafe_blocks)
- [doc.rust-lang.org — error handling chapter](https://doc.rust-lang.org/book/ch09-00-error-handling.html)
- [Rust Edition 2024 reference — let chains, async closures](https://doc.rust-lang.org/edition-guide/rust-2024/index.html)
