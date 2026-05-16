---
description: Go 1.22+/1.23/1.24 anti-patterns reference loaded by super-review:run when the diff touches Go files. Covers goroutine leaks, context propagation, nil-interface traps, error-wrapping, defer-in-loop, range-over-func, weak pointers, and the per-iteration loop variable change. Load when `*.go` files in diff, or `go.mod` / `go.sum` modified.
---

# Go review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies Go code. `go vet`, `staticcheck`, and `golangci-lint` catch the obvious cases — what follows is the residue they miss, plus the version-specific traps from Go 1.22's loop-variable change, Go 1.23's range-over-func, and Go 1.24's `weak` package and `tool` directive.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness** and **Concurrency** reviewer prompts when it detects `*.go` files in the diff or sees `go.mod`/`go.sum` modified. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: Goroutine leak — `go fn()` without context-driven shutdown
**Detection signal:** `go func() { ... }()` or `go someFn()` where the goroutine's loop has no `select` on `ctx.Done()` and no other termination signal; especially in HTTP handlers, background pollers, or `init()`.
**Verbatim bad code:**
```go
func StartPoller() {
    go func() {
        for {
            poll()
            time.Sleep(5 * time.Second)
        }
    }()
}
```
**Why it's wrong:** Goroutine outlives any reasonable lifecycle (request, test, server shutdown). Tests accumulate them; `go test -count=100` OOMs. Server shutdown blocks forever or drops in-flight work.
**Fix:** Accept a `context.Context`, `select` on `ctx.Done()`, and have the caller cancel:
```go
func StartPoller(ctx context.Context) {
    go func() {
        t := time.NewTicker(5 * time.Second)
        defer t.Stop()
        for {
            select {
            case <-ctx.Done(): return
            case <-t.C: poll()
            }
        }
    }()
}
```
**Review prompt one-liner:** For every `go` statement, can the goroutine observe a cancellation signal (context, quit channel, or bounded work) — and who owns calling it?

## Anti-pattern: Missing `context.Context` propagation through call chain
**Detection signal:** A function that performs I/O (DB query, HTTP call, file op) takes no `ctx context.Context`, or accepts one but calls `context.Background()` / `context.TODO()` internally instead of forwarding it.
**Verbatim bad code:**
```go
func (s *Service) GetUser(id string) (*User, error) {
    return s.db.QueryRowContext(context.Background(), "SELECT ...", id) // ignores caller deadline
}
```
**Why it's wrong:** Caller's timeout/cancellation can't reach the DB driver; a slow query blocks past the HTTP request's deadline; resources leak. Per pkg.go.dev/context, `Background` is "the root … should not be passed to a function expecting a Context."
**Fix:** Thread `ctx` as the first parameter end-to-end. Reserve `context.TODO()` for genuinely unplumbed call sites that need refactor.
**Review prompt one-liner:** Does every function performing I/O accept `ctx context.Context` as its first arg and forward it (not replace it with `Background`/`TODO`)?

## Anti-pattern: `ctx.Done()` not checked in select loops
**Detection signal:** `for { select { case x := <-ch: ... } }` with no `case <-ctx.Done():` arm, inside a function that received a context.
**Verbatim bad code:**
```go
func consume(ctx context.Context, ch <-chan Job) {
    for {
        select {
        case j := <-ch:
            j.Run()
        }
    }
}
```
**Why it's wrong:** `ctx` is accepted but never observed; cancellation never unblocks the loop. The reviewer's eye sees "context plumbed" and misses that it's load-bearing nowhere.
**Fix:** Add `case <-ctx.Done(): return ctx.Err()`. If you also want graceful drain, range the channel after close instead of `for{select}`.
**Review prompt one-liner:** In every `for { select { ... } }`, is there a `case <-ctx.Done():` arm — or a justification why this loop is unstoppable?

## Anti-pattern: Channel direction misuse
**Detection signal:** Function signature declares `ch chan<- T` (send-only) but body attempts `<-ch`; or `chan<- T` returned where `<-chan T` was intended (caller can send into what should be read-only).
**Verbatim bad code:**
```go
func emit(ch chan<- int) {
    v := <-ch        // compile error if same scope; runtime panic if reflect-based
    ch <- v * 2
}
```
**Why it's wrong:** Compiles cleanly when the typed channel is bridged through `interface{}`/`reflect`; panics at runtime. More commonly: returning `chan T` (bidirectional) when the API contract is consumer-only — caller closes it from outside and your producer panics on send to closed channel.
**Fix:** Return `<-chan T` from producer constructors; accept `chan<- T` in consumer-fed funcs. Close from the **sender** side only.
**Review prompt one-liner:** Does each channel field/parameter have the narrowest direction (`<-chan` / `chan<-`) the API requires, and is the close-side documented?

