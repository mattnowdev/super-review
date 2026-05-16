---
description: Dockerfile + container-image anti-patterns reference loaded by super-review:run when the diff touches container build files. Covers root-user execution, multi-stage hygiene, build-cache layering, secret handling, base-image pinning, and reproducibility. Load when `Dockerfile`, `Dockerfile.*`, `*.dockerfile`, `docker-compose.yml`, or `.dockerignore` appears in diff.
---

# Dockerfile review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies container build files. `hadolint` catches most syntactic issues — what follows is the residue around security posture, image bloat, cache-busting layering, and reproducibility that linters miss or flag too softly to act on.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Security** and **Build/Infra** reviewer prompts when it detects `Dockerfile*`, `*.dockerfile`, `docker-compose.yml`, or `.dockerignore` in the diff. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: No `USER` directive — container runs as root

**Detection signal:** Dockerfile reaches the final `CMD`/`ENTRYPOINT` without a `USER` instruction, or the only `USER` line is `USER root`.
**Verbatim bad code:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci
CMD ["node", "server.js"]
# implicit USER root — container escape == host root
```
**Why it's wrong:** Per the OWASP Docker Security Cheat Sheet (Rule 2), a container escape from a process running as UID 0 maps to UID 0 on the host (absent user namespaces, which are off by default in most Kubernetes setups). Every CVE in the runtime stack becomes one privilege boundary closer to host compromise.
**Fix:** Create a non-root user in an intermediate stage and switch to it before the final `CMD`:
```dockerfile
RUN addgroup -S app && adduser -S -G app -u 10001 app
USER 10001:10001
```
**Review prompt one-liner:** Does the final stage end with a `USER` directive set to a non-zero UID before `CMD`/`ENTRYPOINT`?

## Anti-pattern: Numeric UID missing — `USER appuser` instead of `USER 10001`

**Detection signal:** `USER <name>` where `<name>` is not a number (e.g. `USER node`, `USER app`).
**Verbatim bad code:**
```dockerfile
RUN adduser -D app
USER app
```
**Why it's wrong:** Kubernetes `runAsNonRoot: true` enforcement and PodSecurityPolicy / Pod Security Standards verify by UID, not by name — they cannot resolve `/etc/passwd` inside the image. A `USER app` line passes Dockerfile review but fails admission with `container has runAsNonRoot and image will run as root` if the runtime can't resolve the name to a non-zero UID. Distroless and scratch images have no `/etc/passwd` at all.
**Fix:** Always use a numeric UID:GID pair (`USER 10001:10001`). The `useradd`/`adduser` invocation should explicitly assign UID 10001 (or another non-reserved high number) so it matches.
**Review prompt one-liner:** Is `USER` expressed as a numeric UID:GID pair so it works in distroless images and satisfies `runAsNonRoot` admission?

## Anti-pattern: Single-stage build ships compiler and build tools to production

**Detection signal:** Dockerfile has exactly one `FROM`, the language is compiled (Go, Rust, Java, TypeScript-with-tsc, C/C++), and the final image contains `gcc`, `cargo`, `go`, `mvn`, `npm`, `tsc`, etc.
**Verbatim bad code:**
```dockerfile
FROM golang:1.22
WORKDIR /src
COPY . .
RUN go build -o /app/server ./cmd/server
CMD ["/app/server"]
# Final image: 900 MB, includes Go toolchain, source, .git
```
**Why it's wrong:** Compiler + headers + source tree expand attack surface (Go toolchain CVEs, vulnerable libc in build base), bloat the image 10-50× (Trivy/Grype scans take longer, pull latency grows, registry costs grow), and ship secrets accidentally COPYed during build. Per Docker's [multi-stage builds documentation](https://docs.docker.com/build/building/multi-stage/), the build and runtime stages should be separate.
**Fix:** Multi-stage with distroless or chiseled-ubuntu final stage:
```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
USER 65532:65532
ENTRYPOINT ["/server"]
```
**Review prompt one-liner:** For compiled languages, does the final stage use a minimal runtime image (distroless / chiseled / scratch) with the compiler stage discarded?

## Anti-pattern: `COPY . .` before dependency installation

**Detection signal:** `COPY . .` (or `COPY . /app`) appearing in the Dockerfile *before* the line that installs dependencies (`npm ci`, `pip install`, `go mod download`, `bundle install`).
**Verbatim bad code:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci
CMD ["node", "server.js"]
# Every source-file change invalidates the npm ci layer → 60s rebuild per CI run
```
**Why it's wrong:** Per Docker's [build cache best practices](https://docs.docker.com/build/cache/), each `RUN`/`COPY`/`ADD` produces a layer keyed by the hash of its inputs. `COPY . .` invalidates the cache on *any* source change, so the expensive `npm ci` re-runs on every commit. Compounds to minutes of wasted CI time and bandwidth per push.
**Fix:** Copy the manifest first, install, then copy source:
```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
```
**Review prompt one-liner:** Are dependency manifests copied and installed in their own layer *before* `COPY . .` so dep installation is cached across source-only changes?

## Anti-pattern: `apt-get install` without `--no-install-recommends` + cleanup in same RUN

**Detection signal:** `RUN apt-get install ...` lines that (a) omit `--no-install-recommends`, (b) skip `apt-get update && ... && rm -rf /var/lib/apt/lists/*` chained in a single `RUN`, or (c) split update/install/cleanup across separate `RUN` lines.
**Verbatim bad code:**
```dockerfile
RUN apt-get update
RUN apt-get install -y curl ca-certificates python3
# Recommends pull ~40 extra packages; apt lists stay in /var/lib/apt/lists (~40 MB); separate
# RUN means cleanup is in a different layer than the install — bloat persists.
```
**Why it's wrong:** Recommended packages add 30-100 MB of unused software (more CVEs to track). `/var/lib/apt/lists/*` adds 30-50 MB of metadata. Because layers are stacked, `rm` in a later `RUN` does *not* shrink earlier layers — the size is permanent. Per Docker docs on [minimizing image size](https://docs.docker.com/build/building/best-practices/#minimize-the-number-of-layers).
**Fix:** One `RUN`, recommendation flag, list cleanup:
```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
```
**Review prompt one-liner:** Is every `apt-get install` chained in one `RUN` with `--no-install-recommends` and `rm -rf /var/lib/apt/lists/*` at the end?

## Anti-pattern: Base image with `latest` (or floating major) tag

**Detection signal:** `FROM image:latest`, `FROM image` (implicit `latest`), or unpinned major tags in security-sensitive bases (`FROM ubuntu`, `FROM debian:stable`).
**Verbatim bad code:**
```dockerfile
FROM node:latest
```
**Why it's wrong:** The image content behind `latest` changes silently between builds. A reproducible build today fails or behaves differently tomorrow because the upstream maintainer moved the tag. Supply-chain attacks exploit this: a compromised tag re-push affects every downstream build. SLSA L2+ requires immutable references.
**Fix:** Pin a specific version, ideally by digest:
```dockerfile
FROM node:20.11.0-alpine3.19@sha256:abc123...
```
The digest pin makes the build cryptographically reproducible. Use Renovate/Dependabot with a digest update strategy.
**Review prompt one-liner:** Is every `FROM` pinned to a specific version tag plus `@sha256:` digest?

## Anti-pattern: Missing `HEALTHCHECK` directive

**Detection signal:** Dockerfile defines a long-running service (web server, worker, daemon) but contains no `HEALTHCHECK` instruction.
**Verbatim bad code:**
```dockerfile
FROM nginx:1.25
COPY site/ /usr/share/nginx/html/
CMD ["nginx", "-g", "daemon off;"]
# Container shows as "running" even if nginx hangs in deadlock
```
**Why it's wrong:** Without `HEALTHCHECK`, Docker only knows the process is alive — it cannot detect deadlock, port-bound-but-not-serving, or backend-down states. Orchestrators that use Docker's health status (Swarm, plain Docker, some Compose deployments) cannot restart unhealthy containers. Kubernetes ignores the Dockerfile `HEALTHCHECK` (it uses pod-spec probes instead), so this matters most for non-K8s deployments — flag the absence regardless and note where probes must compensate.
**Fix:**
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1
```
For Kubernetes-targeted images, document the expected `/healthz` contract in the Dockerfile as a comment so pod-spec authors don't reinvent it.
**Review prompt one-liner:** Does the Dockerfile declare a `HEALTHCHECK` (or explicitly document the K8s probe contract) for any long-running service?

## Anti-pattern: Secrets passed via `ARG` (visible in image history)

**Detection signal:** `ARG NPM_TOKEN`, `ARG AWS_SECRET_ACCESS_KEY`, `ARG GITHUB_TOKEN`, `ARG DATABASE_URL`, or any `ARG` whose name contains `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PASS`, `CREDENTIAL`.
**Verbatim bad code:**
```dockerfile
ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc \
 && npm ci \
 && rm ~/.npmrc
# Token is in build args, visible in `docker history --no-trunc` and recorded in BuildKit history.
```
**Why it's wrong:** `ARG` values are recorded in image metadata and visible to anyone who pulls the image (`docker history --no-trunc <image>`). `rm` does not remove them from the build cache or the build context that BuildKit retains. Per Docker's [build secrets documentation](https://docs.docker.com/build/building/secrets/), build-time secrets must use `--mount=type=secret`.
**Fix:** Use BuildKit secret mounts (never persisted to the image):
```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev
```
Build with: `docker build --secret id=npmrc,src=$HOME/.npmrc .`
**Review prompt one-liner:** Is every credential-shaped value (token, key, password) sourced via `--mount=type=secret` rather than `ARG` or `ENV`?

## Anti-pattern: No `.dockerignore` (or `.dockerignore` missing critical entries)

**Detection signal:** Dockerfile present, `.dockerignore` absent OR present but does not list `.git`, `node_modules`, `.env*`, `*.log`, `coverage/`, `.aws/`, `.ssh/`.
**Verbatim bad code:**
```
# No .dockerignore in repo
# `COPY . .` ships .git (with history, possibly secrets in old commits),
# node_modules from host (wrong arch / dev deps), .env (production secrets), etc.
```
**Why it's wrong:** The build context is uploaded to the daemon and used by `COPY .`/`ADD .`. `.git` leaks branch history (which has been used to recover deleted secrets). Host `node_modules` bypasses `npm ci` and ships dev dependencies + wrong-arch binaries. `.env` files exfiltrate credentials. Build context size also affects every CI build duration.
**Fix:** Minimum baseline `.dockerignore`:
```
.git
.gitignore
node_modules
.env*
*.log
coverage
.vscode
.idea
**/.DS_Store
Dockerfile*
.dockerignore
README.md
```
Then explicitly `COPY` what you need rather than relying on `COPY . .`.
**Review prompt one-liner:** Does `.dockerignore` exist and exclude `.git`, `node_modules`, `.env*`, and other host-only or secret-bearing paths?

## Anti-pattern: Many small `RUN` commands (layer explosion)

**Detection signal:** 5+ consecutive `RUN` lines that could be chained (each running a single short command).
**Verbatim bad code:**
```dockerfile
RUN apt-get update
RUN apt-get install -y curl
RUN apt-get install -y git
RUN apt-get install -y python3
RUN apt-get clean
RUN rm -rf /var/lib/apt/lists/*
# 6 layers, intermediate cruft from earlier layers can't be removed by later cleanup
```
**Why it's wrong:** Each `RUN` creates a layer in the union filesystem. Files added in layer N cannot be removed by layer N+M — only marked deleted. Cleanups must live in the same layer as the install. Layer count also has runtime overhead (more layer-merge work at container start).
**Fix:** Chain related work with `&&` and `\`:
```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git python3 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
```
**Review prompt one-liner:** Are install + cleanup operations chained inside a single `RUN`, or are they split across layers where cleanup can no longer shrink the image?

## Anti-pattern: `ADD` used for local files instead of `COPY`

**Detection signal:** `ADD ./src /app` or `ADD package.json .` for local files that don't need tarball auto-extraction or URL fetching.
**Verbatim bad code:**
```dockerfile
ADD ./app /app
```
**Why it's wrong:** Per Docker's [Dockerfile reference](https://docs.docker.com/reference/dockerfile/#add), `ADD` has surprising semantics: it auto-extracts `.tar`, `.tar.gz`, `.tar.bz2`, `.tar.xz` archives (so `ADD myfile.tgz /app` silently unpacks instead of copying), and it can fetch HTTP/HTTPS URLs (which bypasses build-context controls and can introduce non-reproducible inputs without TLS verification of intermediate certs). `COPY` does only what its name says.
**Fix:** Use `COPY` for local files. Reserve `ADD` for explicit tarball extraction with `--checksum=sha256:...` for remote sources.
**Review prompt one-liner:** Is every `ADD` justified by tarball extraction or a checksum-pinned URL fetch — and is `COPY` used everywhere else?

## Anti-pattern: No `WORKDIR` — commands run in `/`

**Detection signal:** Dockerfile uses `COPY`, `RUN`, `CMD` with relative paths but never sets `WORKDIR`.
**Verbatim bad code:**
```dockerfile
FROM node:20-alpine
COPY package.json ./    # copies to /package.json
RUN npm ci              # runs in /, fails or creates /node_modules
CMD ["node", "server.js"]  # looks for /server.js
```
**Why it's wrong:** Defaulting to `/` makes the build fragile to instruction reordering, pollutes the root filesystem with app files, and confuses readers about where the app lives. `cd /app && ...` inside `RUN` doesn't persist across instructions (each `RUN` starts a new shell at `WORKDIR`).
**Fix:** Set `WORKDIR /app` early (after the `FROM`) and stick to it. Use absolute paths in `COPY --from=build /out/server /server` for cross-stage copies.
**Review prompt one-liner:** Is `WORKDIR` set explicitly and used consistently rather than relying on `/` as the implicit working directory?

## Anti-pattern: Final image contains `curl`/`wget`/`git`/build tools

**Detection signal:** Final stage `RUN apt-get install -y curl git build-essential` (or alpine equivalents) where these tools are not needed at runtime.
**Verbatim bad code:**
```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl git gcc python3-dev \
 && pip install -r requirements.txt
CMD ["python", "app.py"]
# curl, git, gcc remain in the production image
```
**Why it's wrong:** Each tool is a CVE source and an attacker's foothold. `curl`/`wget` enable in-container exfiltration on RCE. `git` enables credential probing. `gcc`/`make` enable on-host exploit compilation. Per the [OWASP Docker Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html) Rule 8 (least privilege), runtime image should contain only what's needed to serve traffic.
**Fix:** Use multi-stage: install build toolchain in the build stage, copy only built artifacts into a minimal final stage:
```dockerfile
FROM python:3.12 AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

FROM python:3.12-slim
COPY --from=build /root/.local /root/.local
COPY app.py .
USER 10001:10001
ENV PATH=/root/.local/bin:$PATH
CMD ["python", "app.py"]
```
**Review prompt one-liner:** Is every `curl`/`wget`/`git`/compiler in the final stage justified by a runtime need, not just leftover from the install step?

## Anti-pattern: Missing `--platform=$BUILDPLATFORM` for multi-arch builds

**Detection signal:** Dockerfile is meant to support `linux/amd64` + `linux/arm64` (CI matrix builds via `docker buildx`), but `FROM` lines don't specify platform and slow QEMU emulation runs the build stage on the target arch.
**Verbatim bad code:**
```dockerfile
FROM golang:1.22 AS build
# When building for linux/arm64 on an amd64 runner, Go compiler runs under QEMU emulation → 10× slower
```
**Why it's wrong:** Per Docker's [multi-platform docs](https://docs.docker.com/build/building/multi-platform/), without `--platform=$BUILDPLATFORM` the build stage runs in emulated target architecture, dramatically slowing cross-compiles. Native cross-compilation (Go, Rust with `--target`, Zig) is 5-20× faster.
**Fix:**
```dockerfile
FROM --platform=$BUILDPLATFORM golang:1.22 AS build
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o /out/server ./cmd/server

FROM --platform=$TARGETPLATFORM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
```
**Review prompt one-liner:** For multi-arch builds, does the build stage use `--platform=$BUILDPLATFORM` plus `TARGETOS`/`TARGETARCH` to cross-compile natively?

## Anti-pattern: `EXPOSE` cargo-culted without matching service

**Detection signal:** `EXPOSE 8080` (or any port) where the application code binds to a different port, or `EXPOSE` lists multiple ports the app never serves.
**Verbatim bad code:**
```dockerfile
EXPOSE 80 443 8080 3000
CMD ["node", "server.js"]   # actually binds 4000
```
**Why it's wrong:** `EXPOSE` is documentation — it doesn't open ports. But misleading documentation causes downstream confusion: Kubernetes manifests, load balancers, and dev compose files get configured against the wrong port. Worse, when accurate, `EXPOSE` is the source of truth that orchestration tooling and `docker run -P` rely on.
**Fix:** `EXPOSE` only the port(s) the app actually serves, derived from the same constant the code reads (env var or build arg). One service, one port, unless there's a documented reason.
**Review prompt one-liner:** Does `EXPOSE` list exactly the ports the application binds at runtime — no more, no fewer?

---

## What good looks like

### Multi-stage Go service with distroless final stage

```dockerfile
# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM golang:1.22.3-alpine3.19@sha256:abc... AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot@sha256:def...
WORKDIR /
COPY --from=build /out/server /server
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
```

**Why it works:** Digest-pinned bases, build cache mounts speed re-builds without bloating the image, cross-compile via `BUILDPLATFORM` (no QEMU), distroless final image has no shell/package-manager/curl, runs as numeric UID 65532, single port `EXPOSE` matches what `/server` binds.
**Affirm:** Production containers ship only the compiled binary, run as numeric non-root UID, and have digest-pinned bases.

### Node.js service with cached `npm ci` layer

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20.11.0-alpine3.19@sha256:ghi... AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:20.11.0-alpine3.19@sha256:ghi... AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S -G app -u 10001 app
COPY --from=deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 . .
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
```

**Why it works:** `package*.json` copied alone so `npm ci` layer caches across source-only changes; npm cache mount avoids re-downloading; non-root numeric UID; `.dockerignore` (not shown) excludes host `node_modules` and `.git`.
**Affirm:** Dependency installation lives in a layer whose inputs are only the lockfile, so source-only commits skip re-install.

### BuildKit secret mount for private registry auth

```dockerfile
# syntax=docker/dockerfile:1.7
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
```

Built with:
```bash
docker buildx build --secret id=npmrc,src=$HOME/.npmrc -t app:latest .
```

**Why it works:** `.npmrc` is mounted only during that `RUN`, never written to a layer, never appears in `docker history`. `required=true` fails the build early if the operator forgot the secret instead of producing a broken image.
**Affirm:** Build-time secrets always come from `--mount=type=secret`, never from `ARG` or `ENV`.

### Minimal `.dockerignore`

```
.git
.gitignore
.github
node_modules
.env*
*.log
coverage
.nyc_output
dist
build
.vscode
.idea
**/.DS_Store
Dockerfile*
.dockerignore
docker-compose*.yml
README.md
*.md
```

**Why it works:** Build context stays small (fast uploads to the daemon, cheap CI), `.git` history can't be data-mined for stale secrets, host `node_modules` cannot pollute the image, `.env*` cannot leak.
**Affirm:** Every repo with a Dockerfile has a `.dockerignore` that excludes `.git`, dependency caches, env files, and host build artifacts.

## Sources

- [Docker — Build best practices](https://docs.docker.com/build/building/best-practices/)
- [Docker — Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker — Build secrets](https://docs.docker.com/build/building/secrets/)
- [Docker — Build cache](https://docs.docker.com/build/cache/)
- [Docker — Multi-platform images](https://docs.docker.com/build/building/multi-platform/)
- [Docker — Dockerfile reference (ADD vs COPY)](https://docs.docker.com/reference/dockerfile/#add)
- [OWASP — Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)
- [Google — Distroless images](https://github.com/GoogleContainerTools/distroless)
- [CNCF — SLSA supply-chain levels](https://slsa.dev/spec/v1.0/levels)
