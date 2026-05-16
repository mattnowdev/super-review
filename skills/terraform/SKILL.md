---
description: Terraform / OpenTofu IaC anti-patterns reference loaded by super-review:run when the diff touches `*.tf` / `*.tfvars`, `terragrunt.hcl`, or `cdktf` directories. Covers state-file safety, locking, provider pinning, IAM document discipline, lifecycle guards, count-vs-for_each, and apply-from-plan workflow. Patterns `tflint` and `tfsec` partially cover, but the most expensive incidents (lost state, destroyed prod DB, leaked outputs) come from policy gaps these tools don't model.
---

# Terraform / OpenTofu review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies infrastructure-as-code. `tflint`, `tfsec`, `checkov`, and `terrascan` catch the obvious resource-level misconfigs — what follows is the residue they miss: state safety, change management, and module hygiene.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Security** and **Correctness** reviewer prompts when it detects `*.tf` / `*.tfvars` files in the diff, a `terragrunt.hcl`, or `cdktf.json`. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: State file committed to git
**Detection signal:** `terraform.tfstate`, `terraform.tfstate.backup`, or `*.tfstate` in the diff or `git ls-files`; `.gitignore` missing `*.tfstate*`.
**Verbatim bad code:**
```
# repo root
terraform.tfstate         # 4.2 MB, contains RDS master password in plaintext
terraform.tfstate.backup
```
**Why it's wrong:** State holds every output, every sensitive attribute, every resource ID. Committed state leaks secrets to anyone with repo read, breaks concurrent work (last-writer-wins), and grows the repo unboundedly. Per the Terraform docs, state is the source of truth for what infra exists — git is the wrong substrate for a mutable, sensitive, frequently-written blob.
**Fix:** Remote backend with locking from day one. S3 + DynamoDB (`backend "s3" { bucket = ..., dynamodb_table = ..., encrypt = true }`), Terraform Cloud / HCP, or GCS with `prevent_destroy`. Add `*.tfstate*` and `.terraform/` to `.gitignore`.
**Review prompt one-liner:** Is any `*.tfstate*` file tracked by git, and is the configured backend a local backend (or no backend block at all)?

## Anti-pattern: No state locking on remote backend
**Detection signal:** `backend "s3" {}` block without `dynamodb_table`; `backend "gcs" {}` is fine (GCS object-level locking is automatic); `backend "http" {}` without `lock_address`/`unlock_address`.
**Verbatim bad code:**
```hcl
terraform {
  backend "s3" {
    bucket = "tf-state-prod"
    key    = "network/terraform.tfstate"
    region = "us-east-1"
    # no dynamodb_table → no lock
  }
}
```
**Why it's wrong:** Two concurrent `terraform apply` runs write to the same S3 object; the later write silently overwrites the first, and state diverges from reality. Recovery requires forensic reconstruction from cloud-provider APIs. Per HashiCorp's S3 backend docs, `dynamodb_table` is the documented mechanism for locking.
**Fix:** Provision a DynamoDB table with `LockID` (string) hash key, reference it in the backend block. For Terraform 1.10+ S3 backend supports native S3 locking via `use_lockfile = true` — use that for new setups.
**Review prompt one-liner:** Does the backend block include locking (DynamoDB for S3, native for Terraform Cloud / GCS / Terraform 1.10+ S3)?

## Anti-pattern: Sensitive output without `sensitive = true`
**Detection signal:** `output "db_password" { value = ... }`, `output "api_key" {}`, anything reading `aws_db_instance.*.password`, `random_password.*.result`, `aws_secretsmanager_secret_version.*.secret_string` without `sensitive = true`.
**Verbatim bad code:**
```hcl
output "rds_password" {
  value = aws_db_instance.main.password
  # sensitive flag missing → printed to CLI, CI logs, plan artifacts
}
```
**Why it's wrong:** Outputs without `sensitive = true` are printed verbatim by `terraform plan`, `terraform apply`, `terraform output`, and almost every CI runner archives those logs. The value also flows into any module that consumes this output unless that module also marks its variable sensitive.
**Fix:** `sensitive = true` on the output; mark consuming `variable {}` blocks as `sensitive = true` too (sensitivity does not propagate automatically across module boundaries in older versions — verify on your Terraform version).
**Review prompt one-liner:** Does every `output` whose value derives from a password, secret, key, token, or connection string declare `sensitive = true`?

