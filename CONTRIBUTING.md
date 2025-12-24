# Contributing to Thaumic Cast

Thank you for your interest in contributing! We use a Monorepo structure managed by `bun`.

## Getting Started

1.  **Prerequisites:**
    - [Bun](https://bun.sh/) (v1.0+)
    - [Rust](https://www.rust-lang.org/) (latest stable)
    - Node.js (v18+)

2.  **Install Dependencies:**

    ```bash
    bun install
    ```

3.  **Development:**
    - Desktop App: `bun run dev:desktop`
    - Extension: `bun run dev:extension`

## Monorepo Structure

- `apps/desktop`: Rust (Tauri) backend + Preact frontend.
- `apps/extension`: Chrome Extension (Manifest V3).
- `packages/protocol`: Shared Types/Interfaces.
- `packages/ui`: Shared UI components.

## Commit Standards

We use **Conventional Commits** to automate versioning.

Format: `<type>(<scope>): <description>`

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
- **Scopes:** `desktop`, `extension`, `protocol`, `ui`, `docs`, `ci`, `deps`.

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
