# Contributing to TariffShield

## Prerequisites

| Tool | Minimum version | Notes |
|------|------------------|-------|
| Node.js | 20+ | Pinned via root `package.json` `engines.node` |
| npm | 10+ | Ships with Node 20 |
| Rust | stable (2021 edition) | No strict MSRV pinned — see `Cargo.toml` / `contracts/tariff-shield/Cargo.toml` |
| `wasm32-unknown-unknown` target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | latest | https://developers.stellar.org/docs/tools/cli |
| Docker Desktop | latest | Runs local Postgres via `docker-compose.yml` |
| PostgreSQL client (`psql`) | any recent | For inspecting the local database directly |

## Development Setup

See [README.md](README.md) for the full walkthrough (Docker Compose, Stellar testnet, contract deployment). Numbered setup from a fresh clone:

```bash
# 1. Clone and install
git clone https://github.com/vjuliaife/TariffShield.git && cd TariffShield
npm install

# 2. Rust toolchain
rustup target add wasm32-unknown-unknown

# 3. Local Postgres (and API/web/Jaeger if you want the full stack — see README "Local Development")
docker-compose up -d

# 4. Configure env
cp .env.example .env
cp .env apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 5. Run database migrations
npm run db:migrate --workspace=apps/api

# 6. (Optional) seed local database
npm run seed

# 7. Start the API and web app
npm run dev:api      # API on :3002
npm run dev:web      # Web on :3000

# 8. Verify the API is up
curl -f http://localhost:3002/health   # should return 200
```

See [docs/local-dev.md](docs/local-dev.md) for troubleshooting local environment issues.

### Code Style

- **TypeScript** (`apps/api`, `apps/web`, `packages/sdk`): `strict` mode is enabled in every `tsconfig.json` — do not disable it or add `any` to work around a type error. Follow the existing import order (external packages, then internal `@tariffshield/*` / relative imports). Run before pushing:
  ```bash
  npm run typecheck --workspace=apps/web
  npm run lint --workspace=apps/api      # eslint --max-warnings 0
  npm run lint --workspace=apps/web
  npm run format:check --workspace=apps/api
  ```
- **Rust** (`contracts/tariff-shield`): zero `clippy` warnings and `rustfmt`-clean. Run before pushing:
  ```bash
  cargo fmt --all
  cargo clippy --workspace --all-targets --all-features -- -D warnings
  ```

To automate the Rust format check before committing, set up a Git `pre-commit` hook (`.git/hooks/pre-commit`, or a tool like `husky`):

```bash
#!/bin/sh
cargo fmt --all -- --check
```

### Testing

| Suite | Command |
|-------|---------|
| Contract unit tests | `cargo test --workspace` (or `npm run contract:test`) |
| API integration tests | `npm run test:integration --workspace=apps/api` |
| SDK tests | `packages/sdk` has no dedicated test script yet — type-check it with `npm run build --workspace=packages/sdk` and exercise it via the API integration tests, which run against the real SDK client |
| End-to-end tests | `npx playwright test` (from `apps/web`; see `apps/web/package.json` `test:e2e`) |

CI runs the contract, typecheck, and lint suites on every PR — see `.github/workflows/ci.yml` and `.github/workflows/contract.yml`.

---

## Pull Request Process

All PRs must target the `main` branch. Name your branch by change type, matching the Conventional Commits types below: `feat/short-description`, `fix/short-description`, `docs/short-description`, `chore/short-description`, etc.

When you open a PR, GitHub will pre-populate the body from [`.github/pull_request_template.md`](.github/pull_request_template.md). Fill in each section:

| Section | Purpose |
|---------|---------|
| **Summary** | One paragraph explaining what changed and why. Focus on the motivation, not just what the code does. |
| **Type of Change** | Tick the appropriate boxes so reviewers understand the scope at a glance. Tick **Breaking change** if existing callers need to update. |
| **Checklist** | Work through each item before requesting review. If an item does not apply, tick it and add a brief note explaining why. |
| **Related Issues** | Use `Closes #<number>` to auto-close issues on merge. Multiple issues: `Closes #123, closes #456`. |
| **Screenshots / Demo** | Required for any PR that changes the Next.js UI. A Loom recording is fine for complex flows. |
| **Deployment Notes** | List every action required after merge: new env vars, database migrations, contract upgrades, or Render/Vercel manual steps. Leave blank if none. |

