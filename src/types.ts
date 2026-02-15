export interface GitCommit {
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  parentHashes: string[];
  refs: string[];
  isMergeCommit: boolean;
  filteredParentHashes?: string[];
  prInfo?: PullRequestInfo;
  isBranchTip?: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
  commitHash: string;
  ahead?: number;
  behind?: number;
}

export interface GitStash {
  index: number;
  message: string;
  date: string;
  hash: string;
  parentHash: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
}

export interface ConflictResult {
  hasConflicts: boolean;
  conflictedFiles: string[];
}

export interface RepoInfo {
  name: string;
  path: string;
  group?: string;
  branch?: string;
}

export interface WorktreeBranchEntry {
  name: string;
  path: string;
  isManaged?: boolean;
  isDefault?: boolean;
  isMerged?: boolean;
}

export interface BaretreeWorktreeEntry {
  path: string;
  head: string;
  branch: string;
  isMain: boolean;
  isBare: boolean;
}

export type PostCreateActionType = "symlink" | "copy" | "command";

export interface PostCreateAction {
  type: PostCreateActionType;
  source: string;
  managed: boolean;
}

export interface SyncToRootEntry {
  source: string;
  target: string;
}

export interface MergedCommitSummary {
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  date: string;
}

export interface PullRequestInfo {
  number: number;
  title?: string;
  url?: string;
  state?: "open" | "draft" | "closed" | "merged";
  source: "pattern" | "github-api" | "git-config";
  sourceBranch?: string;
}

export interface LogFilter {
  mergesOnly?: boolean;
  containingCommit?: string;
  withinRef?: string;
  branchMatch?: string;
  branchExclude?: string;
  messageMatch?: string;
  messageExclude?: string;
  authorMatch?: string;
  authorExclude?: string;
}

export interface LayoutOptions {
  abbreviateRefPrefixes: number;
}

// Interactive Rebase types
export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface RebaseTodoEntry {
  action: RebaseAction;
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  date: string;
  parentHashes: string[];
  newMessage?: string;
}

export interface RebaseState {
  isRebasing: boolean;
  currentStep?: number;
  totalSteps?: number;
  conflictedFiles?: string[];
}

export interface WorktreeRebaseState {
  branch: string;
  worktreePath: string;
  currentStep?: number;
  totalSteps?: number;
  hasConflicts: boolean;
}

export interface RebaseContextCommit {
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  date: string;
  parentHashes: string[];
}

export type GitConfigScope = "local" | "global";

