---
description: Kubernetes manifest anti-patterns reference loaded by super-review:run when the diff touches K8s YAML. Covers production-readiness gaps (probes, PDBs, HPA, anti-affinity) and security hardening (rootless, capabilities, seccomp, NetworkPolicy, secret handling) that `kubectl apply` will accept silently. Patterns kube-linter / kubeval miss or downplay. Load when `*.yaml`/`*.yml` files in the diff contain `apiVersion: apps/v1`, `apiVersion: v1` (Pod/Service), `kind: Deployment`/`Service`/`NetworkPolicy`/etc., or when `helm/`, `kustomize/`, `k8s/`, `manifests/` directories are touched.
---

# Kubernetes review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies Kubernetes manifests, Helm charts, or Kustomize overlays. Tools like `kube-linter`, `kubeval`, `polaris`, and `kubesec` catch the obvious cases — what follows is the residue: defaults that the API server accepts but production will punish.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Security**, **Reliability**, and **Ops** reviewer prompts when it detects K8s YAML in the diff (manifest files containing `apiVersion:` + `kind:`, or paths under `helm/`, `kustomize/`, `k8s/`, `manifests/`, `charts/`). Each anti-pattern contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: Missing `resources.requests` / `resources.limits`
**Detection signal:** A container spec with no `resources:` block, or only `requests` without `limits` (or vice versa).
**Verbatim bad code:**
```yaml
containers:
  - name: api
    image: myorg/api:1.2.3
    # no resources block
```
**Why it's wrong:** Without `requests`, the scheduler can pack the pod onto a node that has no actual capacity (it's BestEffort QoS); without `limits`, a memory spike OOMKills neighboring pods or starves the kubelet. BestEffort pods are first to be evicted under node pressure. CPU `requests` also drive HPA decisions — missing them silently disables autoscaling.
**Fix:** Set both for every container. Start from real usage data (`kubectl top` or Prometheus), set `requests` at p95 and `limits` at ~2× requests for memory; for CPU set `requests` = steady state and consider omitting CPU limits on latency-sensitive workloads (CPU throttling is worse than burst).
**Review prompt one-liner:** Does every container (including initContainers and sidecars) declare both `resources.requests` and `resources.limits` for CPU and memory?
**Source:** [kubernetes.io — Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [CIS Kubernetes Benchmark 5.7.x](https://www.cisecurity.org/benchmark/kubernetes).

## Anti-pattern: Container runs as root (UID 0)
**Detection signal:** No `securityContext.runAsNonRoot: true` at pod or container level, or `runAsUser: 0`, or relying on the image's `USER` instruction (which most base images leave as root).
**Verbatim bad code:**
```yaml
spec:
  containers:
    - name: api
      image: myorg/api:1.2.3
      # no securityContext
```
**Why it's wrong:** A root process inside a container that escapes the namespace (CVE-2022-0185, runc CVE-2024-21626, future zero-days) is root on the host. Even without an escape, root + a writable host mount = node compromise. `runAsNonRoot: true` makes the kubelet refuse to start a UID-0 container — defense in depth that costs nothing.
**Fix:**
```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
```
Pair with a `USER 10001` line in the Dockerfile so the image filesystem is owned by that UID.
**Review prompt one-liner:** Does the pod or container `securityContext` set `runAsNonRoot: true` AND a non-zero `runAsUser`?
**Source:** [kubernetes.io — Configure a Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/), CIS Benchmark 5.2.6.

## Anti-pattern: Missing `readinessProbe`
**Detection signal:** A `Service`-backed Deployment whose pod spec has `livenessProbe` but no `readinessProbe`, or neither.
**Verbatim bad code:**
```yaml
containers:
  - name: api
    image: myorg/api:1.2.3
    ports: [{ containerPort: 8080 }]
    # no readinessProbe
```
**Why it's wrong:** Without `readinessProbe`, the pod is added to the Service Endpoints the instant the container process starts — before the app has loaded config, connected to the DB, or warmed caches. First requests 5xx for tens of seconds after every deploy. Rolling updates briefly serve a mix of "ready" and "not actually ready" pods.
**Fix:** Add a `readinessProbe` hitting an endpoint that returns 200 only when the app is fully initialized (DB ping ok, migrations done, cache primed):
```yaml
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  initialDelaySeconds: 0
  periodSeconds: 5
  failureThreshold: 3
```
**Review prompt one-liner:** Does every container in a Service-backed Deployment declare a `readinessProbe` that returns success only after dependencies are reachable?
**Source:** [kubernetes.io — Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/).

## Anti-pattern: Missing or misconfigured `livenessProbe`
**Detection signal:** No `livenessProbe`, OR a `livenessProbe` that hits the same endpoint as `readinessProbe` and depends on DB/cache reachability.
**Verbatim bad code:**
```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }  # /health pings the DB
```
**Why it's wrong:** Two failure modes: (1) no liveness probe means a deadlocked pod (event loop wedged, JVM GC death-spiral, stuck on a poisoned message) stays in the Service forever; (2) a liveness probe that depends on the DB will mass-restart every pod the moment the DB blips, causing a thundering-herd reconnect storm that prolongs the outage.
**Fix:** Liveness probes must check *only this process* — a `/livez` that returns 200 if the HTTP server is responsive. Readiness probes check dependencies. Configure `initialDelaySeconds` generously (or use `startupProbe`) so slow-starting apps aren't killed during boot.
**Review prompt one-liner:** Does the `livenessProbe` check only the local process (no DB/cache/external calls) and is it distinct from the `readinessProbe`?
**Source:** [kubernetes.io — Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/).

## Anti-pattern: Mutable image tag (`:latest`, `:stable`, `:main`) without digest pin
**Detection signal:** `image:` ends in `:latest`, no tag at all (defaults to `:latest`), or environment-floating tags like `:stable`, `:main`, `:prod`. No `@sha256:` digest.
**Verbatim bad code:**
```yaml
containers:
  - name: api
    image: myorg/api:latest
    imagePullPolicy: Always
```
**Why it's wrong:** Two identical-looking pods on two nodes can be running two different binaries depending on when the registry was scraped. Rollbacks via `kubectl rollout undo` rewind the manifest but pull the *current* `:latest` again. Supply-chain-attack mitigation (digest pinning per SLSA L3) is impossible. `imagePullPolicy: Always` makes node startup depend on registry uptime.
**Fix:** Use an immutable semver tag and a digest:
```yaml
image: myorg/api:1.2.3@sha256:abc123...
imagePullPolicy: IfNotPresent
```
Build the digest into the Helm chart via CI; never hand-edit.
**Review prompt one-liner:** Is every `image:` reference pinned to both an immutable tag AND a `@sha256:` digest?
**Source:** [kubernetes.io — Images](https://kubernetes.io/docs/concepts/containers/images/#image-names), [SLSA spec — Immutable references](https://slsa.dev/spec/v1.0/requirements).

## Anti-pattern: No `NetworkPolicy` — pod accepts traffic from anywhere in the cluster
**Detection signal:** A new namespace or workload with no `NetworkPolicy` resources in the diff; or `policyTypes` covering only `Egress` while `Ingress` is unrestricted.
**Verbatim bad code:**
```yaml
# Deployment + Service committed, no NetworkPolicy alongside
```
**Why it's wrong:** Default Kubernetes networking is flat: any pod in any namespace can dial any other pod's IP. A compromised low-trust workload (a webhook, a marketing service) can scan and exploit your database, internal admin APIs, or kubelet. Lateral movement is the standard post-exploitation pattern; NetworkPolicy is the only in-cluster mitigation.
**Fix:** Default-deny per namespace, then explicit allow:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: prod }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-allow, namespace: prod }
spec:
  podSelector: { matchLabels: { app: api } }
  ingress:
    - from: [{ podSelector: { matchLabels: { app: gateway } } }]
      ports: [{ port: 8080 }]
```
Requires a CNI that enforces NetworkPolicy (Calico, Cilium, Antrea) — flannel default does not.
**Review prompt one-liner:** Does the target namespace have a default-deny `NetworkPolicy`, and does this workload have explicit ingress/egress allow rules?
**Source:** [kubernetes.io — Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/), CIS Benchmark 5.3.2.

## Anti-pattern: Secret mounted as environment variable
**Detection signal:** `env:` entries with `valueFrom.secretKeyRef`, or `envFrom: [{ secretRef: ... }]`.
**Verbatim bad code:**
```yaml
env:
  - name: DB_PASSWORD
    valueFrom: { secretKeyRef: { name: db-creds, key: password } }
```
**Why it's wrong:** Env vars leak into: crash dumps, `kubectl describe pod` (visible to anyone with `get pod`), `/proc/<pid>/environ` (readable by any process in the same pod), child-process exec logs, error-tracker breadcrumbs (Sentry serializes env by default), and any library that prints `process.env` on startup. Volume-mounted secret files have a tighter blast radius — only the app that reads the file path sees the value.
**Fix:** Mount as a projected volume; the file is `tmpfs`-backed and not visible in `describe`:
```yaml
volumes:
  - name: db-creds
    secret: { secretName: db-creds, defaultMode: 0400 }
containers:
  - volumeMounts:
      - name: db-creds
        mountPath: /var/run/secrets/db
        readOnly: true
```
Better: use an external secret manager (AWS Secrets Manager + External Secrets Operator, HashiCorp Vault Agent, GCP Secret Manager + Workload Identity).
**Review prompt one-liner:** Are any Secret values exposed via `env`/`envFrom` instead of volume mounts or an external secret provider?
**Source:** [kubernetes.io — Good practices for Kubernetes Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/), CIS Benchmark 5.4.1.

## Anti-pattern: Missing `PodDisruptionBudget`
**Detection signal:** A Deployment / StatefulSet with `replicas: >= 2` and no matching `PodDisruptionBudget` resource.
**Verbatim bad code:**
```yaml
# Deployment with replicas: 3, no PDB anywhere in the chart
```
**Why it's wrong:** Voluntary disruptions (node drain for upgrade, cluster autoscaler scale-down, `kubectl drain`) will evict every pod simultaneously if no PDB exists. The Service has zero healthy endpoints for the duration of the rolling node replacement. AKS/EKS/GKE cluster upgrades, Karpenter consolidation, and Spot interruptions all respect PDBs — without one, you get downtime during routine ops.
**Fix:**
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api }
spec:
  minAvailable: 2          # or maxUnavailable: 1
  selector: { matchLabels: { app: api } }
```
Use `maxUnavailable: 1` for HPA-scaled workloads (`minAvailable` interacts badly with scale-down).
**Review prompt one-liner:** For every Deployment/StatefulSet with `replicas >= 2`, does a `PodDisruptionBudget` with a matching selector exist?
**Source:** [kubernetes.io — Specifying a Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/).

## Anti-pattern: `hostPath` volume mount
**Detection signal:** `volumes: [{ hostPath: ... }]` anywhere except in deliberately privileged DaemonSets (log shippers, node exporters).
**Verbatim bad code:**
```yaml
volumes:
  - name: data
    hostPath: { path: /var/data, type: DirectoryOrCreate }
```
**Why it's wrong:** `hostPath` punches through pod isolation: the container reads/writes the node's filesystem. A path traversal in the app becomes node compromise. Mounting `/var/run/docker.sock`, `/`, `/etc`, or `/proc` is a full escape vector. The pod is also no longer portable — it pins to whatever node has that path.
**Fix:** Use a PersistentVolumeClaim with a CSI driver (EBS/Disk/PD/Longhorn). For genuine node-local needs, use `emptyDir` (lifecycle bound to pod) or `local` PVs with a `StorageClass` and node affinity.
**Review prompt one-liner:** Does this manifest use `hostPath`, and if so, is the workload a documented infrastructure DaemonSet rather than an application?
**Source:** [kubernetes.io — Volumes (hostPath)](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath), CIS Benchmark 5.7.4.

## Anti-pattern: `privileged: true` or missing capability drop
**Detection signal:** `securityContext.privileged: true`, missing `capabilities.drop: [ALL]`, or `capabilities.add` without an explicit `drop`.
**Verbatim bad code:**
```yaml
securityContext:
  privileged: true
  # OR: no capabilities block at all → all default caps retained
```
**Why it's wrong:** `privileged: true` disables all container isolation (it's root on the host kernel for namespaces). The default cap set (`CAP_CHOWN`, `CAP_NET_RAW`, `CAP_SETUID`, etc.) is far broader than most apps need — `CAP_NET_RAW` alone enables ARP/DNS spoofing within the pod network. Drop everything, add back only what you provably need (most web apps need *zero* capabilities).
**Fix:**
```yaml
securityContext:
  privileged: false
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]
    # add: [NET_BIND_SERVICE]  # only if binding to port < 1024
```
**Review prompt one-liner:** Does the container set `privileged: false`, `allowPrivilegeEscalation: false`, and `capabilities.drop: [ALL]` with a minimal `add:` allow-list?
**Source:** [kubernetes.io — Security Context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/), CIS Benchmark 5.2.1–5.2.9.

