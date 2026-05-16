---
description: Python 3.12 / 3.13 anti-patterns reference loaded by super-review:run when the diff touches `*.py` files or dependency manifests. Covers mutable defaults, exception hygiene, asyncio pitfalls, dataclass traps, type-hint drift, `pickle`/`eval`/`requests` security, free-threaded build implications, exception groups, PEP 695 type aliases, `@override`, and async generator cancellation in 3.13. Patterns ruff/mypy miss. Load when reviewing `**/*.py` or detecting `pyproject.toml`, `requirements.txt`, or `Pipfile` in the diff.
---

# Python review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies Python sources. `ruff`, `mypy`, `pyright`, and `bandit` catch the structural cases — what follows is the residue they miss, plus the new failure modes introduced in 3.12 (PEP 695, `@override`) and 3.13 (free-threaded build, async generator finalization).

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Correctness**, **Security**, and **Performance** reviewer prompts when it detects `*.py` files in the diff or any of `pyproject.toml` / `requirements.txt` / `Pipfile` modified. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: Mutable default argument
**Detection signal:** `def f(x=[])`, `def f(x={})`, `def f(x=set())`, or any call expression / mutable literal in the default slot of a `def`.
**Verbatim bad code:**
```python
def append_event(event, log=[]):
    log.append(event)
    return log
```
**Why it's wrong:** Defaults are evaluated once at function-definition time, not per call. The same list is shared by every invocation, so the "default" accumulates across unrelated calls and leaks state between tests, requests, and tenants. Documented in the Python tutorial, [Default Argument Values](https://docs.python.org/3/tutorial/controlflow.html#default-argument-values).
**Fix:** Sentinel + construct inside the body: `def append_event(event, log=None): log = [] if log is None else log`.
**Review prompt one-liner:** Does any `def` use a list/dict/set/object literal as a default — and if so, does the body construct a fresh instance per call?

## Anti-pattern: Bare `except:` clause
**Detection signal:** `except:` with no exception type listed (not `except Exception:`).
**Verbatim bad code:**
```python
try:
    run_job()
except:
    log("job failed")
```
**Why it's wrong:** Bare `except` catches `BaseException`, which includes `SystemExit`, `KeyboardInterrupt`, and `GeneratorExit`. Ctrl-C no longer stops the process; `sys.exit()` is silently swallowed; async generator cleanup breaks. See [Python tutorial — Exceptions](https://docs.python.org/3/tutorial/errors.html#handling-exceptions).
**Fix:** `except Exception:` (or, better, narrow to the specific class) and re-raise if you can't recover.
**Review prompt one-liner:** Does every `except` name at least `Exception` (or narrower) so that Ctrl-C and `SystemExit` still propagate?

## Anti-pattern: `except Exception` with no re-raise and no logged traceback
**Detection signal:** `except Exception as e:` whose body is `pass`, `return None`, `return False`, or a `log(str(e))` that drops the traceback.
**Verbatim bad code:**
```python
try:
    data = parse(payload)
except Exception as e:
    logger.info(f"parse failed: {e}")
    data = {}
```
**Why it's wrong:** `str(e)` loses the traceback, the original exception chain, and any `__cause__` context. Postmortem debugging requires reconstructing the failure from log fragments. Production incidents become guesswork.
**Fix:** `logger.exception("parse failed")` (auto-attaches traceback) or `raise CustomError("parse failed") from e` to preserve the chain.
**Review prompt one-liner:** When an `except Exception` is swallowed, does the log call include the traceback (e.g. `logger.exception` or `exc_info=True`)?