## Anti-pattern: Nil interface vs nil concrete (typed-nil error)
**Detection signal:** `var e *MyErr; ... return e` where `MyErr` is a custom error type and the caller checks `if err != nil`.
**Verbatim bad code:**
```go
type MyErr struct{ msg string }
func (e *MyErr) Error() string { return e.msg }

func find() error {
    var e *MyErr // nil pointer
    if cond { e = &MyErr{"x"} }
    return e // even when nil, returned interface has type=*MyErr, value=nil → not nil interface
}

if err := find(); err != nil { panic("triggered even when no error") }
```
**Why it's wrong:** Per go.dev/doc/faq#nil_error, an interface is nil only when both its type and value are nil. Returning a typed nil pointer gives a non-nil interface; every caller's `err != nil` check is silently broken.
**Fix:** Return `error` typed `nil` literal explicitly:
```go
if e == nil { return nil }
return e
```
**Review prompt one-liner:** Does any function returning `error` ever `return` a concretely-typed pointer/value variable instead of the literal `nil`?

## Anti-pattern: Error wrapping without `%w` verb
**Detection signal:** `fmt.Errorf("doing X: %v", err)` or `fmt.Errorf("doing X: %s", err.Error())` where the caller (or eventual caller) wants `errors.Is(target)` / `errors.As(&target)` to traverse the chain.
**Verbatim bad code:**
```go
if err := db.QueryRow(...).Scan(&x); err != nil {
    return fmt.Errorf("lookup user: %v", err) // loses sql.ErrNoRows identity
}
```
**Why it's wrong:** Per pkg.go.dev/errors, only `%w` preserves the wrapped chain. `%v` formats to string and discards the type, so `errors.Is(returned, sql.ErrNoRows)` returns false and the caller writes the wrong recovery branch.
**Fix:** Use `%w`:
```go
return fmt.Errorf("lookup user: %w", err)
```
Use `errors.Join(err1, err2)` (Go 1.20+) when wrapping multiple causes.
**Review prompt one-liner:** Does every `fmt.Errorf` that includes an underlying error use `%w` (not `%v` or `%s`)?

## Anti-pattern: `defer` inside a loop
**Detection signal:** `for { ... defer f.Close() ... }` — typical with `defer rows.Close()`, `defer resp.Body.Close()`, `defer mu.Unlock()` inside a `for _, x := range items` loop.
**Verbatim bad code:**
```go
for _, path := range paths {
    f, err := os.Open(path)
    if err != nil { return err }
    defer f.Close() // runs at function return, NOT loop iteration
    process(f)
}
```
**Why it's wrong:** Defers accumulate on the function's stack until return. With N=10000 paths you hold 10000 open file descriptors → `too many open files`. Same trap with HTTP response bodies, DB rows, mutex unlocks.
**Fix:** Extract the loop body to a function so each iteration has its own `defer` scope, or call `f.Close()` explicitly before the next iteration:
```go
for _, path := range paths {
    if err := processOne(path); err != nil { return err }
}
func processOne(path string) error {
    f, err := os.Open(path); if err != nil { return err }
    defer f.Close()
    return process(f)
}
```
**Review prompt one-liner:** Is any `defer` inside a `for` loop — and if so, will the loop body run more than a handful of times?

## Anti-pattern: `sync.Pool` for objects with internal state
**Detection signal:** `pool.Get().(*Buffer)` returned to caller without `buf.Reset()`; or pooled struct contains slices/maps/embedded objects with state that survives the pool round-trip.
**Verbatim bad code:**
```go
var pool = sync.Pool{New: func() any { return &bytes.Buffer{} }}

func Render(w io.Writer, x Data) {
    buf := pool.Get().(*bytes.Buffer) // still holds previous render's bytes
    defer pool.Put(buf)
    template.Execute(buf, x)
    w.Write(buf.Bytes()) // emits leftover prefix from prior caller
}
```
**Why it's wrong:** `sync.Pool` makes no guarantees about object state. Per pkg.go.dev/sync#Pool, "any item stored in the Pool may be removed automatically at any time without notification" — and the converse: an item *not* removed retains whatever state it had when `Put`. Bug surfaces as cross-request data leak under load.
**Fix:** Reset on either `Get` or `Put` (pick one and document):
```go
buf := pool.Get().(*bytes.Buffer)
buf.Reset()
defer pool.Put(buf)
```
**Review prompt one-liner:** For every `pool.Get`, is the returned object explicitly reset to a clean state before use?