## Anti-pattern: `count` used where `for_each` would be safer
**Detection signal:** `count = length(var.users)` with `var.users` being a list that's edited in the middle.
**Verbatim bad code:**
```hcl
resource "aws_iam_user" "team" {
  count = length(var.team_members)
  name  = var.team_members[count.index]
}
# var.team_members = ["alice", "bob", "carol"]
# Remove "alice" → bob becomes index 0, carol becomes index 1
# Terraform plan: destroy aws_iam_user.team[2], rename [0] and [1] in place? No.
# It destroys index 2 AND modifies 0 and 1 (and their access keys, policies)
```
**Why it's wrong:** `count` indexes by position. Removing an element from the middle of the input list shifts every subsequent resource's address, triggering destroy+recreate for unrelated resources. `for_each` keys by a stable string, so adding/removing one element only touches that one.
**Fix:** `for_each = toset(var.team_members)` and reference via `each.key`. Use `count` only for `0` vs `1` toggles or genuinely positional sequences.
**Review prompt one-liner:** For every `count = length(list)`, is removal of a middle element safe — or should this be `for_each` over a set/map?

## Anti-pattern: Hardcoded region / account IDs in resource blocks
**Detection signal:** Literal `"us-east-1"`, `"123456789012"`, ARN strings with hardcoded account numbers in resource arguments instead of `var.region`, `data.aws_caller_identity.current.account_id`, or `data.aws_region.current.name`.
**Verbatim bad code:**
```hcl
resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = jsonencode({
    Statement = [{
      Resource = "arn:aws:s3:::my-logs-bucket/AWSLogs/123456789012/*"
      Principal = { AWS = "arn:aws:iam::123456789012:root" }
    }]
  })
}
```
**Why it's wrong:** Cannot promote the same module from dev → staging → prod accounts; cannot fork to a sibling region; account ID leaks identify the org. The first attempt to re-use the module in another env produces a confusing apply diff or an authoritative permission error.
**Fix:** `data "aws_caller_identity" "current" {}`, `data "aws_region" "current" {}`, and reference `data.aws_caller_identity.current.account_id` / `data.aws_region.current.name`. Pass account/region via `var.*` at the root module.
**Review prompt one-liner:** Are all region strings, account IDs, and ARN account fragments sourced from variables or `aws_caller_identity`/`aws_region` data sources?

## Anti-pattern: Provider version not pinned
**Detection signal:** `terraform {}` block missing `required_providers`; or `required_providers { aws = { version = "~> 5" } }` (unbounded major); or `version = ">= 4.0"` with no upper bound.
**Verbatim bad code:**
```hcl
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = { source = "hashicorp/aws" }   # no version → latest, unrepeatable
  }
}
```
**Why it's wrong:** A new provider release between two `terraform init` runs changes resource schemas, attribute defaults, or deprecates arguments. Two engineers running plan on the same commit can produce different diffs. CI builds are not reproducible.
**Fix:** Pessimistic constraint operator with both bounds: `version = "~> 5.40"` (allows 5.x ≥ 5.40, blocks 6.0). Commit `.terraform.lock.hcl` so CI uses the same provider hashes everyone else verified.
**Review prompt one-liner:** Does `required_providers` pin every provider with a bounded version constraint, and is `.terraform.lock.hcl` committed?

