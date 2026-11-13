# Release

Releases publish `pi-lingua` to npm through **Trusted Publishing (OIDC)**. No long-lived npm token is
stored in this repository or in GitHub secrets.

## How a release happens

A release is two manual dispatches, in order: `auto-release.yml` creates the tag and the GitHub
Release, then `publish.yml` publishes to npm. Neither workflow starts the other, and neither runs on
push.

1. Bump the version and update `CHANGELOG.md` in the same change. Use `--no-git-tag-version`:
   `auto-release.yml` creates the tag, and `npm version` would leave a duplicate local tag behind.

   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   # add `## [x.y.z] - YYYY-MM-DD` to CHANGELOG.md, or `npm run ci` will fail on the guardrail
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release x.y.z"
   git push
   ```

2. Dispatch `.github/workflows/auto-release.yml` on `main` with `confirm_release=true` (step 3 below
   does it). The workflow processes the `package.json` version, creates the `v<version>` tag, and
   publishes a GitHub Release. It does not start `publish.yml`, and it does not run automatically
   when the version change is pushed.
3. Dispatch the release and wait for the run **that dispatch** started, then publish the tag that
   run created. Keep this in one shell: the run id and the tag both have to come from this dispatch,
   and a variable from an earlier step does not survive it.

   ```bash
   set -euo pipefail

   # Run ids only grow, and `gh run list` returns the newest first, so the first id above the baseline
   # is the run this shell just started — as long as no other dispatch starts after this one. Two
   # dispatches are not distinguishable from their ids alone, so a dispatch that lands later wins
   # this lookup; that is why the block below reads the tag out of the watched run instead of
   # trusting the id, and why re-running this step is the safe answer when in doubt. `--limit 1`
   # would resolve at run time and could watch a different run.
   BASELINE=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')
   gh workflow run auto-release.yml --ref main -f confirm_release=true
   RUN=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $BASELINE) | .databaseId) // empty")
   : "${RUN:?no auto-release run appeared after the dispatch; wait for it and re-run this step}"
   # `set -e` stops the block when the run failed, so nothing is published from a failed release.
   gh run watch --exit-status "$RUN"

   git fetch --tags origin
   # The released tag is the version at the commit that run tagged. The highest local tag is not it:
   # a lower version released after a higher one would dispatch publish for the wrong tag.
   TAGGED_SHA=$(gh run view "$RUN" --json headSha --jq .headSha)
   TAG="v$(git show "$TAGGED_SHA:package.json" | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0,"utf8")).version))')"
   git rev-parse --verify --quiet "refs/tags/$TAG" > /dev/null

   # Capture the publish run the same way, so the check below watches a publish run started after the
   # baseline rather than whichever one happens to be newest when it runs. The newest-above-baseline
   # caveat from the release lookup applies here too.
   PUBLISH_BASELINE=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')
   gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"
   PUBLISH_RUN=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $PUBLISH_BASELINE) | .databaseId) // empty")
   : "${PUBLISH_RUN:?no publish run appeared after the dispatch; wait for it and re-run this step}"
   gh run watch --exit-status "$PUBLISH_RUN"
   npm view pi-lingua version
   ```

   The run-id lookup is honest about what it can and cannot resolve. `gh run list` returns the
   newest run first, so `first(...)` selects the newest id above the baseline:

   - a run that existed before the baseline is never selected, and neither is a run whose id is
     not above it — a lagging list result just yields an empty selection, and the `:?` assertion
     stops the block;
   - a dispatch that starts **after** this shell's dispatch outranks it, and the two ids alone
     cannot tell which shell started which. That case is a residual race, not something this block
     covers: the block still only publishes the tag of the run it actually watched, and re-running
     this step once no concurrent dispatch is in flight is the safe recovery.

   Selecting the *oldest* id above the baseline (`last(...)`) is worse than either case: it returns
   a run from an earlier dispatch even when this shell's own run is the newest one, while claiming
   to watch the run it just started.

   `gh workflow run` fails with a 422 while the ref does not exist, so the tag has to be there
   before the publish dispatch, and the block stops instead of dispatching when the release run did
   not succeed. Read the tag out of the run that tagged it instead of the version in your local
   `package.json`: `auto-release.yml` tags whatever `main` pointed at, which can be a later version
   than your working tree.

   The workflow runs `npm run ci`, skips the version when it already exists on npm, and otherwise
   publishes with `id-token: write`.

Do not rely on `push.tags` alone. A tag created by `GITHUB_TOKEN` does not trigger a `push.tags`
workflow, which is why `publish.yml` has to be dispatched by hand.

## First publish / Trusted Publisher not configured

`npm publish` from the workflow fails with `npm error code E404` on the `PUT` while no Trusted
Publisher exists for this package:

```
npm error code E404
npm error 404 Not Found - PUT https://registry.npmjs.org/pi-lingua
```

That is different from a version that is already published, which the workflow skips on purpose and
reports as `skip=true`.

### Why this cannot be fixed from CI

Trusted Publishing has to be registered **on an existing package**. From the `npm trust`
prerequisites:

- **npm 11.15.0 or above** is required for the `npm trust` command
- **Two-factor authentication must be enabled on the account** — granular access tokens with the 2FA
  bypass option are explicitly not supported
- You need **write access** to the package
- **The package must already exist on the registry**

So a brand-new package name cannot be bootstrapped by OIDC alone: the first publish has to claim the
name, and only then can the trusted publisher be registered.

### Procedure

Run all of this from the repository root. `npm login` writes to your **user** `~/.npmrc`, not to this
repository, so `npm run publish:guard` still passes and no workflow secret is involved.

```bash
set -euo pipefail