## Anti-pattern: Struct field tag typo (space after comma)
**Detection signal:** `json:"foo, omitempty"`, `json:"foo ,omitempty"`, or any tag with whitespace inside the value — encoding/json silently treats this as a single option named `" omitempty"` which matches nothing.
**Verbatim bad code:**
```go
type User struct {
    Email string `json:"email, omitempty"` // space → omitempty IGNORED
}
```
**Why it's wrong:** `encoding/json` parses tag options by comma split with no trimming; ` omitempty` ≠ `omitempty`. Empty emails serialize as `"email":""` instead of being omitted. No compile error, no lint warning by default.
**Fix:** Remove the space: `json:"email,omitempty"`. Enable `golangci-lint`'s `tagliatelle` or `govet`'s `structtag` check.
**Review prompt one-liner:** Does every struct tag option (`omitempty`, `string`, etc.) sit flush against its comma with no whitespace?

## Anti-pattern: Type assertion without `, ok` form
**Detection signal:** `x := y.(*T)` or `s := iface.(string)` — single-value assertion that panics on type mismatch.
**Verbatim bad code:**
```go
func handle(payload any) {
    msg := payload.(*Message) // panic if caller passes anything else
    process(msg)
}
```
**Why it's wrong:** Single-value form panics with `interface conversion: ... is not *Message`. In an HTTP handler this crashes the goroutine; with `recover` middleware it returns 500; without, the process dies (or net/http's per-handler recover catches it but logs noisily).
**Fix:** Use comma-ok and branch:
```go
msg, ok := payload.(*Message)
if !ok { return fmt.Errorf("expected *Message, got %T", payload) }
```
Or use a type switch when handling multiple shapes.
**Review prompt one-liner:** Is every type assertion either in `, ok` form, inside a type switch, or in a code path where the type is provably guaranteed?

## Anti-pattern: Ignored errors via blank identifier
**Detection signal:** `_ = doThing()`, `_, _ = fmt.Fprintln(w, ...)`, `defer f.Close()` (Close error discarded) on writeable resources.
**Verbatim bad code:**
```go
func save(path string, data []byte) {
    f, _ := os.Create(path) // first error swallowed
    defer f.Close()         // Close error on a write file is REAL (flush failure)
    f.Write(data)           // write error ignored
}
```
**Why it's wrong:** `Close()` on a writeable file flushes — its error reports disk-full / quota / network FS failures. `Write` errors mean partial data. Blank-discarding hides production failures that look identical to success in logs.
**Fix:** Handle every error explicitly. For deferred close on writers, capture and combine:
```go
defer func() { if cerr := f.Close(); cerr != nil && err == nil { err = cerr } }()
```
Enable `errcheck` in golangci-lint.
**Review prompt one-liner:** Is every `_ = ...` of an error-returning call justified by a comment explaining why this error is provably uninteresting?

## Anti-pattern: Concurrent map read+write without sync
**Detection signal:** A `map[K]V` field on a struct mutated from one goroutine and read from another with no `sync.Mutex`/`sync.RWMutex`/`sync.Map`.
**Verbatim bad code:**
```go
type Cache struct{ m map[string]string }
func (c *Cache) Set(k, v string) { c.m[k] = v }
func (c *Cache) Get(k string) string { return c.m[k] }
// called from multiple goroutines without locks → fatal: concurrent map writes
```
**Why it's wrong:** Go's runtime detects most concurrent map writes and *crashes the entire process* with `fatal error: concurrent map writes`. Reviewers gloss past it because `go test` (without `-race`) sometimes doesn't trigger it; CI without `-race` ships the bug.
**Fix:** Wrap with `sync.RWMutex`, use `sync.Map` for write-heavy disjoint-key workloads, or replace with a sharded map. Always run `go test -race` in CI.
**Review prompt one-liner:** For every map accessed from more than one goroutine, is access guarded by a mutex or replaced with `sync.Map`?