## Anti-pattern: Missing `lifecycle.prevent_destroy` on stateful resources
**Detection signal:** `aws_db_instance`, `aws_rds_cluster`, `aws_s3_bucket` (with data), `aws_dynamodb_table`, `aws_efs_file_system`, `google_sql_database_instance` without a `lifecycle { prevent_destroy = true }` block.
**Verbatim bad code:**
```hcl
resource "aws_db_instance" "prod" {
  identifier = "prod-postgres"
  # no lifecycle block → `terraform destroy` or a rename will delete it
}
```
**Why it's wrong:** A single accidental rename, a misordered `terraform state mv`, or a `terraform destroy` run with the wrong workspace selected will permanently delete the database. `prevent_destroy = true` causes Terraform to error rather than execute the destroy, forcing a deliberate code change to proceed.
**Fix:**
```hcl
lifecycle {
  prevent_destroy = true
  ignore_changes  = [password, engine_version]  # if managed elsewhere
}
```
Pair with provider-level deletion protection (`deletion_protection = true` for RDS).
**Review prompt one-liner:** Does every stateful resource (database, bucket-with-data, persistent volume) have `lifecycle.prevent_destroy = true` and provider-level deletion protection?

## Anti-pattern: `depends_on` cargo-culted onto every resource
**Detection signal:** `depends_on = [aws_iam_role.foo, aws_security_group.bar, aws_subnet.baz]` on a resource that already references those via `aws_iam_role.foo.arn` / `aws_security_group.bar.id` in its arguments.
**Verbatim bad code:**
```hcl
resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.web.name
  depends_on = [
    aws_security_group.web,          # already implicit via vpc_security_group_ids
    aws_iam_instance_profile.web,    # already implicit via iam_instance_profile
  ]
}
```
**Why it's wrong:** Implicit deps (via attribute references) are stronger than `depends_on` because they also propagate `sensitive`/`unknown` correctly. Redundant `depends_on` obscures real ordering needs and creates noise that hides legitimate explicit dependencies (e.g., IAM-policy-attached-before-resource-uses-it timing).
**Fix:** Delete `depends_on` lines that duplicate an attribute reference. Keep only the ones that encode an invisible-to-Terraform side-channel dependency (e.g., IAM policy attachment timing, S3 bucket-policy-before-write).
**Review prompt one-liner:** For each `depends_on` entry, is the target absent from any argument reference in the same resource — and if not, why is the explicit dep needed?

## Anti-pattern: `-target` used as a workflow instead of an emergency tool
**Detection signal:** README, CI script, or PR description mentioning `terraform apply -target=module.x` as a routine step.
**Verbatim bad code:**
```bash
# deploy.sh
terraform apply -target=module.network -auto-approve
terraform apply -target=module.compute -auto-approve
terraform apply -auto-approve
```
**Why it's wrong:** HashiCorp's docs explicitly call `-target` an exceptional operation: it skips dependency graph validation, can leave state in a partially-applied state, and the second apply may produce a diff that surprises you because of unconverged refs. Routine `-target` use means modules are wrongly coupled — split them.
**Fix:** Refactor into separate root modules with their own state if you genuinely need to apply them independently. Use a tool like Terragrunt for run-all orchestration. Reserve `-target` for incident recovery.
**Review prompt one-liner:** Is `-target` used in any committed script, CI job, or runbook as a regular step rather than as a documented break-glass?

## Anti-pattern: Inline IAM policy JSON instead of `aws_iam_policy_document` data source
**Detection signal:** `policy = jsonencode({ Version = "2012-10-17", Statement = [...] })` or a heredoc `<<EOF { ... } EOF` in `aws_iam_role_policy`, `aws_iam_policy`, `aws_s3_bucket_policy`.
**Verbatim bad code:**
```hcl
resource "aws_iam_role_policy" "lambda" {
  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject"],
    "Resource": "arn:aws:s3:::${var.bucket}/*"
  }]
}
EOF
}
```
**Why it's wrong:** No syntax check at plan time, no interpolation safety (a `${}` inside the string with the wrong quoting can produce malformed JSON that AWS rejects only at apply), no provider-side schema awareness, harder to compose multiple statements. The AWS provider's `aws_iam_policy_document` data source validates structure and produces a JSON string with proper escaping.
**Fix:**
```hcl
data "aws_iam_policy_document" "lambda" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
  }
}
resource "aws_iam_role_policy" "lambda" {
  policy = data.aws_iam_policy_document.lambda.json
}
```
**Review prompt one-liner:** Is every AWS IAM policy authored via `aws_iam_policy_document` (or equivalent provider data source), not as raw JSON / heredoc?

