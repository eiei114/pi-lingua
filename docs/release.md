# Release

Releases publish `pi-lingua` to npm through **Trusted Publishing (OIDC)**. No long-lived npm token is
stored in this repository or in GitHub secrets.

## How a release happens

1. Bump the version and update this file plus `CHANGELOG.md` in the same change:

   ```bash
   npm version patch   # or minor / major
   git push
   ```

2. `.github/workflows/auto-release.yml` detects the `package.json` version change on `main`, creates
   the `v<version>` tag, publishes a GitHub Release, and dispatches `publish.yml` explicitly.
3. `.github/workflows/publish.yml` runs `npm run ci`, skips the version when it already exists on npm,
   and otherwise publishes with `id-token: write`.

Do not rely on `push.tags` alone. A tag created by `GITHUB_TOKEN` does not trigger a `push.tags`
workflow, which is why `auto-release.yml` dispatches `publish.yml` by hand.

## First publish / Trusted Publisher not configured

`npm publish` against a package that does not exist on npm yet, or one whose Trusted Publisher is not
configured, fails with `npm error code E404` on the `PUT`. That is different from a version that is
already published, which this workflow skips on purpose and reports as `skip=true`.

To fix an `E404`:

1. Sign in to npmjs.com and open the `pi-lingua` package (create it if this is the first publish).
2. Go to **Settings → Trusted Publisher → GitHub Actions**.
3. Set **Repository** to `eiei114/pi-lingua` and **Workflow filename** to `publish.yml`.
4. Re-run with `gh workflow run publish.yml --ref <tag> -f ref=<tag>`, or re-dispatch from the
   Actions tab (`workflow_dispatch` is enabled).

Checklist:

- [ ] `id-token: write` present in `publish.yml`
- [ ] no `NPM_TOKEN` / `NODE_AUTH_TOKEN` anywhere (enforced by `npm run publish:guard`)
- [ ] Node.js 24 in the publish job
- [ ] Trusted Publisher points at `eiei114/pi-lingua` and `publish.yml`
- [ ] provenance visible on npm after the first successful publish

## Publishing locally

Don't. `npm publish` from a workstation bypasses the provenance that Trusted Publishing provides.
`docs/publish-local-validation.md` covers the checks worth running locally before merging a bump.
