# Release

Releases publish `pi-lingua` to npm through **Trusted Publishing (OIDC)**. No long-lived npm token is
stored in this repository or in GitHub secrets.

## How a release happens

1. Bump the version and update `CHANGELOG.md` in the same change. Use `--no-git-tag-version`:
   `auto-release.yml` creates the tag, and `npm version` would leave a duplicate local tag behind.

   ```bash
   npm version patch --no-git-tag-version   # or minor / major
   # add `## [x.y.z] - YYYY-MM-DD` to CHANGELOG.md, or `npm run ci` will fail on the guardrail
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release x.y.z"
   git push
   ```

2. `.github/workflows/auto-release.yml` detects the `package.json` version change on `main`, creates
   the `v<version>` tag, publishes a GitHub Release, and dispatches `publish.yml` explicitly.
3. `.github/workflows/publish.yml` runs `npm run ci`, skips the version when it already exists on npm,
   and otherwise publishes with `id-token: write`.

Do not rely on `push.tags` alone. A tag created by `GITHUB_TOKEN` does not trigger a `push.tags`
workflow, which is why `auto-release.yml` dispatches `publish.yml` by hand.

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

# 4. verify. Name the publish run explicitly, because a bare `gh run watch` can pick up the CI run
#    from the same push, and it exits 0 on a failed run unless --exit-status is passed.
RUN=$(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch --exit-status "$RUN"
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