export interface GitConfigEntry {
  key: string;
  value: string;
  scope: GitConfigScope;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

// Webview → Extension messages
export type WebviewMessage =
  | { type: "requestLog"; count: number; skip: number; filter?: LogFilter }
  | { type: "setFilter"; filter: LogFilter }
  | { type: "requestCommitContainment"; hash: string }
  | { type: "selectCommit"; hash: string }
  | { type: "requestCommitDetail"; hash: string }
  | { type: "compareCommits"; hash1: string; hash2: string }
  | { type: "requestCompareDetail"; hash1: string; hash2: string }
  | { type: "copyHash"; hash: string }
  | { type: "checkoutCommit"; hash: string }
  | { type: "createBranchFromCommit"; hash: string }
  | { type: "cherryPick"; hash: string }
  | { type: "revertCommit"; hash: string }
  | { type: "resetToCommit"; hash: string }
  | { type: "createTagAtCommit"; hash: string }
  | { type: "mergeCommit"; hash: string }
  | { type: "rebaseOntoCommit"; hash: string }
  | { type: "checkoutRef"; ref: string; refType: "branch" | "remote" | "tag" | "head" }
  | { type: "mergeRef"; ref: string }
  | { type: "deleteRef"; ref: string; refType: "branch" | "remote" | "tag" }
  | { type: "deleteTag"; tag: string }
  | { type: "pushTag"; tag: string }
  | { type: "copyBranchName"; branch: string }
  | { type: "rebaseOntoRef"; ref: string }
  | { type: "interactiveRebaseOntoRef"; ref: string }
  | { type: "pushRef"; ref: string }
  | { type: "pullRef"; ref: string }
  | { type: "renameRef"; ref: string }
  | { type: "copyTagName"; tag: string }
  | { type: "openDiff"; hash: string; filePath: string; oldPath?: string; status: string }
  | { type: "openDiffBetween"; hash1: string; hash2: string; filePath: string; oldPath?: string }
  | { type: "fetch" }
  | { type: "refresh" }
  | { type: "selectRepo"; path: string }
  | { type: "setLayoutOption"; key: keyof LayoutOptions; value: LayoutOptions[keyof LayoutOptions] }
  | { type: "ready" }
  | { type: "requestPRInfo"; hashes: string[] }
  | { type: "openUrl"; url: string }
  | { type: "requestGitConfig" }
  | { type: "editGitConfig"; key: string; value: string; scope: GitConfigScope }
  | { type: "addGitConfig"; key: string; value: string; scope: GitConfigScope }
  | { type: "removeGitConfig"; key: string; scope: GitConfigScope }
  | { type: "addRemote"; name: string; url: string }
  | { type: "removeRemote"; name: string }
  | { type: "renameRemote"; oldName: string; newName: string }
  | { type: "setRemoteUrl"; name: string; url: string }
  | { type: "openWorktree"; branch: string }
  | { type: "selectWorktreeRepo"; branch: string }
  | { type: "createWorktreeFromRef"; ref: string; refType: "branch" | "remote" | "head" }
  | { type: "createWorktreeWithBaretreeFromRef"; ref: string; refType: "branch" | "remote" | "head" }
  | { type: "createWorktreeFromCommit"; hash: string }
  | { type: "createWorktreeWithBaretreeFromCommit"; hash: string }
  | { type: "renameWorktree"; branch: string }
  | { type: "renameWorktreeWithBaretree"; branch: string }
  | { type: "deleteWorktree"; branch: string }
  | { type: "deleteWorktreeWithBaretree"; branch: string }
  | { type: "addWorktreeToWorkspace"; branch: string }
  | { type: "requestAuthors" }
  | { type: "interactiveRebaseOntoCommit"; hash: string }
  | { type: "requestUncommittedDetail"; branch?: string }
  | { type: "openUncommittedDiff"; filePath: string; oldPath?: string; status: string; section: "staged" | "unstaged" | "untracked"; branch?: string }
  | { type: "requestStashDetail"; index: number }
  | { type: "stashApply"; index: number }
  | { type: "stashPop"; index: number }
  | { type: "stashDrop"; index: number }
  | { type: "stashCopyName"; index: number }
  | { type: "stashCreateBranch"; index: number }
  | { type: "stashRename"; index: number }
  | { type: "exitRebaseMode" }
  | { type: "startRebase"; entries: RebaseTodoEntry[] }
  | { type: "inlineRebaseContinue" }
  | { type: "inlineRebaseAbort" }
  | { type: "inlineRebaseSkip" }
  | { type: "worktreeRebaseContinue"; branch: string; worktreePath: string }
  | { type: "worktreeRebaseAbort"; branch: string; worktreePath: string }
  | { type: "worktreeRebaseSkip"; branch: string; worktreePath: string };

// Extension → Webview messages
export type ExtensionMessage =
  | {
      type: "logData";
      commits: GitCommit[];
      totalCount: number;
      currentBranch: string;
      remoteNames: string[];
      worktreeBranches: Record<string, WorktreeBranchEntry>;
      branchDivergence: Record<string, { ahead: number; behind: number }>;
      activeFilter?: LogFilter;
      isReset?: boolean;
      uncommittedChanges?: {
        hasChanges: boolean;
        staged: number;
        unstaged: number;
        untracked: number;
      };
      worktreeUncommitted?: Record<string, { staged: number; unstaged: number; untracked: number }>;
      worktreeRebaseStates?: WorktreeRebaseState[];
      stashes?: GitStash[];
      baretreeAvailable?: boolean;
    }
  | {
      type: "commitContainment";
      hash: string;
      branches: string[];
      tags: string[];
    }
  | {
      type: "commitDetail";
      hash: string;
      author: string;
      authorEmail: string;
      committer: string;
      committerEmail: string;
      date: string;
      message: string;
      parentHashes: string[];
      files: DiffFile[];
      mergedCommits?: MergedCommitSummary[];
      prInfo?: PullRequestInfo;
    }
  | {
      type: "uncommittedDetail";
      stagedFiles: DiffFile[];
      unstagedFiles: DiffFile[];
      untrackedFiles: string[];
      staged: number;
      unstaged: number;
      untracked: number;
    }
  | {
      type: "compareDetail";
      hash1: string;
      hash2: string;
      files: DiffFile[];
      commit1: { hash: string; abbreviatedHash: string; author: string; date: string; message: string };
      commit2: { hash: string; abbreviatedHash: string; author: string; date: string; message: string };
    }
  | { type: "repoList"; repos: RepoInfo[]; activeRepo: string }
  | { type: "layoutOptions"; options: LayoutOptions }
  | { type: "prInfo"; data: Record<string, PullRequestInfo | null> }
  | { type: "error"; message: string }
  | { type: "loading"; loading: boolean }
  | { type: "gitConfig"; entries: GitConfigEntry[]; remotes: GitRemoteInfo[] }
  | { type: "authorList"; authors: string[] }
  | { type: "stashDetail"; index: number; files: DiffFile[] }
  | { type: "rebaseModeData"; entries: RebaseTodoEntry[]; currentBranch: string; ontoRef: string; targetHashes: string[] }
  | { type: "rebaseModeExited" }
  | { type: "rebaseProgress"; state: RebaseState }
  | { type: "rebaseComplete"; success: boolean; message: string };
