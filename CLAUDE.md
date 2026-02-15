# Git Treegazer - VSCode Extension

## Project Overview

Git Treegazer is a VSCode extension that visualizes git log graphs and provides git operations through a compact, information-dense UI. It supports multi-root workspaces, commit diff comparison, branch management, stash operations, and pre-merge/stash conflict detection.

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Target**: VSCode Extension API ^1.85.0
- **Runtime**: Node.js 18+
- **Git Library**: `simple-git` ^3.27.0
- **Bundler**: esbuild (custom `esbuild.js`)
- **No test framework configured**

## Build & Development

```bash
npm run compile    # Production build (minified)
npm run watch      # Development build with watch mode
npm run lint       # Type check (tsc --noEmit)
npm run package    # Build .vsix package (vsce package)
```

The build produces two bundles:
- `out/extension.js` — Extension host (CJS, Node.js, externals: `vscode`)
- `out/webview/main.js` — Webview UI (IIFE, browser)

## Architecture

### Entry Point

`src/extension.ts` — Activates on `onStartupFinished`. Initializes `RepoManager`, registers views (Log webview panel, Branch tree, Stash tree), registers all commands, sets up a git file watcher for auto-refresh (debounced 500ms).

### Directory Layout

```
src/
├── extension.ts              # Extension activation & wiring
├── types.ts                  # Shared types (GitCommit, GitBranch, GitStash, DiffFile, messages)
├── constants.ts              # Command IDs, view IDs, colors
├── services/
│   ├── gitService.ts         # Git operations via simple-git (log, diff, branches, stash, etc.)
│   ├── repoManager.ts        # Multi-repo detection & active repo management
│   └── conflictDetector.ts   # Pre-merge/stash conflict detection (merge-tree + fallback)
├── commands/
│   ├── commitCommands.ts     # Commit diff, compare, copy hash commands
│   ├── branchCommands.ts     # Create, delete, checkout, merge, fetch commands
│   └── stashCommands.ts      # Stash create, apply, pop, drop, show diff commands
├── views/
│   ├── logPanel.ts           # WebviewViewProvider + WebviewPanel for log view
│   ├── branchTreeProvider.ts # TreeDataProvider for branches (tracked/local/remote groups)
│   └── stashTreeProvider.ts  # TreeDataProvider for stashes
└── webview/
    ├── main.ts               # Webview entry point (event handling, DOM rendering, context menus)
    ├── graphRenderer.ts       # Git graph lane calculation algorithm
    └── commitList.ts          # Ref classification, ref icons (SVG), date formatting
```

### Key Patterns

- **Message passing**: Extension ↔ Webview communication uses typed messages (`WebviewMessage` and `ExtensionMessage` in `types.ts`)
- **Webview rendering**: Pure DOM manipulation (no framework). Graph is drawn on `<canvas>` elements per row.
- **Disposable pattern**: All views/providers implement `vscode.Disposable` and register into `context.subscriptions`
- **Multi-repo**: `RepoManager` detects repos in workspace folders and immediate subdirectories. Active repo can be switched via QuickPick or webview dropdown.
- **Conflict detection**: `ConflictDetector` uses `git merge-tree` (3-way, Git 2.38+) with a fallback to `--no-commit` merge + abort.

### Webview

- Excluded from `tsconfig.json` (compiled separately by esbuild as IIFE for browser)
- Uses `acquireVsCodeApi()` for state persistence and message passing
- Column widths are resizable and persisted via webview state
- Custom context menus for commits and refs (checkout, cherry-pick, revert, reset, merge, delete)

### Views Contributed

| View ID | Type | Container |
|---|---|---|
| `gitTreegazer.log` | Webview | Activity bar (Git Treegazer) |
| `gitTreegazer.branches` | Tree | Activity bar (Git Treegazer) |
| `gitTreegazer.stashes` | Tree | Activity bar (Git Treegazer) |

### URI Scheme

Uses `git-treegazer:` URI scheme with JSON-encoded query params (`{ ref, path }`) for showing file content at specific commits via `TextDocumentContentProvider`.

## Coding Conventions

- Strict TypeScript with `ES2022` target
- Double quotes for strings
- Semicolons required
- 2-space indentation
- Error handling: catch blocks display messages via `vscode.window.showErrorMessage`
- Git operations use `simple-git` raw commands with custom format separators (`---GIT_TREEGAZER_SEP---`, `---GIT_TREEGAZER_FIELD---`)
- Constants centralized in `src/constants.ts`
- Types centralized in `src/types.ts`

## Important Notes

- The webview `src/webview/` directory is excluded from `tsconfig.json` — it's bundled separately by esbuild targeting browser
- `DEFAULT_LOG_COUNT` is 200 commits per request
- Graph colors are defined in `GRAPH_COLORS` (10 colors cycling)
- The extension watches `.git/{HEAD,refs/**,index}` for auto-refresh
