# Contributing to Thaumic Cast

Thank you for your interest in contributing! We use a Monorepo structure managed by `bun`.

## Getting Started

1.  **Prerequisites:**
    - [Bun](https://bun.sh/) (v1.0+)
    - [Rust](https://www.rust-lang.org/) (latest stable)

2.  **Install Dependencies:**

    ```bash
    bun install
    ```

3.  **Development:**
    - Desktop App: `bun run dev:desktop`
    - Extension: `bun run dev:extension`

## Building

Release builds for distribution:

```bash
bun run build:desktop          # Current platform
bun run build:desktop:windows  # Windows (x64)
bun run build:desktop:linux    # Linux (x64)
bun run build:desktop:macos    # macOS (ARM64)
bun run build:extension        # Chrome extension
```

For debug builds (with debug symbols, no optimization), append `-- --debug`:

```bash
bun run build:desktop:windows -- --debug
```

## Monorepo Structure

- `apps/desktop`: Rust (Tauri) backend + Preact frontend.
- `apps/extension`: Chrome Extension (Manifest V3).
- `apps/server`: Headless server binary.
- `packages/thaumic-core`: Shared Rust library (Sonos, streaming, API).
- `packages/protocol`: Shared Types/Interfaces.
- `packages/shared`: Shared TypeScript utilities.
- `packages/ui`: Shared UI components.

## Commit Standards

We use **Conventional Commits** to automate versioning.

Format: `<type>(<scope>): <description>`

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
- **Scopes:** `desktop`, `extension`, `server`, `protocol`, `core`, `ui`, `docs`, `ci`, `deps`.

Examples:

- `feat(desktop): implement wav streaming support`
- `fix(extension): resolve audio dropout on tab switch`
- `docs: update installation instructions`

## Versioning

We use [Changesets](https://github.com/changesets/changesets).

If you make a change that requires a version bump, run:

```bash
bun changeset
```

Follow the prompts to select the package and bump type (major/minor/patch).

### Protocol versioning

The wire format between the extension and the companion (`apps/desktop`,
`apps/server`) is versioned independently via `@thaumic-cast/protocol`. The
extension auto-updates through the Chrome Web Store but the companion does not,
so version drift is common — the extension relies on the `protocolVersion`
field returned in the WebSocket handshake ACK to detect incompatible companions
and nudge users to update.

Three places hold the wire version; all three must agree:

- `packages/protocol/package.json` — the package's npm-style semver. This is
  the source of truth; the other two are kept in sync from here.
- `packages/protocol/src/websocket.ts` — the exported `PROTOCOL_VERSION`
  constant the extension embeds.
- `packages/thaumic-core/src/protocol_constants.rs` — the Rust `PROTOCOL_VERSION`
  the companion emits in the handshake ACK.

`bun run sync-versions` (invoked automatically by `bun run changeset:version`
during a release) propagates the `package.json` version into the two
`PROTOCOL_VERSION` constants. You never edit those two constants by hand; diffs
against them only appear in release PRs, not feature PRs. If `sync-versions`
can't locate either constant (e.g. the declaration syntax changed), it exits
non-zero and fails the release loudly rather than shipping stale values.

`MIN_COMPATIBLE_PROTOCOL_VERSION` in `packages/shared/src/constants.ts` is
different: it _is_ a hand-edited feature-PR concern, since bumping it is a
product decision, not a mechanical sync. See step 2 below.

Note: `@thaumic-cast/desktop`, `@thaumic-cast/extension`, and
`@thaumic-cast/server` are in a `fixed` group (see `.changeset/config.json`),
so bumping any one of them automatically bumps the others to match. The
`protocol`, `core`, and `shared` packages are independent and should be
listed explicitly in the changeset when they change.

When you change the wire format:

1. Run `bun run changeset` to record the change (this creates a changeset file
   but does _not_ yet modify any `package.json`). Bump `@thaumic-cast/protocol`:
   - **Minor** for additive, backwards-compatible changes (a new optional
     field, a new message type older clients can ignore).
   - **Major** for breaking changes (removing or renaming a field, changing
     semantics, tightening a previously-permissive field).
     The release pipeline (`bun run changeset:version`, run at release time,
     not on the feature branch) applies the bump to `package.json` and then
     invokes `sync-versions` to propagate the two `PROTOCOL_VERSION` constants.
2. Decide whether to raise `MIN_COMPATIBLE_PROTOCOL_VERSION` in
   `packages/shared/src/constants.ts`. Unlike `PROTOCOL_VERSION`, this is
   edited by hand in the feature PR. `MIN_COMPATIBLE_PROTOCOL_VERSION` is a
   watermark: once set to `X.Y.Z`, the extension surfaces the out-of-date
   warning Alert for any companion reporting a `protocolVersion` below
   `X.Y.Z`. Companions that omit the field entirely (pre-0.4.0 builds) are
   treated as "unknown, assume compatible" and never warned.
   - **Always** bump MIN on a major wire change — older companions will
     actually break playback, so we want to prompt aggressively.
   - **Optionally** bump MIN on a minor change if you want users to
     proactively pick up the improvement (e.g. the new field fixes a UX bug
     that only older extensions paper over).
   - **Skip** a MIN bump for patch-level changes or when older companions
     keep working fine.
3. Describe the change in the changeset body. Include enough detail for a user
   to understand why they're seeing the update prompt.

## Code Style

- **Linting:** ESLint + Prettier + Stylelint run automatically on commit.
- **Documentation:** JSDoc comments are required for all exported functions.
- **CSS:** Use modern CSS with logical properties (e.g., `margin-inline` not `margin-left`).

## Pull Requests

1.  **Branch:** Create a feature branch from `main`.
    ```bash
    git checkout -b feat/my-feature
    ```
2.  **Commit:** Make atomic commits following the commit standards above.
3.  **Changeset:** If your change affects package versions, run `bun changeset`.
4.  **Push:** Push your branch and open a PR.
    ```bash
    git push -u origin feat/my-feature
    ```
5.  **Review:** Ensure CI passes and address any feedback.
