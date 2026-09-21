# Local validation for the publish workflow

Run these checks before merging a version bump to `main` or dispatching
`.github/workflows/publish.yml`. They mirror what the publish job runs.

Publishing itself stays in GitHub Actions (Trusted Publishing). Do not run `npm publish` locally.

## Prerequisites

- Node.js 24 (matches `ci.yml` and `publish.yml`)
- Dependencies installed from the lockfile:

  ```bash
  npm ci
  ```

## Quick path

```bash
npm run ci
```

`npm run ci` runs, in order:

1. `npm run typecheck` — `tsc --noEmit` under `strict: true`
2. `npm test` — unit, sink, and extension tests
3. `npm run review:guardrails` — workflow permissions, release/version consistency, and
   tarball/document link integrity
4. `npm run pack:check` — `npm pack --dry-run`
5. `npm run publish:guard` — asserts no `NPM_TOKEN` / `NODE_AUTH_TOKEN` is referenced anywhere in the
   release path, and that `publish.yml` requests `id-token: write`

## What the guardrails actually assert

| Check | Failure it prevents |
|---|---|
| Top-level `permissions: contents: read` on PR workflows | A pull request job running with write scope |
| `persist-credentials: false` on `actions/checkout` | Credentials surviving into later steps |
| `package-lock.json` version equals `package.json` version | Publishing a version the lock disagrees with |
| `CHANGELOG.md` has a dated entry for the current version | Releasing without notes |
| `pi install npm:pi-lingua@x.y.z` lines match the version | A README advertising an install that does not exist |
| Every markdown file under `docs/` is in the npm tarball | Links that 404 for package consumers |
| Every relative markdown link resolves to a packed file | Reference rot |

## Version bump checklist

- [ ] `package.json` version bumped
- [ ] `package-lock.json` regenerated and committed
- [ ] `CHANGELOG.md` has `## [x.y.z] - YYYY-MM-DD`
- [ ] README version pins, if any, updated
- [ ] `npm run ci` green locally
- [ ] no `NPM_TOKEN` in workflows, secrets, or `.npmrc`