# 0. once per machine: npm 11.15+ for `npm trust`, and 2FA enabled on the npm account
npm install -g npm@^11.15.0
npm --version

git status --short          # must be clean; the tarball comes from this tree

# 1. claim the name. This version carries no provenance; that is unavoidable.
npm login
npm whoami
npm publish --access public

# 2. register the trusted publisher. --repo is optional when package.json has repository.url.
npm trust github pi-lingua --file publish.yml --repo eiei114/pi-lingua --allow-publish -y
npm trust list pi-lingua

# 3. publish a new version through OIDC so provenance is attached.
#    The workflow skips versions that already exist, so this must be a bump.
npm version patch --no-git-tag-version
# edit CHANGELOG.md: add `## [x.y.z] - YYYY-MM-DD`
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release x.y.z"
git push
# Run ids only grow and the list returns the newest first, so the first id above the baseline is
# the run this shell starts — unless another dispatch starts after it, which ids alone cannot tell
# apart. `--limit 1` would resolve at run time and could watch a different dispatch.
BASELINE=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')
gh workflow run auto-release.yml --ref main -f confirm_release=true

# 4. wait for that run, then publish the tag it created. auto-release.yml stops at the tag and
#    the GitHub Release; publish.yml is a separate dispatch. `set -e` stops this block when the
#    release run fails.
RUN=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $BASELINE) | .databaseId) // empty")
: "${RUN:?no auto-release run appeared after the dispatch; wait for it and re-run this step}"
gh run watch --exit-status "$RUN"
git fetch --tags origin
# the tag that run created, not the highest local tag
TAGGED_SHA=$(gh run view "$RUN" --json headSha --jq .headSha)
TAG="v$(git show "$TAGGED_SHA:package.json" | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0,"utf8")).version))')"
git rev-parse --verify --quiet "refs/tags/$TAG" > /dev/null

# 5. verify. Capture the publish run the same way, so this watches a publish run started after the
#    baseline rather than whichever run is newest when it runs; the same concurrent-dispatch caveat
#    applies, and it exits 0 on a failed run unless --exit-status is passed.
PUBLISH_BASELINE=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')
gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"
PUBLISH_RUN=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $PUBLISH_BASELINE) | .databaseId) // empty")
: "${PUBLISH_RUN:?no publish run appeared after the dispatch; wait for it and re-run this step}"
gh run watch --exit-status "$PUBLISH_RUN"
npm view pi-lingua version
```

Use `--no-git-tag-version` for the bump: `auto-release.yml` owns tag creation, and `npm version`
would leave a duplicate local tag behind.

`npm trust` allows exactly **one** configuration per package. To change it, read the id from
`npm trust list` and substitute it for `TRUST_ID`:

```bash
npm trust list pi-lingua
npm trust revoke pi-lingua --id=TRUST_ID
npm trust github pi-lingua --file publish.yml --repo eiei114/pi-lingua --allow-publish -y
```

The first trust request prompts for two-factor authentication. The npm website then offers to skip
2FA for the next five minutes, which is what makes bulk configuration practical.

### Checklist

- [ ] npm 11.15.0 or above locally (`npm --version`)
- [ ] 2FA enabled on the npm account
- [ ] `npm publish --access public` completed once manually
- [ ] `npm trust list pi-lingua` shows `eiei114/pi-lingua` + `publish.yml` with publish permission
- [ ] `id-token: write` present in `publish.yml`
- [ ] no `NPM_TOKEN` / `NODE_AUTH_TOKEN` anywhere (enforced by `npm run publish:guard`)
- [ ] Node.js 24 in the publish job
- [ ] provenance visible on the npm page for the first OIDC-published version
- [ ] the manually published first version is documented as having no provenance

## Publishing locally

A local `npm publish` is only correct for the **first** version, because Trusted Publishing cannot be
registered for a package that does not exist yet. Every version after that must go through
`publish.yml` so it carries provenance. Never add an `NPM_TOKEN` to make a workflow publish work;
`npm run publish:guard` rejects that on purpose.
