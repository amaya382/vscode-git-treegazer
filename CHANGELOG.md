# Changelog

## 0.1.0 — Initial Release

### Git Log Graph
- Interactive git log graph with color-coded branch lanes and lane calculation
- Commit details table with message, author, hash, and date
- Resizable columns with persistent widths
- Click a commit to view changed files and diffs
- Ctrl+click to compare any two commits
- Uncommitted changes and stashes displayed inline
- "Load More" pagination (200 commits per page)
- Auto-refresh via file system watcher on `.git/` directory
- Status bar item with current branch and quick access to the log
- Available in both the sidebar and the SCM panel

### Ref Badges
- Local branches, remote branches, and tags as colored badges
- Ahead/behind indicators (↑/↓) for tracked branches
- Worktree indicators for branches checked out in other worktrees
- Configurable prefix abbreviation (e.g., `feature/auth` → `f/auth`)

### GitHub Pull Request Integration
- PR badges with state indicators (open/draft/closed/merged) and clickable links
- Multiple detection methods: GitHub API, branch-based lookup, git config patterns, commit message patterns
- VSCode built-in GitHub authentication
- Rate limiting handling with user notifications

### Filtering
- Filter by branch name (include/exclude)
- Filter by commit message (include/exclude)
- Filter by author (dropdown select)
- "Merges only" toggle
- Containment filter: show only commits within a specific branch

### Branch Management
- Create, rename, delete branches
- Checkout local and remote branches
- Merge and rebase
- Push, pull, and fetch with tracking info
- Grouped tree view: Tracked / Local / Remote

### Interactive Rebase
- Full interactive rebase UI with pick, reword, edit, squash, fixup, drop
- Drag-and-drop reordering of commits
- Color-coded action indicators
- Context commits shown before/after rebase range
- Continue, abort, and skip operations
- Rebase state tracking across all worktrees
- Conflict detection and display

### Stash Management
- Create, apply, pop, drop, rename stashes
- View stash diffs with changed file details
- Create branch from stash
- Copy stash name
- Stashes displayed inline on the git log graph

### Worktree Management
- Dedicated tree view for all worktrees
- Create and remove worktrees
- Open worktree in a new window or add to current workspace
- **baretree integration**: create worktrees via baretree, default worktree badges, recommended actions in context menus
- Post-create actions (symlink, copy, command) and sync-to-root configuration
- Worktree lifecycle notifications (prompts to clean up merged worktrees)

### Tag Management
- Create tags from any commit
- Delete tags
- Push tags to remote

### Git Config & Remote Management
- Browse and edit git config entries (local & global)
- Add, rename, remove remotes
- Set remote URLs
- Copy config values

### Context Menus
- Commit: show diff, compare, copy hash, create branch/tag/worktree, cherry-pick, revert, reset (soft/mixed/hard)
- Ref badge: checkout, merge, rebase, interactive rebase, create worktree, push/pull, rename, delete, copy name
- Stash: show diff, apply, pop, drop, rename, create branch, copy name

### Conflict Detection
- Pre-merge and pre-stash conflict detection using `git merge-tree` (Git 2.38+)
- Automatic fallback for older Git versions

### Multi-Root Workspace
- Full support for multi-root workspaces with repository switching
- Repository selector in tree views and webview
- Synchronization with VSCode's built-in SCM view