## Anti-pattern: Returning unbuffered channel from constructor
**Detection signal:** `func New() (<-chan Event, error) { ch := make(chan Event); go produce(ch); return ch, nil }` — producer assumes caller will receive promptly.
**Verbatim bad code:**
```go
func Subscribe() <-chan Event {
    ch := make(chan Event) // unbuffered
    go func() {
        for ev := range source {
            ch <- ev // blocks forever if caller doesn't range fast enough or returns early
        }
    }()
    return ch
}
```
**Why it's wrong:** If the caller takes one event and returns, the producer goroutine blocks on the next send forever — leaked goroutine plus the upstream `source` stops progressing. Symptom appears later as "the system stalls after N events."
**Fix:** Use a buffered channel sized to your back-pressure tolerance AND a context for shutdown:
```go
func Subscribe(ctx context.Context) <-chan Event {
    ch := make(chan Event, 64)
    go func() {
        defer close(ch)
        for ev := range source {
            select { case ch <- ev: case <-ctx.Done(): return }
        }
    }()
    return ch
}
```
**Review prompt one-liner:** Does every channel returned from a constructor have either a buffer + context-driven shutdown, or a documented contract that the caller MUST drain it?

## Anti-pattern: Assuming map iteration order
**Detection signal:** `for k, v := range m { ... }` where the loop builds a list later compared in a test, written to a deterministic log format, or used to compute a hash/signature.
**Verbatim bad code:**
```go
var sig string
for k, v := range params {
    sig += k + "=" + v + "&" // signing key — must be deterministic
}
hash := sha256.Sum256([]byte(sig))
```
**Why it's wrong:** Per go.dev/ref/spec#For_statements, map iteration order is "not specified and is not guaranteed to be the same from one iteration to the next." Signature is non-deterministic; two runs disagree; downstream verification randomly fails.
**Fix:** Extract keys, sort, then iterate:
```go
keys := make([]string, 0, len(params))
for k := range params { keys = append(keys, k) }
sort.Strings(keys)
for _, k := range keys { sig += k + "=" + params[k] + "&" }
```
**Review prompt one-liner:** Does any `range` over a map produce output (logs, hashes, serialized payloads, test fixtures) whose order matters?

## Anti-pattern: Pre-1.22 loop variable capture (if `go.mod` targets <1.22)
**Detection signal:** `for _, x := range xs { go func() { use(x) }() }` in a module whose `go.mod` says `go 1.21` or older.
**Verbatim bad code:**
```go
// go.mod: go 1.21
for _, item := range items {
    go func() {
        process(item) // all goroutines see the LAST item
    }()
}
```
**Why it's wrong:** Pre-1.22, `item` is a single variable reused across iterations; the goroutine closure captures the variable, not its value. Per go.dev/blog/loopvar-preview, Go 1.22 changed this to per-iteration scoping — but only when `go.mod` declares `go 1.22` or higher. A module on `go 1.21` still has the old semantics even when built with Go 1.24.
**Fix:** Either bump `go.mod`'s `go` directive to `1.22+` (preferred — fixes all loops at once), or shadow per iteration:
```go
for _, item := range items {
    item := item // shadow
    go func() { process(item) }()
}
```
Equivalently pass as parameter: `go func(it Item) { process(it) }(item)`.
**Review prompt one-liner:** What `go` directive does `go.mod` declare — and if <1.22, does any loop body capture the loop variable in a closure/goroutine/defer?

## Anti-pattern: `range`-over-func iterator that doesn't honor `yield` returning false
**Detection signal:** Go 1.23+ custom iterator `func(yield func(T) bool)` where the body ignores `yield`'s return value and keeps yielding (or doing cleanup) past consumer break.
**Verbatim bad code:**
```go
// Go 1.23+ range-over-func
func All(items []Item) func(yield func(Item) bool) {
    return func(yield func(Item) bool) {
        for _, it := range items {
            yield(it) // ignores return; consumer's `break` doesn't stop iteration
        }
    }
}
```
**Why it's wrong:** Per go.dev/blog/range-functions (Go 1.23), `yield` returns `false` when the consumer breaks; the iterator must return promptly so any held resources release. Ignoring it means `break` inside `for x := range All(items)` doesn't actually stop work — wasted CPU, leaked connections if the iterator owns a DB cursor.
**Fix:** Check `yield`'s return and bail:
```go
for _, it := range items {
    if !yield(it) { return }
}
```
**Review prompt one-liner:** For every custom iterator (`func(yield func(T) bool)`), does the body return as soon as `yield` returns `false`?

---

## What good looks like

