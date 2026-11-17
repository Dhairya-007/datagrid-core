# Releasing

The package is ready to publish. Everything below has already been checked on
this machine; the only step left needs your npm credentials.

## Publish 0.1.0

```sh
npm login            # a browser sign-in; only you can do this
npm run verify       # typecheck, lint, format, 729 tests, build
npm publish          # the name `gridcore` was unclaimed as of 2026-11-17
```

`npm publish` runs the build again through `prepublishOnly`, so what goes up
is built from the tree you are standing in.

If you would rather publish from CI — so that the version on npm is always a
commit in the history — add an `NPM_TOKEN` secret with publish rights and
push a tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/publish.yml` picks that up, re-runs `npm run verify` and
publishes with provenance.

## What was verified before this was called done

- `npm run verify`: typecheck, eslint, prettier, **729 tests in 39 files**,
  and the dual ESM/CJS build with declarations.
- `examples/quickstart.ts` runs and prints a grouped, sorted, formatted grid
  and its CSV export.
- The built package installed into a scratch project and was consumed
  through **both** `import` and `require`, from both entry points
  (`gridcore` and `gridcore/advanced`).
- A consumer typechecked against the published types under `NodeNext`
  resolution, including that `isDataRow(row)` narrows back to the row type.
- `npm pack --dry-run`: 18 files, 833 kB packed. Only `dist`, the readme,
  the changelog and the licence ship.

## Before or just after the first publish

- **Create the GitHub repository** `Dhairya-007/gridcore` and push, or the
  `repository` and `homepage` links on the npm page will 404. The remote is
  not configured here on purpose.
- The npm page renders `README.md`, so that is the shop window.

## Afterwards

Version with semver and keep the changelog honest:

- a new export or a new option is a **minor**;
- a changed default, a renamed export or a behavioural change nobody can
  compile their way out of is a **major**, and says so at the top of the
  changelog entry;
- anything a user cannot observe is a **patch**.
