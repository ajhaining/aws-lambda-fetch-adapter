# Repository Guide

## Toolchain and verification

- This is a single-package, ESM-only TypeScript library. It requires Node.js 22+; Volta pins Node.js 24.21.0 and npm 12.0.2 in `package.json`.
- Use `npm clean-install` for a lockfile-faithful install. `actions/setup-node` does not install the npm version in `volta.npm`; CI installs that version explicitly.
- `npm run check` is the canonical full check. Its order is format check, lint, typecheck, tests, clean build, then publint package checks.
- The pre-commit hook runs lint-staged (Oxfmt and auto-fixing Oxlint), then the full typecheck and test suite. Commit messages and pull request titles must follow Conventional Commits; squash merges use the pull request title.

## Package structure

- There is intentionally no root adapter export. The public entrypoints are `api-gateway-v1`, `api-gateway-v2`, and `function-url`; keep `package.json` exports and `tsdown.config.ts` entries in sync.
- `src/shared.ts` and `src/lambda-streaming.ts` are internal. Function URL buffered conversion delegates to API Gateway v2 because their payload shapes match.
- API Gateway v1 and Function URL support buffered and streaming handlers. API Gateway v2 supports buffered handlers only.
- `dist/` is ignored generated output. `npm run build` cleans and regenerates unbundled Node 22 ESM, declarations, declaration maps, and source maps; never edit `dist/` directly.
- Published files include non-test `src/*.ts` so installed declaration maps resolve to implementation sources. Do not remove those sources from the package without changing declaration-map behavior.
- Keep `@types/aws-lambda` as a production dependency: public declarations reference its `aws-lambda` module types.

## Focused tests

- Tests are colocated in `src/` and use Node's native test runner directly, with no Jest/Vitest loader: `npm test`.
- Run one file with `node --test src/api-gateway-v1.test.ts`.
- Run one named test with `node --test --test-name-pattern="preserves raw path encoding" src/api-gateway-v2.test.ts`.
- Test execution does not replace `npm run typecheck`; several generic event/authorizer compatibility checks exist only at compile time.
- Tests need no AWS service. Streaming tests mock and restore the Lambda-provided `awslambda` global. The native Fetch zstd test skips on Node versions without `zstdCompressSync`.

## Releases

- `main` is the only release branch. Release Please accumulates releasable commits in a generated release pull request; npm publishing occurs only after that pull request is merged.
- Squash merges use the pull request title as the commit Release Please analyzes. Use `fix:` for published fixes, `feat:` for features, and `docs:`, `ci:`, or `chore:` for non-package changes; `fix(ci):` still proposes a patch.
- Release Please owns `CHANGELOG.md`, the versions in `package.json`, `package-lock.json`, and `.release-please-manifest.json`, and `v<version>` tags. Override a proposal with a `Release-As: x.y.z` commit footer rather than hand-editing generated version changes.
- `RELEASE_PLEASE_TOKEN` is a fine-grained GitHub token used so generated release pull requests trigger CI. It is unrelated to npm authentication; see `.github/PUBLISHING.md` before changing its permissions or the release flow.
- The release job must remain attached to the GitHub `npm` environment. npm authentication is tokenless OIDC and requires direct `npm publish`; do not add `NPM_TOKEN` or `registry-url` setup.
- Provenance is intentionally disabled only while the GitHub repository is private and enables automatically when it becomes public.
