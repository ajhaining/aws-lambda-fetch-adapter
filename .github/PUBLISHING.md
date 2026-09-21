# Publishing

The [verify-and-release workflow](workflows/release.yml) follows the [official semantic-release GitHub Actions recipe](https://semantic-release.org/recipes/ci-configurations/github-actions/): install locked dependencies, verify registry signatures and provenance attestations, run checks, then release only after verification succeeds.

Pull requests and pushes to `main` and `next` are checked on Node.js 22 and 24. Only pushes to those release branches can publish, and publications are serialized across both branches. Retry a failed run using GitHub's **Re-run jobs** control.

The release job uses `actions/setup-node` with `node-version-file: package.json`, which reads `volta.node` before `engines.node`. Because setup-node does not install `volta.npm`, both jobs explicitly install that npm version too. The release job uses a fresh, uncached dependency installation and runs `npm run release`, including its check/build pipeline.

## npm trusted publishing

Releases use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) through OIDC, with no stored npm token. Trusted publishing works while the source repository is private, although provenance does not. Configure the GitHub Actions trusted publisher with these values:

| Setting              | Value                                       |
| -------------------- | ------------------------------------------- |
| Organization or user | `ajhaining`                                 |
| Repository           | `aws-lambda-fetch-adapter`                  |
| Workflow filename    | `release.yml`                               |
| Environment name     | `npm`                                       |
| Allowed actions      | Enable direct publishing with `npm publish` |

The release job targets the protected `npm` GitHub environment and grants `id-token: write` for OIDC. It uses GitHub's automatic `GITHUB_TOKEN` for release tags, GitHub releases, and related issue/pull-request updates. No npm token is passed to the job.

`registry-url` is deliberately absent from setup-node, as recommended by semantic-release, so it does not create conflicting npm authentication configuration. The trusted publisher must allow direct `npm publish`; semantic-release does not use npm staged publishing.

## Versions and channels

- `main` publishes to the `latest` npm dist-tag.
- `next` publishes prereleases such as `1.1.0-next.1` to the `next` npm dist-tag. Merging those changes into `main` publishes a new stable version, such as `1.1.0`.
- Conventional Commits determine the release: `fix:` creates a patch, `feat:` a minor, and breaking changes a major. Changes such as `docs:` or `chore:` alone do not create a new version.
- The checked-in `0.0.0` is a placeholder. semantic-release updates the package version during publishing and records releases with Git tags; there is no version-bump commit to maintain.

Using a prerelease branch is intentional: npm's OIDC support does not cover `npm dist-tag`, which regular-version channel promotion would need. Prerelease-to-stable publishing creates a new version through `npm publish` instead. See the upstream [channel authentication issue](https://github.com/semantic-release/npm/issues/1023).

## Release notes and assets

`release.config.ts` explicitly configures the commit analyzer, release-notes generator, npm publisher, and GitHub publisher bundled with semantic-release. The npm plugin prepares a versioned tarball in `release/`; the GitHub plugin attaches it to the release along with the generated release notes.

The `aws-lambda-fetch-adapter-<version>.tgz` asset is the versioned npm package artifact, containing the built ESM modules, type declarations, maps, implementation sources, README, and license. Stable versions create regular GitHub releases; versions from `next` are marked as prereleases.

## Provenance and repository visibility

The npm package is public. While the GitHub repository is private, publishing still uses OIDC but npm cannot generate provenance. The workflow therefore sets `NPM_CONFIG_PROVENANCE` from repository visibility: false while private, then automatically true after the repository becomes public. The release job's `id-token: write` permission supplies the OIDC identity used for trusted publishing and provenance.

`publishConfig.provenance` is intentionally omitted from `package.json` so it cannot override this workflow setting. Making the source repository public enables provenance on subsequent releases without changing the workflow.