## Anti-pattern: `local-exec` provisioner doing work that should be a real resource
**Detection signal:** `provisioner "local-exec" { command = "aws s3 cp ..." }`, `kubectl apply`, `curl -X POST https://api...`, `gh release create`, etc.
**Verbatim bad code:**
```hcl
resource "aws_s3_bucket" "site" { bucket = "static-site" }
resource "null_resource" "upload" {
  provisioner "local-exec" {
    command = "aws s3 sync ./dist/ s3://${aws_s3_bucket.site.id}/"
  }
  triggers = { always = timestamp() }   # → runs every plan
}
```
**Why it's wrong:** Provisioners are explicitly a last resort per HashiCorp's docs. They run only at create/destroy, can't model drift, fail silently in CI without proper exit-code handling, depend on the operator's local tooling (aws-cli version, auth context), and skip Terraform's state model.
**Fix:** Use the real resource (`aws_s3_object`, `kubernetes_manifest`, `github_release`, `helm_release`). When no provider resource exists, write a small custom provider or invoke the API at a layer above Terraform (e.g., a deploy script that runs after `terraform apply`).
**Review prompt one-liner:** For every `local-exec` / `remote-exec` provisioner, is there a real provider resource that does the same thing, and what's the documented reason for not using it?

## Anti-pattern: Resources without tags / labels
**Detection signal:** `aws_*` resource missing `tags = ...`, `google_*` missing `labels`, `azurerm_*` missing `tags`. No provider-level `default_tags` block.
**Verbatim bad code:**
```hcl
provider "aws" { region = "us-east-1" }
resource "aws_instance" "worker" { ami = "..."; instance_type = "m6i.large" }
# Cost-allocation report: $4,300/mo on "Untagged" → which team? which env? which app?
```
**Why it's wrong:** Cost allocation, SLO-by-service rollups, IAM-by-tag policies, and "who owns this" forensics all break. Most orgs have a tagging policy; un-tagged resources fall outside it and become orphaned spend.
**Fix:** Provider-level `default_tags { tags = { Env = var.env, Team = var.team, ManagedBy = "terraform", Repo = "github.com/..." } }`. Resource-level tags only for overrides. For GCP, use `labels` similarly.
**Review prompt one-liner:** Does the provider declare `default_tags` (or equivalent), and does every taggable resource inherit Env / Team / ManagedBy / CostCenter?

## Anti-pattern: `variable {}` without `type` declaration
**Detection signal:** `variable "foo" { description = "..." }` or `variable "foo" { default = "bar" }` with no `type =`.
**Verbatim bad code:**
```hcl
variable "instance_count" {
  default = 3
}
# tfvars passes instance_count = "3" (string) → silently coerced
# downstream `count = var.instance_count + 1` → string concat error or unexpected math
```
**Why it's wrong:** Without `type =`, Terraform accepts any value and applies lenient coercion. Type errors surface deep in the graph, far from the variable assignment, often as opaque interpolation failures.
**Fix:** `type = number`, `type = string`, `type = list(string)`, `type = map(object({ ... }))`. Add `validation { condition = ..., error_message = "..." }` for bounded values.
**Review prompt one-liner:** Does every `variable` block declare an explicit `type =` (and a `validation` block where the value has a constrained domain)?