## Anti-pattern: Missing `seccompProfile: RuntimeDefault`
**Detection signal:** No `seccompProfile` field at pod or container `securityContext`. (Kubernetes does NOT apply the runtime's default seccomp profile unless you ask.)
**Verbatim bad code:**
```yaml
securityContext:
  runAsNonRoot: true
  # no seccompProfile → all syscalls allowed
```
**Why it's wrong:** Without a seccomp profile, the container can call every syscall the kernel exposes (~330 on Linux). Many container-escape CVEs hinge on obscure syscalls (`unshare`, `keyctl`, `clone3` with weird flags) that `RuntimeDefault` blocks. There is no performance cost; the default profile is what Docker, containerd, and CRI-O have used for years.
**Fix:**
```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault
```
Set at pod level so it applies to all containers including initContainers. For sensitive workloads, write a custom `Localhost` profile narrower than the default.
**Review prompt one-liner:** Does the pod or container `securityContext` set `seccompProfile.type: RuntimeDefault` (or a stricter Localhost profile)?
**Source:** [kubernetes.io — Restrict a Container's Syscalls with seccomp](https://kubernetes.io/docs/tutorials/security/seccomp/), CIS Benchmark 5.7.2.

## Anti-pattern: No anti-affinity / `topologySpreadConstraints` — all replicas on one node or one zone
**Detection signal:** Deployment with `replicas >= 2` and no `affinity.podAntiAffinity` or `topologySpreadConstraints` block.
**Verbatim bad code:**
```yaml
spec:
  replicas: 3
  template:
    spec:
      containers: [...]
      # no affinity, no topology spread
```
**Why it's wrong:** The default scheduler will happily pack all three replicas onto the cheapest node or the same AZ. Single node reboot, single AZ outage → 100% of replicas gone. The Service has zero endpoints even though `replicas: 3` looked safe.
**Fix:** Soft anti-affinity for cost-sensitive, hard for tier-1:
```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway   # or DoNotSchedule for hard
    labelSelector: { matchLabels: { app: api } }
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector: { matchLabels: { app: api } }
```
**Review prompt one-liner:** For multi-replica workloads, does the spec declare `topologySpreadConstraints` across `topology.kubernetes.io/zone` AND `kubernetes.io/hostname`?
**Source:** [kubernetes.io — Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/).

## Anti-pattern: Rolling update with `maxUnavailable > 0` on a low-replica deployment
**Detection signal:** `strategy.rollingUpdate.maxUnavailable` is unset (defaults to 25%) or > 0 on a Deployment with `replicas <= 4`, with no `maxSurge` increase.
**Verbatim bad code:**
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1      # on replicas: 2 → 50% capacity drop during deploy
    maxSurge: 1
```
**Why it's wrong:** With `replicas: 2` and `maxUnavailable: 1`, every deploy halves serving capacity for the rollout window. Combined with `terminationGracePeriodSeconds: 30` and slow readiness, you get sustained 5xx during routine deploys. `maxUnavailable: 0` + `maxSurge: 1` = zero-capacity-loss deploys (one extra pod runs briefly).
**Fix:**
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1            # or 25% for larger fleets
```
Also set `terminationGracePeriodSeconds` longer than the longest in-flight request, and add a `preStop` hook that sleeps long enough for the Service Endpoints update to propagate (~5–10s on most clusters).
**Review prompt one-liner:** Does the Deployment set `maxUnavailable: 0` with `maxSurge >= 1`, and is `terminationGracePeriodSeconds` long enough for in-flight requests to drain?
**Source:** [kubernetes.io — Deployments / Rolling Update Strategy](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#rolling-update-deployment).

## Anti-pattern: No `HorizontalPodAutoscaler` for variable-traffic production workloads
**Detection signal:** A user-facing Deployment with a fixed `replicas:` value and no `HorizontalPodAutoscaler` resource targeting it.
**Verbatim bad code:**
```yaml
kind: Deployment
spec:
  replicas: 5    # always 5, regardless of load
```
**Why it's wrong:** Over-provisioned at night (paying for idle), under-provisioned at peak (latency / 5xx). Without HPA you can't ride out an organic traffic spike or a campaign. HPA also gives you a documented scaling ceiling — without it, the only "capacity plan" is "guess and pray."
**Fix:**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
  behavior:
    scaleDown: { stabilizationWindowSeconds: 300 }
```
Requires `resources.requests.cpu` set (HPA can't compute utilization without it). For non-CPU-bound workloads (queue workers), use custom metrics via KEDA.
**Review prompt one-liner:** For user-facing or queue-consuming workloads, is there an `HorizontalPodAutoscaler` with sensible min/max and a `behavior.scaleDown` stabilization window?
**Source:** [kubernetes.io — Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/).

## What good looks like

### Hardened container `securityContext`
```yaml
securityContext:                # pod level
  runAsNonRoot: true
  runAsUser: 10001
  fsGroup: 10001
  seccompProfile: { type: RuntimeDefault }
containers:
  - name: api
    image: myorg/api:1.2.3@sha256:abc...
    securityContext:            # container level
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities: { drop: [ALL] }
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits:   { cpu: 1000m, memory: 512Mi }
    readinessProbe:
      httpGet: { path: /ready, port: 8080 }
      periodSeconds: 5
    livenessProbe:
      httpGet: { path: /livez, port: 8080 }
      periodSeconds: 10
    startupProbe:
      httpGet: { path: /livez, port: 8080 }
      failureThreshold: 30
      periodSeconds: 2
```
**Why it works:** Non-root + no-priv-escalation + dropped caps + seccomp + read-only FS = each container-escape CVE has to chain through multiple mitigations. Resource bounds make scheduling deterministic. Three probes mean: startup tolerated, liveness narrow, readiness gates traffic.
**Affirm:** Every workload sets the seven-field security context block above and three-probe trio.

### Default-deny NetworkPolicy + explicit allow per workload
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: prod }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  egress:
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]
      ports: [{ protocol: UDP, port: 53 }]   # DNS only
```
**Why it works:** Lateral movement requires explicit policy. DNS to kube-dns is the one exception every pod needs.
**Affirm:** Every production namespace ships a default-deny NetworkPolicy and per-app allow rules.

### `topologySpreadConstraints` + PDB for HA
```yaml
spec:
  replicas: 3
  template:
    spec:
      topologySpreadConstraints:
        - { maxSkew: 1, topologyKey: topology.kubernetes.io/zone, whenUnsatisfiable: DoNotSchedule, labelSelector: { matchLabels: { app: api } } }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api }
spec: { maxUnavailable: 1, selector: { matchLabels: { app: api } } }
```
**Why it works:** Single-zone outage = at most one replica lost; voluntary disruption can take at most one replica at a time. Two replicas always serving.
**Affirm:** Multi-replica workloads pair `topologySpreadConstraints` (zone + hostname) with a PDB.

### Helm / Kustomize for environment overlays
```
chart/
  templates/deployment.yaml      # image: {{ .Values.image.repo }}@{{ .Values.image.digest }}
  values.yaml                    # safe defaults
  values-prod.yaml               # prod-specific replicas, resources, ingress host
```
**Why it works:** Source has no hardcoded prod values; image digests injected by CI; same chart deployed to staging and prod with provable diff.
**Affirm:** No environment-specific values (image tags, hostnames, replica counts) appear in templates — only in overlay/values files.

## Sources
- [kubernetes.io — Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/) (Baseline + Restricted profiles)
- [kubernetes.io — Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [kubernetes.io — Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [kubernetes.io — Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)
- [kubernetes.io — Resource Management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [kubernetes.io — Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes) (sections 5.1–5.7 cover most patterns above)
- [NSA/CISA — Kubernetes Hardening Guide](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)