## Anti-pattern: `is` for value equality
**Detection signal:** `x is "abc"`, `x is 256`, `x is 1000`, `x is some_string_returned_from_a_function`. Triggers `SyntaxWarning: "is" with a literal` in CPython 3.8+ but warnings get suppressed.
**Verbatim bad code:**
```python
if user.role is "admin":
    grant_access()
```
**Why it's wrong:** `is` tests identity, not equality. Small-int caching (`-5..256`) and string interning make it *sometimes* work in CPython, never on PyPy, and silently break when the literal isn't interned (e.g., strings built at runtime, ints ≥ 257). See [docs.python.org — `is`](https://docs.python.org/3/reference/expressions.html#is).
**Fix:** Use `==` for value comparisons; reserve `is` for `None`, `True`, `False`, and sentinel singletons.
**Review prompt one-liner:** Is every `is` / `is not` comparing against `None`, `True`, `False`, or a module-level sentinel — never a string/int/tuple literal?

## Anti-pattern: Type hint drifts from runtime
**Detection signal:** Function annotated `-> User` actually returns `dict[str, Any]`, `Row`, or `None` on some paths. Static checkers miss this when the body uses `# type: ignore`, `cast()`, dynamic attribute access, or returns from a layer not type-checked.
**Verbatim bad code:**
```python
def load_user(uid: int) -> User:
    row = db.fetchone("SELECT * FROM users WHERE id=?", uid)
    return row  # row is a sqlite3.Row, not a User
```
**Why it's wrong:** Callers code against the annotation. When `row.email` works (Row supports key access) but `row.full_name()` does not, the bug surfaces at a call site far from the lie. With PEP 695 generics, the annotation now flows through more inference paths, amplifying the blast radius.
**Fix:** Construct the typed value (`return User(**row)`); enable `mypy --strict` or `pyright strict`; add a runtime check (`pydantic`, `attrs`, or `assert isinstance`) at the trust boundary.
**Review prompt one-liner:** Does the return value's runtime type match its annotation on every branch, including error paths?

## Anti-pattern: Sync I/O blocking the asyncio event loop
**Detection signal:** Inside an `async def`: `requests.get`, `time.sleep`, `open(...).read()`, `subprocess.run`, `psycopg2`, any sync DB driver, or CPU-bound loops.
**Verbatim bad code:**
```python
async def fetch_user(uid: int) -> dict:
    return requests.get(f"https://api/u/{uid}").json()  # blocks the loop
```
**Why it's wrong:** Blocking the loop stalls every concurrent task — one slow HTTP call freezes the entire server. The loop has no preemption. See [asyncio — Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html#running-blocking-code).
**Fix:** Use an async client (`httpx.AsyncClient`, `aiohttp`, `asyncpg`) or offload: `await asyncio.to_thread(requests.get, url)` for I/O, `loop.run_in_executor(ProcessPoolExecutor(), ...)` for CPU work.
**Review prompt one-liner:** Inside any `async def`, are all I/O calls async-native, or wrapped in `asyncio.to_thread` / `run_in_executor`?

## Anti-pattern: `@dataclass` with mutable default
**Detection signal:** `@dataclass` field declared as `items: list = []` or `cfg: dict = {}`. Python 3.11+ raises `ValueError` at class-creation time for `list`/`dict`/`set`, but custom mutables and `field(default=SomeMutable())` slip past.
**Verbatim bad code:**
```python
@dataclass
class Cart:
    items: list = field(default=[])  # shared across all instances
```
**Why it's wrong:** Same root cause as mutable defaults on functions — every instance shares the same list. Documented in [dataclasses — mutable default values](https://docs.python.org/3/library/dataclasses.html#mutable-default-values).
**Fix:** `items: list[str] = field(default_factory=list)`.
**Review prompt one-liner:** Does every `@dataclass` field with a mutable type use `field(default_factory=...)`, never a literal or shared instance?

## Anti-pattern: Hot-path class without `__slots__`
**Detection signal:** A class instantiated in tight loops or held in collections of >10⁴ instances (records, tokens, AST nodes, graph vertices) declared as a plain class or `@dataclass` without `slots=True`.
**Verbatim bad code:**
```python
@dataclass
class Token:
    kind: str
    value: str
    span: tuple[int, int]
# 10M instances → ~5GB instead of ~1GB
```
**Why it's wrong:** Every instance carries a `__dict__` (~56 bytes minimum on CPython 3.12) and a `__weakref__` slot. For value-object types instantiated en masse, this dwarfs the actual payload.
**Fix:** `@dataclass(slots=True)` (3.10+) or declare `__slots__ = ("kind", "value", "span")` manually. Caveat: breaks multiple-inheritance from non-slotted bases and disables ad-hoc attribute assignment.
**Review prompt one-liner:** For classes instantiated in hot loops or held in large collections, is `slots=True` (or `__slots__`) set?

## Anti-pattern: F-string composes SQL, shell, or HTML from user input
**Detection signal:** `f"SELECT ... {var}"`, `f"... WHERE name = '{name}'"`, `subprocess.run(f"...", shell=True)`, `os.system(f"...")`, any `cursor.execute(f"...")`.
**Verbatim bad code:**
```python
cursor.execute(f"SELECT * FROM events WHERE tenant = '{tenant_id}'")
subprocess.run(f"rm {user_path}", shell=True)
```
**Why it's wrong:** F-strings interpolate without escaping. SQL injection and shell injection are the canonical RCE vectors. Whether `tenant_id` is "trusted" today, the function will be called from a new caller tomorrow.
**Fix:** Parameterized queries (`cursor.execute("... WHERE tenant = ?", (tenant_id,))`); `subprocess.run([cmd, arg], shell=False)`. For identifiers (table/column names that can't be parameter-bound), maintain an allowlist.
**Review prompt one-liner:** Does any f-string compose SQL, a shell command, an HTML fragment, or a file path from a variable that could originate from a request?

## Anti-pattern: `print()` used as logging in a long-running process
**Detection signal:** Production code path (not a CLI's final output) contains `print(...)` for diagnostics — server, worker, daemon, scheduled job.
**Verbatim bad code:**
```python
def handle_request(req):
    print(f"got request from {req.user}")  # no level, no timestamp, no fields
    ...
```
**Why it's wrong:** `print` writes to stdout with no level, no timestamp, no structured fields, no correlation ID. Can't filter by severity, can't route errors to alerting, can't disable in tests. Also bypasses `logging` handlers that ship to your aggregator.
**Fix:** Module-level `logger = logging.getLogger(__name__)`; `logger.info("got request", extra={"user_id": req.user.id, "trace_id": req.trace_id})`. See [logging HOWTO](https://docs.python.org/3/howto/logging.html).
**Review prompt one-liner:** Are diagnostics in long-running code paths emitted via `logging` (with level + structured fields), not `print`?

## Anti-pattern: `pickle.loads` on untrusted bytes
**Detection signal:** `pickle.loads`, `pickle.load`, `dill.loads`, `shelve.open`, `joblib.load` called on data that crossed a trust boundary (HTTP body, message queue, file uploaded by a user, cache populated by another tenant).
**Verbatim bad code:**
```python
@app.post("/import")
def import_state(req):
    return pickle.loads(req.body)  # RCE — pickle executes __reduce__
```
**Why it's wrong:** Pickle's wire format includes opcodes that invoke arbitrary callables (`__reduce__`, `REDUCE`, `GLOBAL`). A crafted payload runs arbitrary Python on deserialization. The [pickle module docs](https://docs.python.org/3/library/pickle.html) state at the top: "Never unpickle data received from an untrusted or unauthenticated source."
**Fix:** JSON / msgpack / Protobuf for cross-boundary state. If you truly need pickle (e.g., scikit-learn models), sign the bytes (HMAC) and verify before `loads`.
**Review prompt one-liner:** Does every `pickle.loads` / `joblib.load` consume bytes that originated inside the same trust boundary, or are they HMAC-verified first?

## Anti-pattern: `requests` / `httpx` call with no timeout
**Detection signal:** `requests.get(url)`, `requests.post(url, json=...)`, `httpx.get(url)` with no `timeout=` kwarg.
**Verbatim bad code:**
```python
resp = requests.get(f"https://internal/api/{thing}")  # default: no timeout, blocks forever
```
**Why it's wrong:** Per [requests Advanced — Timeouts](https://requests.readthedocs.io/en/latest/user/advanced/#timeouts), the default timeout is `None` — the call blocks until the OS-level TCP timeout (minutes) or forever if the peer dribbles bytes. One slow upstream stalls workers, exhausts thread/connection pools, and cascades into a queue overflow.
**Fix:** `requests.get(url, timeout=(3.05, 10))` (connect, read). For `httpx`, `httpx.get(url, timeout=10.0)`. Set a default at the session level.
**Review prompt one-liner:** Does every outbound HTTP call pass an explicit `timeout=`, or use a session with a default timeout configured?

## Anti-pattern: `eval` / `exec` on input that can be influenced
**Detection signal:** `eval(...)`, `exec(...)`, `compile(...)` whose argument is built from a request, file, env var, or DB row.
**Verbatim bad code:**
```python
formula = request.json["formula"]
result = eval(formula, {"__builtins__": {}})  # sandbox is not a sandbox
```
**Why it's wrong:** Even with `__builtins__` stripped, attackers reach arbitrary code via attribute walks (`().__class__.__base__.__subclasses__()...`). No safe in-process Python sandbox exists. See [Eval really is dangerous (Ned Batchelder)](https://nedbatchelder.com/blog/201206/eval_really_is_dangerous.html) — still definitive.
**Fix:** Parse the input with a real grammar (`ast.parse` + walk an allowlist), use a math expression library (`asteval`, `simpleeval`), or run untrusted code in a separate process with OS-level isolation (gVisor, Firecracker, WASM).
**Review prompt one-liner:** Does any `eval` / `exec` / `compile` operate on a string that can be influenced by anything outside the source repo?

## Anti-pattern: Public module with no `__all__`
**Detection signal:** A module imported widely (`from mypkg.utils import *` anywhere, or treated as a public API surface) with no top-level `__all__` list.
**Verbatim bad code:**
```python
# mypkg/utils.py
import os, sys, json
from .internal import _legacy_hack
def helper(): ...
# no __all__ → `from utils import *` pulls os, sys, json, _legacy_hack, helper
```
**Why it's wrong:** Without `__all__`, `from mod import *` pulls every public name including transitive imports. Refactoring a dependency removes a name from your module's surface. Linters (`F403`, `F405`) catch the import but not the export.
**Fix:** Declare `__all__ = ["helper"]`. Even when nobody does `import *`, `__all__` documents the contract and feeds Sphinx, IDE auto-import, and re-export tooling.
**Review prompt one-liner:** For modules that form a package's public surface, is `__all__` declared and limited to the intended exports?

## Anti-pattern: Async generator that doesn't unwind cleanly under cancellation (3.13 hardening)
**Detection signal:** `async def` with `yield`, where the body holds a resource (`async with`, `try/finally`) and the consumer may stop iterating early (`break`, exception, `asyncio.timeout` firing).
**Verbatim bad code:**
```python
async def stream_rows(conn):
    async with conn.transaction():
        async for row in conn.cursor("SELECT ..."):
            yield row  # if consumer breaks, GC-driven aclose may run on wrong loop
```
**Why it's wrong:** Python 3.13 tightened async generator finalization: a generator GC'd outside its originating event loop now raises rather than silently leaking the resource. Code that "worked" on 3.11 by accident now surfaces `RuntimeError: async generator ignored GeneratorExit` or leaks the transaction. See [What's New in Python 3.13 — asyncio](https://docs.python.org/3/whatsnew/3.13.html) and [PEP 533 / asyncgens](https://docs.python.org/3/reference/datamodel.html#asynchronous-generator-iterator-methods).
**Fix:** Wrap consumers in `async with aclosing(stream_rows(conn)) as it:` (from `contextlib`), or restructure so the resource lifetime is managed by the caller, not the generator.
**Review prompt one-liner:** Does every async generator that holds a resource get consumed under `aclosing(...)`, or have its lifetime explicitly bound to a task that handles cancellation?

---

## What good looks like

### PEP 695 type alias + `@override` (3.12+)
```python
from typing import override

type UserId = int  # PEP 695 — lazy-evaluated, no `from __future__ import annotations` needed

class AdminUser(User):
    @override
    def display_name(self) -> str:
        return f"[admin] {self.name}"
```
**Why it works:** [PEP 695](https://peps.python.org/pep-0695/) type aliases are lazy and visible to runtime introspection without quoting. `@override` (PEP 698, [typing.override](https://docs.python.org/3/library/typing.html#typing.override)) makes the type checker fail the build if the parent method is renamed or removed — catches a class of silent-override bugs.
**Affirm:** Subclass methods that intend to override declare `@override`; type aliases use `type X = ...` syntax in 3.12+ code.

### Frozen, slotted value object
```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Money:
    amount: int  # cents
    currency: str
```
**Why it works:** `frozen=True` blocks mutation (instances become hashable, safe as dict keys / set members); `slots=True` removes the `__dict__` overhead. Value semantics enforced by the type, not by convention.
**Affirm:** Domain value objects (Money, Coordinate, EventId) are `frozen=True, slots=True` dataclasses.

### `match` statement with type narrowing on a tagged union
```python
type Event = LoginEvent | LogoutEvent | PurchaseEvent

def handle(e: Event) -> None:
    match e:
        case LoginEvent(user_id=uid):
            audit.login(uid)
        case PurchaseEvent(user_id=uid, amount=amt) if amt > 100_00:
            audit.large_purchase(uid, amt)
        case PurchaseEvent(user_id=uid, amount=amt):
            audit.purchase(uid, amt)
        case LogoutEvent(user_id=uid):
            audit.logout(uid)
```
**Why it works:** [PEP 634 structural pattern matching](https://peps.python.org/pep-0634/) gives the type checker exhaustiveness data; add `case _: typing.assert_never(e)` and `mypy`/`pyright` will flag any new variant that's not handled.
**Affirm:** Sum types are dispatched with `match` + `assert_never` exhaustiveness, not `isinstance` chains.

### `pathlib.Path` over `os.path`
```python
from pathlib import Path

config = Path(__file__).parent / "config" / "app.toml"
if config.exists():
    text = config.read_text(encoding="utf-8")
```
**Why it works:** Cross-platform separators, chainable `/`, typed methods (`read_text`, `glob`, `with_suffix`), and `Path` objects can be passed to `open()`, `shutil.*`, `subprocess.*`. [pathlib docs](https://docs.python.org/3/library/pathlib.html).
**Affirm:** New filesystem code uses `pathlib.Path`; `os.path.join` only appears where a third-party API insists on strings.

### `asyncio.timeout` over `wait_for` (3.11+)
```python
import asyncio

async def fetch_with_budget(url: str) -> bytes:
    async with asyncio.timeout(5.0):
        async with httpx.AsyncClient() as client:
            r = await client.get(url)
            return r.content
```
**Why it works:** [`asyncio.timeout`](https://docs.python.org/3/library/asyncio-task.html#asyncio.timeout) (3.11+) is a context manager that cancels everything inside the block on expiry, including the cleanup path of the `async with httpx.AsyncClient`. `asyncio.wait_for` cancels only the awaited coroutine and races with cleanup, producing leaked sockets.
**Affirm:** Time budgets on async work use `async with asyncio.timeout(...)`, not `wait_for`.

---

## 3.13 free-threaded build note

Python 3.13 ships an experimental free-threaded build (PEP 703, no-GIL) — see [What's New in Python 3.13](https://docs.python.org/3/whatsnew/3.13.html#free-threaded-cpython). Code that "happened to be safe" under the GIL (single-step bytecode atomicity for `dict.setdefault`, `list.append`) is no longer safe when run on the free-threaded interpreter. If the project pins `python-version = "3.13t"` or the CI matrix includes it, raise the bar on shared-state mutation: use `threading.Lock`, `queue.Queue`, or per-thread instances. Most projects will not run on the free-threaded build yet — flag only when the manifest opts in.

## Sources
- [Python tutorial — Default Argument Values](https://docs.python.org/3/tutorial/controlflow.html#default-argument-values)
- [Python tutorial — Handling Exceptions](https://docs.python.org/3/tutorial/errors.html#handling-exceptions)
- [dataclasses — mutable default values](https://docs.python.org/3/library/dataclasses.html#mutable-default-values)
- [asyncio — Developing with asyncio](https://docs.python.org/3/library/asyncio-dev.html#running-blocking-code)
- [asyncio.timeout (3.11+)](https://docs.python.org/3/library/asyncio-task.html#asyncio.timeout)
- [pickle — security warning](https://docs.python.org/3/library/pickle.html)
- [logging HOWTO](https://docs.python.org/3/howto/logging.html)
- [pathlib](https://docs.python.org/3/library/pathlib.html)
- [What's New in Python 3.12 — PEP 695, PEP 698](https://docs.python.org/3/whatsnew/3.12.html)
- [What's New in Python 3.13 — async generators, free-threaded build](https://docs.python.org/3/whatsnew/3.13.html)
- [PEP 695 — Type Parameter Syntax](https://peps.python.org/pep-0695/)
- [PEP 698 — Override Decorator for Static Typing](https://peps.python.org/pep-0698/)
- [PEP 654 — Exception Groups and `except*`](https://peps.python.org/pep-0654/)
- [requests — Timeouts](https://requests.readthedocs.io/en/latest/user/advanced/#timeouts)