### Goroutine with context-driven shutdown + waitgroup
```go
func Run(ctx context.Context, wg *sync.WaitGroup) {
    wg.Add(1)
    go func() {
        defer wg.Done()
        t := time.NewTicker(time.Second); defer t.Stop()
        for {
            select {
            case <-ctx.Done(): return
            case <-t.C: tick()
            }
        }
    }()
}
```
**Why it works:** Cancellation unblocks the loop; `WaitGroup` lets the caller observe shutdown completion; ticker is stopped.
**Affirm:** Every goroutine has an owner that holds a `context.CancelFunc` and a way to wait for it to exit.

### Error chain with `%w`, `errors.Is`, `errors.As`
```go
var ErrNotFound = errors.New("not found")

func GetUser(ctx context.Context, id string) (*User, error) {
    u, err := db.Lookup(ctx, id)
    if errors.Is(err, sql.ErrNoRows) { return nil, fmt.Errorf("user %s: %w", id, ErrNotFound) }
    if err != nil                    { return nil, fmt.Errorf("lookup %s: %w", id, err) }
    return u, nil
}
// caller:
if errors.Is(err, ErrNotFound) { return http.StatusNotFound }
```
**Why it works:** Sentinels are preserved through wrapping; HTTP layer pattern-matches on domain errors, not strings.
**Affirm:** Domain errors are exported sentinels or typed errors; wrapping uses `%w`; callers branch with `errors.Is` / `errors.As`.

### `context.WithTimeout` at every external call boundary
```go
ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
defer cancel()
resp, err := s.http.Do(req.WithContext(ctx))
```
**Why it works:** Bounded latency per hop; cancellation cascades to subordinate goroutines; no `cancel()` leak.
**Affirm:** Every outbound HTTP/DB/gRPC call wraps its context in `WithTimeout` (or `WithDeadline`) and `defer cancel()`s.

### Functional options
```go
type Server struct{ port int; tls bool }
type Option func(*Server)
func WithPort(p int) Option { return func(s *Server) { s.port = p } }
func WithTLS() Option       { return func(s *Server) { s.tls = true } }

func New(opts ...Option) *Server {
    s := &Server{port: 8080}
    for _, opt := range opts { opt(s) }
    return s
}
```
**Why it works:** Adding a knob is backward compatible; defaults live in one place; callers self-document.
**Affirm:** Constructors with >2 knobs use functional options, not a `Config` struct with growing optional fields.

### Table-driven tests with subtests
```go
func TestParse(t *testing.T) {
    cases := []struct {
        name string
        in   string
        want int
        err  error
    }{
        {"empty", "", 0, ErrEmpty},
        {"happy", "42", 42, nil},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            got, err := Parse(tc.in)
            if !errors.Is(err, tc.err) { t.Fatalf("err=%v want %v", err, tc.err) }
            if got != tc.want          { t.Errorf("got=%d want=%d", got, tc.want) }
        })
    }
}
```
**Why it works:** Each case shows up as a named subtest; `go test -run TestParse/happy` runs one; failure output names the case.
**Affirm:** Multi-case tests use a slice of structs + `t.Run(tc.name, ...)`, not a single function with many assertions.

### `sync.Once` for one-shot initialization
```go
var (
    once   sync.Once
    client *http.Client
)
func Client() *http.Client {
    once.Do(func() { client = &http.Client{Timeout: 5 * time.Second} })
    return client
}
```
**Why it works:** Thread-safe lazy init; no race; cheaper than a mutex on hot reads. Go 1.21+ also offers `sync.OnceFunc` / `sync.OnceValue` / `sync.OnceValues` for typed wrappers.
**Affirm:** Lazy singletons use `sync.Once` (or `OnceValue`), not a `nil`-check + assignment that races.

## Sources
- [go.dev/doc/faq — Why is my nil error value not equal to nil?](https://go.dev/doc/faq#nil_error)
- [pkg.go.dev/context](https://pkg.go.dev/context)
- [pkg.go.dev/errors](https://pkg.go.dev/errors)
- [pkg.go.dev/sync#Pool](https://pkg.go.dev/sync#Pool)
- [go.dev/ref/spec — For statements (map iteration)](https://go.dev/ref/spec#For_statements)
- [go.dev/blog/loopvar-preview — Go 1.22 per-iteration loop variables](https://go.dev/blog/loopvar-preview)
- [go.dev/blog/range-functions — Go 1.23 range-over-func](https://go.dev/blog/range-functions)
- [pkg.go.dev/weak — Go 1.24 weak pointers](https://pkg.go.dev/weak)
- [go.dev/ref/mod#go-mod-file-toolchain — go.mod toolchain directive](https://go.dev/ref/mod#go-mod-file-toolchain)
