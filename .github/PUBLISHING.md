# Publishing

The [verify-and-release workflow](workflows/release.yml) checks pull requests and pushes to `main` on Node.js 22 and 24. It installs locked dependencies, verifies registry signatures and provenance attestations, and runs the complete source and package checks before any release automation runs.

## Release flow

1. Merge normal pull requests with squash merging. The pull request title becomes the commit message on `main`.
2. After the push passes verification, [Release Please](https://github.com/googleapis/release-please) reads the Conventional Commits since the last release and creates or updates a release pull request.
3. The release pull request contains the generated `CHANGELOG.md` and updates `package.json`, `package-lock.json`, and `.release-please-manifest.json` to the proposed version. Additional changes merged into `main` update the same release pull request.
4. Merging the release pull request runs verification again. Release Please then creates the `v<version>` tag and GitHub release, and the workflow publishes that exact commit to npm.

`fix:` proposes a patch, `feat:` a minor, and a breaking change a major. Commits such as `docs:`, `ci:`, and `chore:` are not releasable by default. A scoped `fix(ci):` is still a fix and therefore proposes a patch; use the commit type that reflects whether the published package changed.

To force a specific next version, add a `Release-As: x.y.z` footer to a commit on `main`. Do not manually edit version files outside a generated release pull request.

## GitHub authentication

Release Please uses the repository secret `RELEASE_PLEASE_TOKEN`, containing a fine-grained personal access token limited to this repository with read/write access to Contents, Issues, and Pull requests. A personal token is used instead of `GITHUB_TOKEN` so creation and updates of the release pull request trigger the normal pull request checks.

Rotate the token before it expires. The Release Please action is pinned to an immutable commit in the workflow.

## npm trusted publishing

npm publication uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/) through OIDC, with no stored npm token. Configure the GitHub Actions trusted publisher with these values:

| Setting              | Value                                       |
| -------------------- | ------------------------------------------- |
| Organization or user | `ajhaining`                                 |
| Repository           | `aws-lambda-fetch-adapter`                  |
| Workflow filename    | `release.yml`                               |
| Environment name     | `npm`                                       |
| Allowed actions      | Enable direct publishing with `npm publish` |

The publish job targets the branch-restricted `npm` GitHub environment and grants `id-token: write`. `NPM_TOKEN` and `NODE_AUTH_TOKEN` must remain absent so npm uses the trusted-publisher identity. A `registry-url` override is unnecessary because `publishConfig.registry` already selects npmjs.org.

Trusted publishing requires a GitHub-hosted runner, Node.js 22.14 or later, and npm 11.5.1 or later. The workflow's Node.js and npm versions satisfy those requirements and must not be lowered past them.

## Provenance and repository visibility

The npm package is public. While the GitHub repository is private, publishing still uses OIDC but npm cannot generate provenance. The workflow therefore sets `NPM_CONFIG_PROVENANCE` from repository visibility: false while private, then automatically true after the repository becomes public.

`publishConfig.provenance` is intentionally omitted from `package.json` so it cannot override this workflow setting.