### Review expectations

- At least one approving review is required before merge (enforced by branch protection).
- The CI suite (type-check, lint, contract tests, audit) must pass.
- Keep PRs focused — one feature or fix per PR. Large refactors should be discussed in an issue first.

### Pull Request Guidelines (size)

The `.github/workflows/pr-size.yml` check counts added + removed lines against the PR base (excluding generated files listed in `.prsize-ignore`, e.g. `package-lock.json`, `Cargo.lock`, `*.snap`, `dist/`, `target/`):

- **400–999 lines**: the bot leaves a comment suggesting you split the PR. This does not block merge.
- **1000+ lines**: the check fails and blocks merge, unless a maintainer applies the `large-pr-approved` label for an explicit sign-off.

If your change is trending large, split it: land groundwork/refactors first in their own PR, separate generated/vendored file changes from hand-written logic, and land a feature behind a flag in small increments rather than as one PR.

---

## Conventional Commits

TariffShield uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message on a PR targeting `main` is validated by the `commitlint` CI job and must follow this format:

```
<type>(<scope>): <short description>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature visible to users or API consumers |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no behaviour change |
| `test` | Adding or updating tests |
| `ci` | Changes to GitHub Actions workflows or CI config |
| `chore` | Maintenance tasks — dependency bumps, tooling config |
| `perf` | Performance improvement |
| `revert` | Reverts a prior commit |

### Scopes

Use one of these scopes when the change is specific to a subsystem:

| Scope | Subsystem |
|-------|-----------|
| `contract` | Soroban smart contract (`contracts/tariff-shield/`) |
| `api` | Express API (`apps/api/`) |
| `web` | Next.js dashboard (`apps/web/`) |
| `sdk` | TypeScript SDK (`packages/sdk/`) |
| `ci` | GitHub Actions workflows |
| `docs` | Documentation in `docs/` |
| `deps` | Dependency version updates |

Omit the scope when the change spans multiple subsystems.

### TariffShield-specific examples

```
feat(contract): add penalty accrual for undercollateralised accounts
fix(api): handle missing EIN in bond validation response
docs(runbooks): add support escalation guide
ci: add commitlint workflow for PR commit validation
chore(deps): bump @stellar/stellar-sdk to v15.1.0
refactor(api): extract AML screening into dedicated service module
test(contract): add dispute resolution edge-case tests
feat(web): show collateral staleness warning on dashboard
fix(sdk): correct stroop-to-XLM conversion in depositCollateral helper
```

### Breaking changes

If a commit introduces a breaking API or contract change, add a `BREAKING CHANGE:` footer:

```
feat(contract): rename deposit_reserve to fund_reserve

BREAKING CHANGE: The Soroban entry point `deposit_reserve` has been renamed
to `fund_reserve`. SDK callers must update to `contractClient.fundReserve()`.
Migration: redeploy the contract and update the SDK package version.
```

A `BREAKING CHANGE` footer triggers a **major** version bump in the automated release.

---

## Versioning

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on every push to `main` (after CI passes). The version bump is determined by the highest-impact commit type since the last release:

| Commit type | Version bump |
|-------------|-------------|
| `fix`, `perf`, `refactor` | Patch (`0.1.x`) |
| `feat` | Minor (`0.x.0`) |
| `BREAKING CHANGE` footer | Major (`x.0.0`) |

`chore`, `docs`, `ci`, and `test` commits do not trigger a release. `semantic-release` writes the updated version to `package.json` (root and workspaces), appends an entry to [`CHANGELOG.md`](CHANGELOG.md), and creates a GitHub Release with generated release notes.

---

## Getting Help

- [ARCHITECTURE.md](ARCHITECTURE.md) — technical deep-dive on the contract, API, and web app
- [docs/local-dev.md](docs/local-dev.md) — local environment setup and troubleshooting
- [docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md) — surety admin / emergency clawback procedure
- [docs/FAQ.md](docs/FAQ.md) — general project FAQ
- Stuck or found a bug? Open a GitHub issue — that's the preferred channel for contributor questions on this repo.