## Anti-pattern: `terraform import` performed without committing the resource block
**Detection signal:** PR description says "imported the existing prod DB"; `terraform plan` in the next CI run shows "1 to add" or large attribute diffs because the imported resource's HCL doesn't match reality.
**Verbatim bad code:**
```bash
$ terraform import aws_db_instance.prod prod-postgres
$ git commit -m "import prod db"   # but no aws_db_instance.prod block in any .tf
# Next plan: Terraform sees state entry without config → "will be destroyed"
```
**Why it's wrong:** Import populates state only; without a matching HCL resource block, the next plan reads state, finds no config, and proposes to destroy the resource. Many teams have lost production resources this way.
**Fix:** Use Terraform 1.5+ `import {}` blocks (declarative; reviewable in PR) or run `terraform plan -generate-config-out=imported.tf`, hand-edit the generated HCL to match style, commit before applying.
**Review prompt one-liner:** For any imported resource, is there a committed HCL block whose `plan` produces zero diff against current state?

## What good looks like

### Backend with locking, encryption, and versioned state
```hcl
terraform {
  required_version = "~> 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
  backend "s3" {
    bucket         = "acme-tf-state-prod"
    key            = "platform/network/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    use_lockfile   = true   # native S3 locking, TF 1.10+
    kms_key_id     = "alias/terraform-state"
  }
}
```
**Why it works:** State encrypted at rest, locked against concurrent applies, versioned at the bucket level so accidental corruption is recoverable.
**Affirm:** Every root module declares an encrypted, locked, remote backend with provider versions pinned and a committed lockfile.

### IAM via `aws_iam_policy_document` with explicit conditions
```hcl
data "aws_iam_policy_document" "s3_read" {
  statement {
    sid       = "ReadAssets"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceVpc"
      values   = [data.aws_vpc.app.id]
    }
  }
}
```
**Why it works:** Schema-validated at plan time, no JSON-escaping bugs, conditions composable, statements addressable by `sid`.
**Affirm:** All IAM/bucket/role policies built via provider data sources, not raw JSON.

### Module structure that lints clean
```
modules/network/
  main.tf        # resources only
  variables.tf   # typed inputs with validation
  outputs.tf     # outputs (sensitive flagged)
  versions.tf    # required_version + required_providers
  README.md      # generated by terraform-docs
```
**Why it works:** Predictable file layout for review, `terraform-docs` autogenerates the README, `versions.tf` co-located with the module so consumers pick up correct constraints.
**Affirm:** Every module has the four-file split plus a generated README.

### Plan-then-apply workflow
```bash
terraform plan -out=tfplan.binary
terraform show -json tfplan.binary > tfplan.json   # review in CI / OPA / conftest
# human review of the plan summary
terraform apply tfplan.binary                       # apply the exact plan reviewed
```
**Why it works:** No drift between "what was reviewed" and "what was applied"; `tfplan.binary` is the single artifact between review and apply. Enables policy-as-code (Sentinel / OPA / conftest) against the JSON form.
**Affirm:** CI applies a saved plan artifact, never runs `terraform apply` against fresh state.

## Sources
- [Terraform — Backend Configuration](https://developer.hashicorp.com/terraform/language/backend)
- [Terraform — S3 backend (locking, encryption)](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform — Sensitive outputs](https://developer.hashicorp.com/terraform/language/values/outputs#sensitive-suppressing-values-in-cli-output)
- [Terraform — `for_each` vs `count`](https://developer.hashicorp.com/terraform/language/meta-arguments/for_each)
- [Terraform — `lifecycle` meta-argument](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle)
- [Terraform — `-target` is for exceptional circumstances](https://developer.hashicorp.com/terraform/cli/commands/plan#resource-targeting)
- [Terraform — Provisioners are a last resort](https://developer.hashicorp.com/terraform/language/resources/provisioners/syntax)
- [Terraform — `import` block (1.5+)](https://developer.hashicorp.com/terraform/language/import)
- [AWS provider — `aws_iam_policy_document`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document)
- [AWS provider — `default_tags`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs#default_tags-configuration-block)
