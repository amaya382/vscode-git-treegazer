export const EXTENSION_ID = "gitTreegazer";
export const LOG_VIEW_ID = `${EXTENSION_ID}.log`;
export const BRANCHES_VIEW_ID = `${EXTENSION_ID}.branches`;
export const STASHES_VIEW_ID = `${EXTENSION_ID}.stashes`;
export const CONFIG_VIEW_ID = `${EXTENSION_ID}.config`;
export const WORKTREES_VIEW_ID = `${EXTENSION_ID}.worktrees`;
export const SCM_LOG_VIEW_ID = `${EXTENSION_ID}.scmLog`;

export const COMMANDS = {
  REFRESH_LOG: `${EXTENSION_ID}.refreshLog`,
  SHOW_COMMIT_DIFF: `${EXTENSION_ID}.showCommitDiff`,
  COMPARE_COMMITS: `${EXTENSION_ID}.compareCommits`,
  COPY_COMMIT_HASH: `${EXTENSION_ID}.copyCommitHash`,
  CREATE_BRANCH: `${EXTENSION_ID}.createBranch`,
  DELETE_BRANCH: `${EXTENSION_ID}.deleteBranch`,
  CHECKOUT: `${EXTENSION_ID}.checkout`,
  MERGE: `${EXTENSION_ID}.merge`,
  FETCH: `${EXTENSION_ID}.fetch`,
  STASH_CREATE: `${EXTENSION_ID}.stashCreate`,
  STASH_APPLY: `${EXTENSION_ID}.stashApply`,
  STASH_POP: `${EXTENSION_ID}.stashPop`,
  STASH_DROP: `${EXTENSION_ID}.stashDrop`,
  STASH_SHOW_DIFF: `${EXTENSION_ID}.stashShowDiff`,
  STASH_COPY_NAME: `${EXTENSION_ID}.stashCopyName`,
  STASH_CREATE_BRANCH: `${EXTENSION_ID}.stashCreateBranch`,
  STASH_RENAME: `${EXTENSION_ID}.stashRename`,
  RENAME_BRANCH: `${EXTENSION_ID}.renameBranch`,
  REBASE_ONTO: `${EXTENSION_ID}.rebaseOnto`,
  PUSH_BRANCH: `${EXTENSION_ID}.pushBranch`,
  PULL_BRANCH: `${EXTENSION_ID}.pullBranch`,
  COPY_BRANCH_NAME: `${EXTENSION_ID}.copyBranchName`,
  REFRESH_BRANCHES: `${EXTENSION_ID}.refreshBranches`,
  REFRESH_STASHES: `${EXTENSION_ID}.refreshStashes`,
  OPEN_IN_EDITOR: `${EXTENSION_ID}.openInEditor`,
  SELECT_REPO: `${EXTENSION_ID}.selectRepo`,
  REFRESH_CONFIG: `${EXTENSION_ID}.refreshConfig`,
  CONFIG_EDIT_VALUE: `${EXTENSION_ID}.configEditValue`,
  CONFIG_ADD_ENTRY: `${EXTENSION_ID}.configAddEntry`,
  CONFIG_REMOVE_ENTRY: `${EXTENSION_ID}.configRemoveEntry`,
  CONFIG_COPY_VALUE: `${EXTENSION_ID}.configCopyValue`,
  REMOTE_ADD: `${EXTENSION_ID}.remoteAdd`,
  REMOTE_REMOVE: `${EXTENSION_ID}.remoteRemove`,
  REMOTE_RENAME: `${EXTENSION_ID}.remoteRename`,
  REMOTE_SET_URL: `${EXTENSION_ID}.remoteSetUrl`,
  CREATE_WORKTREE: `${EXTENSION_ID}.createWorktree`,
  CREATE_WORKTREE_WITH_BARETREE: `${EXTENSION_ID}.createWorktreeWithBaretree`,
  OPEN_WORKTREE: `${EXTENSION_ID}.openWorktree`,
  SELECT_WORKTREE_REPO: `${EXTENSION_ID}.selectWorktreeRepo`,
  REFRESH_WORKTREES: `${EXTENSION_ID}.refreshWorktrees`,
  WORKTREE_ADD: `${EXTENSION_ID}.worktreeAdd`,
  WORKTREE_REMOVE: `${EXTENSION_ID}.worktreeRemove`,
  WORKTREE_ADD_TO_WORKSPACE: `${EXTENSION_ID}.addWorktreeToWorkspace`,
  WORKTREE_POST_CREATE_ADD: `${EXTENSION_ID}.worktreePostCreateAdd`,
  WORKTREE_POST_CREATE_REMOVE: `${EXTENSION_ID}.worktreePostCreateRemove`,
  WORKTREE_SYNC_TO_ROOT_ADD: `${EXTENSION_ID}.worktreeSyncToRootAdd`,
  WORKTREE_SYNC_TO_ROOT_REMOVE: `${EXTENSION_ID}.worktreeSyncToRootRemove`,
  INTERACTIVE_REBASE: `${EXTENSION_ID}.interactiveRebase`,
  REBASE_CONTINUE: `${EXTENSION_ID}.rebaseContinue`,
  REBASE_ABORT: `${EXTENSION_ID}.rebaseAbort`,
  REBASE_SKIP: `${EXTENSION_ID}.rebaseSkip`,
  SHOW_LOG: `${EXTENSION_ID}.showLog`,
} as const;

export const REBASE_ACTION_COLORS: Record<string, string> = {
  pick: "#51cf66",
  reword: "#339af0",
  edit: "#fcc419",
  squash: "#e8b05d",
  fixup: "#ff922b",
  drop: "#ff6b6b",
};

export const DEFAULT_LOG_COUNT = 200;
export const GRAPH_COLORS = [
  "#ff6b6b",
  "#51cf66",
  "#fcc419",
  "#339af0",
  "#e8b05d",
  "#22b8cf",
  "#ff922b",
  "#f06595",
  "#20c997",
  "#5c7cfa",
];
