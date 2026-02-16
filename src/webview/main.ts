import { renderGraph, type GraphLane } from "./graphRenderer";
import { COLORS, drawGraphRow } from "./graphDraw";
import { formatDate, getRefIcon, groupRefs, isGroupedRef, type RefInfo, type ResolvedRef } from "./commitList";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PullRequestInfo {
  number: number;
  title?: string;
  url?: string;
  state?: "open" | "draft" | "closed" | "merged";
  source: "pattern" | "github-api" | "git-config";
  sourceBranch?: string;
}

interface GitCommit {
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

interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
}

interface MergedCommitSummary {
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  date: string;
}

interface CommitDetail {
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

const vscode = acquireVsCodeApi();

function codicon(name: string, size?: number): string {
  const style = size ? ` style="font-size:${size}px"` : "";
  return `<span class="codicon codicon-${name}"${style}></span>`;
}

const FILE_STATUS_ICONS: Record<string, string> = {
  added: codicon("diff-added", 14),
  deleted: codicon("diff-removed", 14),
  modified: codicon("diff-modified", 14),
  renamed: codicon("diff-renamed", 14),
};

interface LogFilter {
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

const UNCOMMITTED_HASH = "__uncommitted__";

interface UncommittedInfo {
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

interface UncommittedDetail {
  stagedFiles: DiffFile[];
  unstagedFiles: DiffFile[];
  untrackedFiles: string[];
  staged: number;
  unstaged: number;
  untracked: number;
}

let commits: GitCommit[] = [];
let totalCount = 0;
let selectedHash: string | null = null;
let secondaryHash: string | null = null;
let expandedDetail: CommitDetail | null = null;
let detailLoading = false;
let graphLanes: GraphLane[][] = [];
let activeFilter: LogFilter = {};
let containmentInfo: { hash: string; branches: string[]; tags: string[] } | null = null;
const prInfoCache = new Map<string, PullRequestInfo | null>();
let prInfoRequested = new Set<string>();
let uncommittedInfo: UncommittedInfo | null = null;
let uncommittedDetail: UncommittedDetail | null = null;
let uncommittedDetailLoading = false;
let uncommittedDetailBranch: string | undefined = undefined;

const STASH_HASH_PREFIX = "__stash__";

interface StashEntry {
  index: number;
  message: string;
  date: string;
  hash: string;
  parentHash: string;
}

let stashEntries: StashEntry[] = [];
let stashDetail: { index: number; files: DiffFile[] } | null = null;
let stashDetailLoading = false;

interface CompareDetailData {
  hash1: string;
  hash2: string;
  files: DiffFile[];
  commit1: { hash: string; abbreviatedHash: string; author: string; date: string; message: string };
  commit2: { hash: string; abbreviatedHash: string; author: string; date: string; message: string };
}
let compareDetailData: CompareDetailData | null = null;
let compareLoading = false;

let currentBranch = "";
let baretreeAvailable = false;

const PR_ICONS: Record<string, string> = {
  open: codicon("git-pull-request", 12),
  draft: codicon("git-pull-request-draft", 12),
  closed: codicon("git-pull-request-closed", 12),
  merged: codicon("git-merge", 12),
  pending: codicon("git-pull-request", 12),
};

interface LayoutOptions {
  abbreviateRefPrefixes: number;
}
let layoutOptions: LayoutOptions = { abbreviateRefPrefixes: 0 };
let remoteNames: string[] = [];
let worktreeBranches: Map<string, { name: string; path: string; isManaged?: boolean; isDefault?: boolean; isMerged?: boolean }> = new Map();
let branchDivergence: Record<string, { ahead: number; behind: number }> = {};
let worktreeUncommitted: Record<string, { staged: number; unstaged: number; untracked: number }> = {};
let worktreeRebaseStates: Map<string, { worktreePath: string; currentStep?: number; totalSteps?: number; hasConflicts: boolean }> = new Map();

interface GitConfigEntry {
  key: string;
  value: string;
  scope: "local" | "global";
}

interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

let gitConfigEntries: GitConfigEntry[] = [];
let gitRemotes: GitRemoteInfo[] = [];

// --- Inline interactive rebase mode state ---
type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

interface RebaseTodoEntry {
  action: RebaseAction;
  hash: string;
  abbreviatedHash: string;
  message: string;
  author: string;
  date: string;
  parentHashes: string[];
  newMessage?: string;
}

interface RebaseState {
  isRebasing: boolean;
  currentStep?: number;
  totalSteps?: number;
  conflictedFiles?: string[];
}

let rebaseMode = false;
let rebaseOntoRef = "";
let rebaseCurrentBranch = "";
let rebaseEntries: Map<string, RebaseTodoEntry> = new Map();
let rebaseTargetHashes: Set<string> = new Set();
let rebaseInProgress = false;
let rebaseState: RebaseState | null = null;

const REBASE_ACTION_COLORS: Record<RebaseAction, string> = {
  pick: "#51cf66",
  reword: "#339af0",
  edit: "#fcc419",
  squash: "#e8b05d",
  fixup: "#ff922b",
  drop: "#ff6b6b",
};

const REBASE_ACTIONS: RebaseAction[] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

/** Returns the hash of the oldest commit in the rebase (first in git's processing order).
 *  squash/fixup cannot be used on this commit because there is no prior commit to squash into. */
function getRebaseOldestHash(): string | undefined {
  let last: string | undefined;
  for (const [hash] of rebaseEntries) {
    last = hash;
  }
  return last;
}

function isSquashAllowed(hash: string): boolean {
  return hash !== getRebaseOldestHash();
}

function appendRebaseIndicator(label: HTMLElement, branchName: string): void {
  const rebaseInfo = worktreeRebaseStates.get(branchName);
  if (!rebaseInfo) return;

  const wtPath = rebaseInfo.worktreePath;

  const badge = document.createElement("span");
  badge.className = "ref-badge ref-badge-rebase";
  const stepText = rebaseInfo.currentStep && rebaseInfo.totalSteps
    ? ` ${rebaseInfo.currentStep}/${rebaseInfo.totalSteps}`
    : "";
  badge.textContent = rebaseInfo.hasConflicts ? `REBASING${stepText} (conflict)` : `REBASING${stepText}`;
  badge.title = "Rebase in progress" + (rebaseInfo.hasConflicts ? " — has conflicts" : "");
  label.appendChild(badge);

  // Action buttons
  const btnGroup = document.createElement("span");
  btnGroup.className = "rebase-wt-actions";

  if (!rebaseInfo.hasConflicts) {
    const continueBtn = document.createElement("button");
    continueBtn.className = "rebase-wt-btn";
    continueBtn.title = "Continue rebase";
    continueBtn.innerHTML = `<span class="codicon codicon-debug-continue"></span>`;
    continueBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "worktreeRebaseContinue", branch: branchName, worktreePath: wtPath });
    });
    btnGroup.appendChild(continueBtn);

    const skipBtn = document.createElement("button");
    skipBtn.className = "rebase-wt-btn";
    skipBtn.title = "Skip current commit";
    skipBtn.innerHTML = `<span class="codicon codicon-debug-step-over"></span>`;
    skipBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "worktreeRebaseSkip", branch: branchName, worktreePath: wtPath });
    });
    btnGroup.appendChild(skipBtn);
  }

  const abortBtn = document.createElement("button");
  abortBtn.className = "rebase-wt-btn rebase-wt-btn-abort";
  abortBtn.title = "Abort rebase";
  abortBtn.innerHTML = `<span class="codicon codicon-debug-stop"></span>`;
  abortBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "worktreeRebaseAbort", branch: branchName, worktreePath: wtPath });
  });
  btnGroup.appendChild(abortBtn);

  label.appendChild(btnGroup);
}

// Column widths (resizable, persisted via vscode state)
interface ColumnWidths {
  graph: number;
  author: number;
  hash: number;
  date: number;
}

const DEFAULT_WIDTHS: ColumnWidths = { graph: 120, author: 70, hash: 56, date: 80 };

function loadWidths(): ColumnWidths {
  const state = vscode.getState() as { columnWidths?: ColumnWidths } | null;
  return state?.columnWidths ? { ...DEFAULT_WIDTHS, ...state.columnWidths } : { ...DEFAULT_WIDTHS };
}

function saveWidths(widths: ColumnWidths): void {
  const state = (vscode.getState() as Record<string, unknown>) || {};
  vscode.setState({ ...state, columnWidths: widths });
}

let columnWidths = loadWidths();

function applyWidths(): void {
  const root = document.documentElement;
  root.style.setProperty("--graph-width", `${columnWidths.graph}px`);
  root.style.setProperty("--author-width", `${columnWidths.author}px`);
  root.style.setProperty("--hash-width", `${columnWidths.hash}px`);
  root.style.setProperty("--date-width", `${columnWidths.date}px`);
}

const content = document.getElementById("content")!;
const repoSelect = document.getElementById("repoSelect") as HTMLSelectElement;
const fetchBtn = document.getElementById("fetchBtn")!;
const refreshBtn = document.getElementById("refreshBtn")!;

applyWidths();

fetchBtn.addEventListener("click", () => {
  fetchBtn.classList.add("spinning");
  const icon = fetchBtn.querySelector(".codicon")!;
  icon.className = "codicon codicon-sync";
  vscode.postMessage({ type: "fetch" });
});

refreshBtn.addEventListener("click", () => {
  refreshBtn.classList.add("spinning");
  vscode.postMessage({ type: "refresh" });
});

repoSelect.addEventListener("change", () => {
  vscode.postMessage({ type: "selectRepo", path: repoSelect.value });
});

const mergesOnlyToggle = document.getElementById("mergesOnlyToggle") as HTMLInputElement;
const containmentFilterChip = document.getElementById("containmentFilterChip")!;

mergesOnlyToggle.addEventListener("change", () => {
  activeFilter = { ...activeFilter, mergesOnly: mergesOnlyToggle.checked };
  commits = [];
  vscode.postMessage({ type: "setFilter", filter: activeFilter });
  updateFilterUI();
});

// --- Text filter inputs ---
const branchFilterInput = document.getElementById("branchFilterInput") as HTMLInputElement;
const messageFilterInput = document.getElementById("messageFilterInput") as HTMLInputElement;
const authorFilterInput = document.getElementById("authorFilterInput") as HTMLInputElement;
const branchNegateBtn = document.getElementById("branchNegateBtn")!;
const messageNegateBtn = document.getElementById("messageNegateBtn")!;
const authorNegateBtn = document.getElementById("authorNegateBtn")!;
const clearFiltersBtn = document.getElementById("clearFiltersBtn")!;

let branchNegate = false;
let messageNegate = false;
let authorNegate = false;

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function applyTextFilters(): void {
  const branchVal = branchFilterInput.value.trim();
  const messageVal = messageFilterInput.value.trim();

  const newFilter: LogFilter = {
    mergesOnly: activeFilter.mergesOnly,
    containingCommit: activeFilter.containingCommit,
    withinRef: activeFilter.withinRef,
  };

  if (branchVal) {
    if (branchNegate) {
      newFilter.branchExclude = branchVal;
    } else {
      newFilter.branchMatch = branchVal;
    }
  }

  if (messageVal) {
    if (messageNegate) {
      newFilter.messageExclude = messageVal;
    } else {
      newFilter.messageMatch = messageVal;
    }
  }

  if (selectedAuthor) {
    if (authorNegate) {
      newFilter.authorExclude = selectedAuthor;
    } else {
      newFilter.authorMatch = selectedAuthor;
    }
  }

  activeFilter = newFilter;
  commits = [];
  vscode.postMessage({ type: "setFilter", filter: activeFilter });
  updateClearButton();
}

const debouncedApplyFilters = debounce(applyTextFilters, 400);

branchFilterInput.addEventListener("input", debouncedApplyFilters);
messageFilterInput.addEventListener("input", debouncedApplyFilters);

for (const input of [branchFilterInput, messageFilterInput]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyTextFilters();
    }
  });
}

function toggleNegate(btn: HTMLElement, getCurrentState: () => boolean, setState: (v: boolean) => void, inputEl: HTMLInputElement): void {
  const newState = !getCurrentState();
  setState(newState);
  btn.textContent = newState ? "\u2212" : "+";
  btn.classList.toggle("active", newState);
  btn.title = newState ? "Excluding matches" : "Including matches";
  if (inputEl.value.trim()) {
    applyTextFilters();
  }
}

branchNegateBtn.addEventListener("click", () => {
  toggleNegate(branchNegateBtn, () => branchNegate, v => { branchNegate = v; }, branchFilterInput);
});
messageNegateBtn.addEventListener("click", () => {
  toggleNegate(messageNegateBtn, () => messageNegate, v => { messageNegate = v; }, messageFilterInput);
});
authorNegateBtn.addEventListener("click", () => {
  const newState = !authorNegate;
  authorNegate = newState;
  authorNegateBtn.textContent = newState ? "\u2212" : "+";
  authorNegateBtn.classList.toggle("active", newState);
  authorNegateBtn.title = newState ? "Excluding matches" : "Including matches";
  if (selectedAuthor) {
    applyTextFilters();
  }
});

clearFiltersBtn.addEventListener("click", () => {
  branchFilterInput.value = "";
  messageFilterInput.value = "";
  clearAuthorSelection();
  branchNegate = false;
  messageNegate = false;
  authorNegate = false;
  branchNegateBtn.textContent = "+";
  messageNegateBtn.textContent = "+";
  authorNegateBtn.textContent = "+";
  branchNegateBtn.classList.remove("active");
  messageNegateBtn.classList.remove("active");
  authorNegateBtn.classList.remove("active");
  branchNegateBtn.title = "Including matches";
  messageNegateBtn.title = "Including matches";
  authorNegateBtn.title = "Including matches";
  applyTextFilters();
});

function updateClearButton(): void {
  const hasFilter = !!(branchFilterInput.value.trim() || messageFilterInput.value.trim() || selectedAuthor);
  clearFiltersBtn.style.display = hasFilter ? "" : "none";
}

// Layout options gear menu
const layoutOptionsBtn = document.getElementById("layoutOptionsBtn")!;
const layoutOptionsMenu = document.getElementById("layoutOptionsMenu")!;
const abbreviateRefPrefixesInput = document.getElementById("abbreviateRefPrefixesInput") as HTMLInputElement;

layoutOptionsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isVisible = layoutOptionsMenu.style.display !== "none";
  layoutOptionsMenu.style.display = isVisible ? "none" : "";
});

document.addEventListener("click", () => {
  layoutOptionsMenu.style.display = "none";
});

layoutOptionsMenu.addEventListener("click", (e) => {
  e.stopPropagation();
});

abbreviateRefPrefixesInput.addEventListener("change", () => {
  vscode.postMessage({
    type: "setLayoutOption",
    key: "abbreviateRefPrefixes",
    value: Math.max(0, abbreviateRefPrefixesInput.valueAsNumber || 0),
  });
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "logData":
      handleLogData(msg);
      break;
    case "repoList":
      handleRepoList(msg);
      break;
    case "commitDetail":
      handleCommitDetail(msg);
      break;
    case "commitContainment":
      handleContainmentInfo(msg);
      break;
    case "layoutOptions":
      handleLayoutOptions(msg.options);
      break;
    case "gitConfig":
      handleGitConfig(msg.entries, msg.remotes);
      break;
    case "authorList":
      handleAuthorList(msg.authors);
      break;
    case "prInfo":
      handlePRInfo(msg.data);
      break;
    case "uncommittedDetail":
      handleUncommittedDetail(msg);
      break;
    case "stashDetail":
      handleStashDetail(msg);
      break;
    case "compareDetail":
      handleCompareDetail(msg);
      break;
    case "loading":
      handleLoading(msg.loading);
      break;
    case "error":
      content.innerHTML = `<div class="empty-state">${escapeHtml(msg.message)}</div>`;
      break;
    case "rebaseModeData":
      handleRebaseModeData(msg);
      break;
    case "rebaseModeExited":
      handleRebaseModeExited();
      break;
    case "rebaseProgress":
      handleRebaseProgress(msg);
      break;
    case "rebaseComplete":
      handleRebaseComplete(msg);
      break;
  }
});

function handleLayoutOptions(options: LayoutOptions): void {
  layoutOptions = options;
  abbreviateRefPrefixesInput.value = String(options.abbreviateRefPrefixes);
  render();
}

function abbreviateRefName(name: string, maxLength: number): string {
  const parts = name.split("/");
  if (parts.length <= 1) return name;
  return [...parts.slice(0, -1).map((p) => p.slice(0, maxLength)), parts[parts.length - 1]].join("/");
}

function handleLogData(data: { commits: GitCommit[]; totalCount: number; currentBranch: string; remoteNames: string[]; worktreeBranches?: Record<string, { name: string; path: string }>; branchDivergence?: Record<string, { ahead: number; behind: number }>; activeFilter?: LogFilter; isReset?: boolean; uncommittedChanges?: UncommittedInfo; worktreeUncommitted?: Record<string, { staged: number; unstaged: number; untracked: number }>; worktreeRebaseStates?: Array<{ branch: string; worktreePath: string; currentStep?: number; totalSteps?: number; hasConflicts: boolean }>; stashes?: StashEntry[]; baretreeAvailable?: boolean }): void {
  currentBranch = data.currentBranch;
  remoteNames = data.remoteNames;
  worktreeBranches = new Map(Object.entries(data.worktreeBranches || {}));
  baretreeAvailable = data.baretreeAvailable ?? false;
  branchDivergence = data.branchDivergence || {};
  worktreeUncommitted = data.worktreeUncommitted || {};
  worktreeRebaseStates = new Map();
  if (data.worktreeRebaseStates) {
    for (const s of data.worktreeRebaseStates) {
      worktreeRebaseStates.set(s.branch, { worktreePath: s.worktreePath, currentStep: s.currentStep, totalSteps: s.totalSteps, hasConflicts: s.hasConflicts });
    }
  }
  if (data.activeFilter) {
    activeFilter = data.activeFilter;
    mergesOnlyToggle.checked = !!activeFilter.mergesOnly;

    // Restore text filter inputs from activeFilter
    if (activeFilter.branchMatch) {
      branchFilterInput.value = activeFilter.branchMatch;
      branchNegate = false;
    } else if (activeFilter.branchExclude) {
      branchFilterInput.value = activeFilter.branchExclude;
      branchNegate = true;
    }
    branchNegateBtn.textContent = branchNegate ? "\u2212" : "+";
    branchNegateBtn.classList.toggle("active", branchNegate);

    if (activeFilter.messageMatch) {
      messageFilterInput.value = activeFilter.messageMatch;
      messageNegate = false;
    } else if (activeFilter.messageExclude) {
      messageFilterInput.value = activeFilter.messageExclude;
      messageNegate = true;
    }
    messageNegateBtn.textContent = messageNegate ? "\u2212" : "+";
    messageNegateBtn.classList.toggle("active", messageNegate);

    if (activeFilter.authorMatch) {
      selectAuthor(activeFilter.authorMatch, false);
      authorNegate = false;
    } else if (activeFilter.authorExclude) {
      selectAuthor(activeFilter.authorExclude, false);
      authorNegate = true;
    } else {
      clearAuthorSelection();
    }
    authorNegateBtn.textContent = authorNegate ? "\u2212" : "+";
    authorNegateBtn.classList.toggle("active", authorNegate);

    updateFilterUI();
    updateClearButton();
  }

  // Update uncommitted changes info
  if (data.uncommittedChanges) {
    uncommittedInfo = data.uncommittedChanges;
  } else if (data.isReset) {
    uncommittedInfo = null;
  }

  // Update stash entries
  if (data.stashes) {
    stashEntries = data.stashes;
  } else if (data.isReset) {
    stashEntries = [];
  }

  if (data.isReset) {
    // Full reset (repo switch, refresh, filter change)
    commits = data.commits;
    totalCount = data.totalCount;
    selectedHash = null;
    secondaryHash = null;
    expandedDetail = null;
    detailLoading = false;
    containmentInfo = null;
    uncommittedDetail = null;
    uncommittedDetailLoading = false;
    stashDetail = null;
    stashDetailLoading = false;
    compareDetailData = null;
    compareLoading = false;
    prInfoRequested = new Set<string>();
    prInfoCache.clear();
  } else if (data.commits.length === 0 && commits.length === 0) {
    commits = [];
    totalCount = data.totalCount;
  } else if (data.commits.length > 0 && data.commits[0].hash === commits[0]?.hash) {
    commits = data.commits;
    totalCount = data.totalCount;
  } else if (commits.length > 0 && data.commits[0]?.hash !== commits[0]?.hash) {
    const lastExisting = commits[commits.length - 1]?.hash;
    const firstNew = data.commits[0]?.hash;
    if (firstNew === lastExisting) {
      commits = [...commits, ...data.commits.slice(1)];
    } else {
      commits = [...commits, ...data.commits];
    }
    totalCount = data.totalCount;
  } else {
    commits = data.commits;
    totalCount = data.totalCount;
  }

  graphLanes = renderGraph(commits);
  render();
}

function handleRepoList(data: { repos: { name: string; path: string; group?: string; branch?: string }[]; activeRepo: string }): void {
  repoSelect.innerHTML = "";

  const grouped = new Map<string, typeof data.repos>();
  const ungrouped: typeof data.repos = [];

  for (const repo of data.repos) {
    if (repo.group) {
      if (!grouped.has(repo.group)) grouped.set(repo.group, []);
      grouped.get(repo.group)!.push(repo);
    } else {
      ungrouped.push(repo);
    }
  }

  for (const repo of ungrouped) {
    const opt = document.createElement("option");
    opt.value = repo.path;
    opt.textContent = repo.name;
    if (repo.path === data.activeRepo) opt.selected = true;
    repoSelect.appendChild(opt);
  }

  for (const [groupName, repos] of grouped) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;
    for (const repo of repos) {
      const opt = document.createElement("option");
      opt.value = repo.path;
      opt.textContent = `${repo.name} (${groupName})`;
      if (repo.path === data.activeRepo) opt.selected = true;
      optgroup.appendChild(opt);
    }
    repoSelect.appendChild(optgroup);
  }

  repoSelect.disabled = data.repos.length <= 1;
  vscode.postMessage({ type: "requestAuthors" });
}

function handleCommitDetail(detail: CommitDetail): void {
  expandedDetail = detail;
  detailLoading = false;
  render();
}

function handleLoading(loading: boolean): void {
  if (loading && commits.length === 0) {
    content.innerHTML = '<div class="loading">Loading...</div>';
  }
  if (!loading) {
    fetchBtn.classList.remove("spinning");
    const fetchIcon = fetchBtn.querySelector(".codicon")!;
    fetchIcon.className = "codicon codicon-cloud-download";
    refreshBtn.classList.remove("spinning");
  }
}

function buildHeaderRow(): HTMLElement {
  const header = document.createElement("div");
  header.className = "commit-row header-row";

  const cols: { label: string; cls: string; resizeKey?: keyof ColumnWidths; resizeHandleSide?: "left" | "right" }[] = [
    { label: "", cls: "graph-cell", resizeKey: "graph" },
    { label: "Message", cls: "message-cell" },
    { label: "Author", cls: "author-cell", resizeKey: "author", resizeHandleSide: "left" },
    { label: "Hash", cls: "hash-cell", resizeKey: "hash", resizeHandleSide: "left" },
    { label: "Date", cls: "date-cell", resizeKey: "date", resizeHandleSide: "left" },
  ];

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const cell = document.createElement("div");
    cell.className = col.cls;
    cell.textContent = col.label;
    cell.style.position = "relative";

    if (col.resizeKey) {
      const handle = document.createElement("div");
      handle.className = "resize-handle" + (col.resizeHandleSide === "left" ? " resize-handle-left" : "");
      const resizeDir = col.resizeHandleSide === "left" ? -1 : 1;
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startResize(col.resizeKey!, e.clientX, resizeDir);
      });
      cell.appendChild(handle);
    }

    header.appendChild(cell);

    // Insert action column header after graph cell in rebase mode
    if (i === 0 && rebaseMode) {
      const actionHeader = document.createElement("div");
      actionHeader.className = "rebase-action-cell";
      actionHeader.textContent = "Action";
      actionHeader.style.fontSize = "11px";
      actionHeader.style.fontWeight = "bold";
      actionHeader.style.cursor = "default";
      header.appendChild(actionHeader);
    }
  }

  return header;
}

function startResize(key: keyof ColumnWidths, startX: number, dir: number = 1): void {
  let prevX = startX;

  const onMouseMove = (e: MouseEvent) => {
    const delta = e.clientX - prevX;
    prevX = e.clientX;
    columnWidths[key] = Math.max(30, columnWidths[key] + delta * dir);
    applyWidths();
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    saveWidths(columnWidths);
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function render(): void {
  if (commits.length === 0 && !uncommittedInfo?.hasChanges) {
    content.innerHTML = '<div class="empty-state">No commits found</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  fragment.appendChild(buildHeaderRow());

  // Find the commit index for the current branch's tip
  let currentBranchTipIndex = -1;
  if (uncommittedInfo?.hasChanges && currentBranch) {
    for (let i = 0; i < commits.length; i++) {
      const isTip = commits[i].refs.some((ref) => {
        const cleaned = ref.replace(/^HEAD -> /, "");
        return cleaned === currentBranch;
      });
      if (isTip) {
        currentBranchTipIndex = i;
        break;
      }
    }
    // Fallback: if current branch tip not found, default to index 0
    if (currentBranchTipIndex < 0) currentBranchTipIndex = 0;
  }

  // Build a map of commit index → worktree branch names that have uncommitted changes
  // (includes both other worktrees and the current worktree when its tip is not at index 0)
  const wtUncommittedAtIndex = new Map<number, { branchName: string; summary: { staged: number; unstaged: number; untracked: number }; uncommittedCol: number; isCurrent?: boolean }[]>();

  // Add current worktree uncommitted to the map if its tip is not at index 0
  if (uncommittedInfo?.hasChanges && currentBranchTipIndex > 0) {
    const refLanes = graphLanes[currentBranchTipIndex] || [];
    let parentCol = 0;
    const nodeLane = refLanes.find((l) => l.type === "node" || l.type === "start");
    if (nodeLane) parentCol = nodeLane.column;
    const occupiedCols = new Set<number>();
    for (const lane of refLanes) {
      occupiedCols.add(lane.column);
      if (lane.fromColumn !== undefined) occupiedCols.add(lane.fromColumn);
      if (lane.toColumn !== undefined) occupiedCols.add(lane.toColumn);
    }
    let uncommittedCol = parentCol + 1;
    while (occupiedCols.has(uncommittedCol)) uncommittedCol++;

    if (!wtUncommittedAtIndex.has(currentBranchTipIndex)) wtUncommittedAtIndex.set(currentBranchTipIndex, []);
    wtUncommittedAtIndex.get(currentBranchTipIndex)!.push({ branchName: currentBranch, summary: uncommittedInfo, uncommittedCol, isCurrent: true });
  }

  for (const [branchName, summary] of Object.entries(worktreeUncommitted)) {
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      // Check if this commit is the tip of the worktree branch
      const isTip = commit.refs.some((ref) => {
        const cleaned = ref.replace(/^HEAD -> /, "");
        return cleaned === branchName;
      });
      if (isTip) {
        // Calculate the uncommitted column (first free column right of the parent node)
        const refLanes = graphLanes[i] || [];
        let parentCol = 0;
        const nodeLane = refLanes.find((l) => l.type === "node" || l.type === "start");
        if (nodeLane) parentCol = nodeLane.column;
        const occupiedCols = new Set<number>();
        for (const lane of refLanes) {
          occupiedCols.add(lane.column);
          if (lane.fromColumn !== undefined) occupiedCols.add(lane.fromColumn);
          if (lane.toColumn !== undefined) occupiedCols.add(lane.toColumn);
        }
        // Account for already-placed entries at the same index
        const existingEntries = wtUncommittedAtIndex.get(i);
        if (existingEntries) {
          for (const e of existingEntries) occupiedCols.add(e.uncommittedCol);
        }
        let uncommittedCol = parentCol + 1;
        while (occupiedCols.has(uncommittedCol)) uncommittedCol++;

        if (!wtUncommittedAtIndex.has(i)) wtUncommittedAtIndex.set(i, []);
        wtUncommittedAtIndex.get(i)!.push({ branchName, summary, uncommittedCol });
        break;
      }
    }
  }

  // Build a map of commit index → stash entries that should appear above that commit
  const stashAtIndex = new Map<number, { stash: StashEntry; stashCol: number }[]>();
  for (const stash of stashEntries) {
    for (let i = 0; i < commits.length; i++) {
      if (commits[i].hash === stash.parentHash) {
        const refLanes = graphLanes[i] || [];
        let parentCol = 0;
        const nodeLane = refLanes.find((l) => l.type === "node" || l.type === "start");
        if (nodeLane) parentCol = nodeLane.column;
        const occupiedCols = new Set<number>();
        for (const lane of refLanes) {
          occupiedCols.add(lane.column);
          if (lane.fromColumn !== undefined) occupiedCols.add(lane.fromColumn);
          if (lane.toColumn !== undefined) occupiedCols.add(lane.toColumn);
        }
        // Account for worktree uncommitted cols at the same index
        const wtEntries = wtUncommittedAtIndex.get(i);
        if (wtEntries) {
          for (const wt of wtEntries) occupiedCols.add(wt.uncommittedCol);
        }
        // Account for already-placed stash cols
        const existingStashes = stashAtIndex.get(i);
        if (existingStashes) {
          for (const s of existingStashes) occupiedCols.add(s.stashCol);
        }
        let stashCol = parentCol + 1;
        while (occupiedCols.has(stashCol)) stashCol++;

        if (!stashAtIndex.has(i)) stashAtIndex.set(i, []);
        stashAtIndex.get(i)!.push({ stash, stashCol });
        break;
      }
    }
  }

  // Patch "start" lanes to "node" for commits that have an uncommitted row directly above
  if (uncommittedInfo?.hasChanges && currentBranchTipIndex === 0 && graphLanes.length > 0) {
    for (const lane of graphLanes[0]) {
      if (lane.type === "start") {
        lane.type = "node";
      }
    }
  }
  // Also patch for worktree uncommitted at the top of the graph
  if (wtUncommittedAtIndex.has(0) && graphLanes.length > 0) {
    for (const lane of graphLanes[0]) {
      if (lane.type === "start") {
        lane.type = "node";
      }
    }
  }

  // Uncommitted changes row at the top (current worktree) — only when tip is at index 0
  if (uncommittedInfo?.hasChanges && currentBranchTipIndex === 0) {
    fragment.appendChild(buildUncommittedRow({
      laneIndex: 0,
      summary: uncommittedInfo,
      selectHash: UNCOMMITTED_HASH,
      label: "Uncommitted Changes",
      isTopRow: true,
    }));
    if (selectedHash === UNCOMMITTED_HASH) {
      fragment.appendChild(buildUncommittedDetailPanel());
    }
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];

    // Insert worktree uncommitted rows above this commit (includes current worktree when tip is not at index 0)
    const wtEntries = wtUncommittedAtIndex.get(i);
    if (wtEntries) {
      for (const entry of wtEntries) {
        const hasCurrentAbove = uncommittedInfo?.hasChanges && currentBranchTipIndex === 0;
        const isTop = i === 0 && !hasCurrentAbove;
        // At the top of the graph, draw as a straight line (like current worktree's uncommitted)
        // In the middle of the graph, draw as a branch-out
        const useAsBranch = !isTop;
        const wtSelectHash = entry.isCurrent ? UNCOMMITTED_HASH : `__wt_uncommitted_${entry.branchName}__`;
        const wtLabel = entry.isCurrent ? "Uncommitted Changes" : `Uncommitted (${entry.branchName})`;
        fragment.appendChild(buildUncommittedRow({
          laneIndex: i,
          summary: entry.summary,
          selectHash: wtSelectHash,
          label: wtLabel,
          isTopRow: isTop,
          asBranch: useAsBranch,
          uncommittedCol: useAsBranch ? entry.uncommittedCol : undefined,
          branch: entry.isCurrent ? undefined : entry.branchName,
        }));
        if (selectedHash === wtSelectHash) {
          fragment.appendChild(buildUncommittedDetailPanel());
        }
      }
    }

    // Insert stash rows above the parent commit
    const stashEntriesAtI = stashAtIndex.get(i);
    if (stashEntriesAtI) {
      for (const entry of stashEntriesAtI) {
        const stashSelectHash = `${STASH_HASH_PREFIX}${entry.stash.index}__`;
        fragment.appendChild(buildStashRow({
          laneIndex: i,
          stash: entry.stash,
          selectHash: stashSelectHash,
          stashCol: entry.stashCol,
        }));
        if (selectedHash === stashSelectHash) {
          fragment.appendChild(buildStashDetailPanel());
        }
      }
    }

    // Pass branch-out columns for worktree uncommitted nodes to the commit row (only for non-top entries)
    const hasCurrentAbove = uncommittedInfo?.hasChanges && currentBranchTipIndex === 0;
    const isTopCommit = i === 0 && !hasCurrentAbove;
    const branchOutEntries = isTopCommit ? undefined : wtEntries;
    const branchOutCols = branchOutEntries && branchOutEntries.length > 0 ? branchOutEntries.map((e) => e.uncommittedCol) : undefined;
    // Stash branch-out columns
    const stashBranchOutCols = stashEntriesAtI && stashEntriesAtI.length > 0 ? stashEntriesAtI.map((e) => e.stashCol) : undefined;
    // If there's an uncommitted row directly above this commit, the top half of the node line should be gray
    const hasUncommittedAbove = (i === 0 && uncommittedInfo?.hasChanges && currentBranchTipIndex === 0) || (isTopCommit && wtEntries && wtEntries.length > 0);
    fragment.appendChild(buildCommitRow(commit, i, branchOutCols, hasUncommittedAbove, stashBranchOutCols));

    // Inline detail panel below selected commit
    if (commit.hash === selectedHash && !secondaryHash) {
      fragment.appendChild(buildDetailPanel(commit));
    }

    // Inline compare panel below secondary (Ctrl+clicked) commit
    if (commit.hash === secondaryHash && selectedHash) {
      fragment.appendChild(buildComparePanel());
    }
  }

  // Load more button
  if (commits.length < totalCount) {
    const loadMore = document.createElement("div");
    loadMore.className = "load-more";
    const btn = document.createElement("button");
    btn.textContent = `Load more (${commits.length}/${totalCount})`;
    btn.addEventListener("click", () => {
      vscode.postMessage({ type: "requestLog", count: 200, skip: commits.length, filter: activeFilter });
    });
    loadMore.appendChild(btn);
    fragment.appendChild(loadMore);
  }

  content.innerHTML = "";
  content.appendChild(fragment);

  // Request PR info for visible commits that haven't been fetched yet
  requestPRInfoForVisibleCommits();
}

function buildCommitRow(commit: GitCommit, index: number, wtBranchOutCols?: number[], hasUncommittedAbove?: boolean, stashBranchOutCols?: number[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "commit-row";
  if (commit.hash === selectedHash) row.classList.add("selected");
  if (commit.hash === secondaryHash) row.classList.add("selected-secondary");
  row.dataset.hash = commit.hash;

  // Graph cell
  const graphCell = document.createElement("div");
  graphCell.className = "graph-cell";
  const lanes = graphLanes[index] || [];
  const laneWidth = 14;
  let maxCol = lanes.reduce((max, l) => {
    let m = Math.max(max, l.column);
    if (l.fromColumn !== undefined) m = Math.max(m, l.fromColumn);
    if (l.toColumn !== undefined) m = Math.max(m, l.toColumn);
    return m;
  }, 0);
  // Account for worktree uncommitted branch-out columns in canvas width
  if (wtBranchOutCols) {
    for (const col of wtBranchOutCols) {
      if (col > maxCol) maxCol = col;
    }
  }
  // Account for stash branch-out columns in canvas width
  if (stashBranchOutCols) {
    for (const col of stashBranchOutCols) {
      if (col > maxCol) maxCol = col;
    }
  }
  const neededWidth = (maxCol + 1) * laneWidth + laneWidth;
  const canvasWidth = Math.max(neededWidth, columnWidths.graph);
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = 26;
  drawGraphRow(canvas, lanes);

  // Overlay: overwrite the top half of the node column with gray when uncommitted/stash row is above
  if (hasUncommittedAbove || wtBranchOutCols || stashBranchOutCols) {
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const h = canvas.height;
      const cy = h / 2;
      const nodeRadius = 3.5;
      const uncommittedColor = "#888";
      const nodeLane = lanes.find((l) => l.type === "node" || l.type === "start");
      const nodeCol = nodeLane ? nodeLane.column : 0;
      const nodeX = nodeCol * laneWidth + laneWidth / 2;
      const nodeColor = nodeLane ? COLORS[nodeLane.colorIndex % COLORS.length] : COLORS[0];

      ctx.lineWidth = 2;

      // Gray out the top half of the node's vertical line (0 → cy) to connect with uncommitted row
      if (hasUncommittedAbove) {
        // Clear the top half of the node column line and redraw in gray
        // Use a clip region that excludes the node circle area
        const clipRadius = nodeLane?.isMergeCommit ? 5.5 : nodeRadius + 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(nodeX - 2, 0, 4, cy - clipRadius);
        ctx.clip();
        ctx.clearRect(nodeX - 2, 0, 4, cy - clipRadius);
        ctx.strokeStyle = uncommittedColor;
        ctx.beginPath();
        ctx.moveTo(nodeX, 0);
        ctx.lineTo(nodeX, cy - clipRadius);
        ctx.stroke();
        ctx.restore();
      }

      // Draw branch-out curves for worktree uncommitted nodes (parent node → uncommitted column upward)
      if (wtBranchOutCols) {
        ctx.strokeStyle = uncommittedColor;
        for (const col of wtBranchOutCols) {
          const toX = col * laneWidth + laneWidth / 2;
          ctx.beginPath();
          ctx.moveTo(nodeX, cy);
          ctx.bezierCurveTo(nodeX, cy, toX, cy, toX, 0);
          ctx.stroke();
        }
      }

      // Draw branch-out curves for stash entries
      if (stashBranchOutCols) {
        ctx.strokeStyle = "#d4915c";
        for (const col of stashBranchOutCols) {
          const toX = col * laneWidth + laneWidth / 2;
          ctx.beginPath();
          ctx.moveTo(nodeX, cy);
          ctx.bezierCurveTo(nodeX, cy, toX, cy, toX, 0);
          ctx.stroke();
        }
      }

      // Redraw the node on top of branch-out curves
      if (wtBranchOutCols || stashBranchOutCols) {
        ctx.fillStyle = nodeColor;
        if (nodeLane?.isMergeCommit) {
          const outerRadius = 5;
          const innerRadius = 3;
          const dotRadius = 1.5;
          ctx.beginPath();
          ctx.arc(nodeX, cy, outerRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          ctx.arc(nodeX, cy, innerRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          ctx.fillStyle = nodeColor;
          ctx.beginPath();
          ctx.arc(nodeX, cy, dotRadius, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(nodeX, cy, nodeRadius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  graphCell.appendChild(canvas);

  // Hash cell
  const hashCell = document.createElement("div");
  hashCell.className = "hash-cell";
  hashCell.textContent = commit.abbreviatedHash;

  // Message cell
  const msgCell = document.createElement("div");
  msgCell.className = "message-cell";

  if (commit.refs.length > 0) {
    // Get the graph node color for this commit
    const nodeLane = lanes.find((l) => l.type === "node" || l.type === "start" || l.type === "end");
    const nodeColor = nodeLane ? COLORS[nodeLane.colorIndex % COLORS.length] : null;

    const refsSpan = document.createElement("span");
    refsSpan.className = "refs";
    const resolved = groupRefs(commit.refs, remoteNames);
    for (const entry of resolved) {
      if (isGroupedRef(entry)) {
        // Grouped: local branch + paired remote(s)
        const info = entry.local;
        const label = document.createElement("span");
        label.className = `ref-label ref-${info.type}`;
        const icon = document.createElement("span");
        icon.className = "ref-icon";
        icon.innerHTML = getRefIcon(info.type);
        if (nodeColor && info.type !== "tag") {
          label.style.color = nodeColor;
          label.style.borderColor = nodeColor;
          if (info.type === "head") {
            icon.style.background = nodeColor;
          }
        }
        label.appendChild(icon);
        // Add cloud icon for paired remote
        const remoteIcon = document.createElement("span");
        remoteIcon.className = "ref-icon";
        remoteIcon.innerHTML = getRefIcon("remote");
        label.appendChild(remoteIcon);
        const nameSpan = document.createElement("span");
        nameSpan.className = "ref-name";
        const displayName = layoutOptions.abbreviateRefPrefixes > 0
          ? abbreviateRefName(info.name, layoutOptions.abbreviateRefPrefixes)
          : info.name;
        nameSpan.textContent = displayName;
        label.title = entry.remotes.map((r) => r.name).join(", ");
        label.appendChild(nameSpan);
        const wtInfo = worktreeBranches.get(info.name);
        if (wtInfo) {
          if (wtInfo.isMerged) {
            label.classList.add("ref-merged");
          }
          const wtIcon = document.createElement("span");
          wtIcon.className = "ref-icon";
          wtIcon.innerHTML = `<span class="codicon codicon-list-tree" style="font-size:13px"></span>`;
          label.appendChild(wtIcon);
          if (wtInfo.isDefault) {
            const defaultBadge = document.createElement("span");
            defaultBadge.className = "ref-badge ref-badge-default";
            defaultBadge.textContent = "default";
            defaultBadge.title = "Default worktree";
            label.appendChild(defaultBadge);
          }
          const wtTooltip = `Worktree: ${wtInfo.name} (${wtInfo.path})`
            + (wtInfo.isManaged ? "\n[Managed by baretree]" : "")
            + (wtInfo.isDefault ? "\n[Default worktree]" : "")
            + (wtInfo.isMerged ? "\n[Merged]" : "");
          label.title = label.title ? `${label.title}\n${wtTooltip}` : wtTooltip;
        }
        appendRebaseIndicator(label, info.name);
        label.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showRefContextMenu(e.clientX, e.clientY, info);
        });
        refsSpan.appendChild(label);
      } else {
        // Standalone ref (unpaired remote, tag, bare HEAD)
        const info = entry;
        const label = document.createElement("span");
        label.className = `ref-label ref-${info.type}`;
        const icon = document.createElement("span");
        icon.className = "ref-icon";
        icon.innerHTML = getRefIcon(info.type);
        if (nodeColor && info.type !== "tag") {
          label.style.color = nodeColor;
          label.style.borderColor = nodeColor;
          if (info.type === "head") {
            icon.style.background = nodeColor;
          }
        }
        label.appendChild(icon);
        const nameSpan = document.createElement("span");
        nameSpan.className = "ref-name";
        const displayName = layoutOptions.abbreviateRefPrefixes > 0
          ? abbreviateRefName(info.name, layoutOptions.abbreviateRefPrefixes)
          : info.name;
        nameSpan.textContent = displayName;
        if (displayName !== info.name) {
          label.title = info.name;
        }
        label.appendChild(nameSpan);
        if (info.type === "branch" || info.type === "head") {
          const div = branchDivergence[info.name];
          if (div && (div.ahead > 0 || div.behind > 0)) {
            const divSpan = document.createElement("span");
            divSpan.className = "ref-divergence";
            let text = "";
            if (div.ahead > 0) text += `↑${div.ahead}`;
            if (div.behind > 0) text += `↓${div.behind}`;
            divSpan.textContent = text;
            label.appendChild(divSpan);
            const divTooltip = `Ahead: ${div.ahead}, Behind: ${div.behind}`;
            label.title = label.title ? `${label.title}\n${divTooltip}` : divTooltip;
          }
          const wtInfo = worktreeBranches.get(info.name);
          if (wtInfo) {
            if (wtInfo.isMerged) {
              label.classList.add("ref-merged");
            }
            const wtIcon = document.createElement("span");
            wtIcon.className = "ref-icon";
            wtIcon.innerHTML = `<span class="codicon codicon-list-tree" style="font-size:13px"></span>`;
            label.appendChild(wtIcon);
            if (wtInfo.isDefault) {
              const defaultBadge = document.createElement("span");
              defaultBadge.className = "ref-badge ref-badge-default";
              defaultBadge.textContent = "default";
              defaultBadge.title = "Default worktree";
              label.appendChild(defaultBadge);
            }
            const wtTooltip = `Worktree: ${wtInfo.name} (${wtInfo.path})`
              + (wtInfo.isManaged ? "\n[Managed by baretree]" : "")
              + (wtInfo.isDefault ? "\n[Default worktree]" : "")
              + (wtInfo.isMerged ? "\n[Merged]" : "");
            label.title = label.title ? `${label.title}\n${wtTooltip}` : wtTooltip;
          }
        }
        if (info.type === "branch" || info.type === "head") {
          appendRebaseIndicator(label, info.name);
        }
        label.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showRefContextMenu(e.clientX, e.clientY, info);
        });
        refsSpan.appendChild(label);
      }
    }
    msgCell.appendChild(refsSpan);
  }

  // PR badge — on non-merge branch tips, hide merged/closed (those are shown on the merge commit itself)
  const cachedPR = prInfoCache.get(commit.hash);
  const prInfo = cachedPR !== undefined ? (cachedPR ?? commit.prInfo ?? undefined) : commit.prInfo;
  const prState = prInfo ? (prInfo.state || (prInfo.source === "git-config" ? "pending" : "open")) : undefined;
  const hideBranchTipPR = commit.isBranchTip && !commit.isMergeCommit && (prState === "merged" || prState === "closed");
  if (prInfo && !hideBranchTipPR) {
    const prLabel = document.createElement("span");
    prLabel.className = "pr-label pr-" + prState + (prInfo.url ? " has-url" : "");
    prLabel.innerHTML = `${PR_ICONS[prState ?? "open"]}<span class="pr-number">#${prInfo.number}</span>`;
    const tooltipParts: string[] = [`Pull Request #${prInfo.number}`];
    if (prInfo.title) tooltipParts.push(prInfo.title);
    if (prInfo.sourceBranch) tooltipParts.push(`from ${prInfo.sourceBranch}`);
    if (prInfo.state) tooltipParts.push(`(${prInfo.state})`);
    prLabel.title = tooltipParts.join(" \u2014 ");
    if (prInfo.url) {
      prLabel.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openUrl", url: prInfo.url! });
      });
    }
    msgCell.appendChild(prLabel);
  }

  // Show editable message for reword action, plain text otherwise
  const rebaseEntry = rebaseMode ? rebaseEntries.get(commit.hash) : undefined;
  if (rebaseEntry && rebaseEntry.action === "reword") {
    const displayMsg = rebaseEntry.newMessage !== undefined ? rebaseEntry.newMessage : commit.message;
    const msgText = document.createElement("span");
    msgText.className = "rebase-reword-message";
    msgText.textContent = displayMsg;
    if (rebaseEntry.newMessage !== undefined && rebaseEntry.newMessage !== commit.message) {
      msgText.classList.add("rebase-reword-edited");
    }
    msgText.title = "Double-click to edit commit message";

    const editIcon = document.createElement("span");
    editIcon.className = "rebase-reword-edit-icon";
    editIcon.innerHTML = `<span class="codicon codicon-edit" style="font-size:12px"></span>`;
    editIcon.title = "Edit commit message";
    editIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      startRewordEdit(rebaseEntry, msgCell, commit.message);
    });

    msgCell.appendChild(editIcon);
    msgCell.appendChild(msgText);

    msgText.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRewordEdit(rebaseEntry, msgCell, commit.message);
    });
  } else {
    msgCell.appendChild(document.createTextNode(commit.message));
  }

  // Author cell
  const authorCell = document.createElement("div");
  authorCell.className = "author-cell";
  authorCell.textContent = commit.author;
  authorCell.title = commit.authorEmail;

  // Date cell
  const dateCell = document.createElement("div");
  dateCell.className = "date-cell";
  dateCell.textContent = formatDate(commit.date);

  row.appendChild(graphCell);

  // Rebase mode: insert dedicated action column between graph and message
  if (rebaseMode) {
    const isTarget = rebaseTargetHashes.has(commit.hash);
    if (isTarget) {
      const entry = rebaseEntries.get(commit.hash);
      if (entry) {
        const actionColor = REBASE_ACTION_COLORS[entry.action];
        row.style.boxShadow = `inset 3px 0 0 ${actionColor}`;

        // Dedicated action cell with click-to-cycle
        const actionCell = document.createElement("div");
        actionCell.className = "rebase-action-cell";
        const badge = document.createElement("span");
        badge.className = "rebase-action-badge";
        badge.textContent = entry.action;
        badge.style.color = actionColor;
        badge.style.borderColor = actionColor;
        actionCell.appendChild(badge);
        actionCell.addEventListener("click", (e) => {
          e.stopPropagation();
          const previousAction = entry.action;
          const canSquash = isSquashAllowed(commit.hash);
          let currentIdx = REBASE_ACTIONS.indexOf(entry.action);
          let nextIdx = (currentIdx + 1) % REBASE_ACTIONS.length;
          // Skip squash/fixup if this is the oldest commit
          while (!canSquash && (REBASE_ACTIONS[nextIdx] === "squash" || REBASE_ACTIONS[nextIdx] === "fixup")) {
            nextIdx = (nextIdx + 1) % REBASE_ACTIONS.length;
          }
          entry.action = REBASE_ACTIONS[nextIdx];
          if (previousAction === "reword" && entry.action !== "reword") {
            delete entry.newMessage;
          }
          render();
        });
        actionCell.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showRebaseActionMenu(e.clientX, e.clientY, entry);
        });
        row.appendChild(actionCell);

        if (entry.action === "drop") {
          row.classList.add("rebase-drop");
        }
      } else {
        // Target but no entry (shouldn't happen) - add placeholder
        const placeholder = document.createElement("div");
        placeholder.className = "rebase-action-placeholder";
        row.appendChild(placeholder);
      }
    } else {
      // Non-target: add placeholder to keep columns aligned
      const placeholder = document.createElement("div");
      placeholder.className = "rebase-action-placeholder";
      row.appendChild(placeholder);
      row.classList.add("rebase-non-target");
    }
  }

  row.appendChild(msgCell);
  row.appendChild(authorCell);
  row.appendChild(hashCell);
  row.appendChild(dateCell);

  row.addEventListener("click", (e) => handleCommitClick(commit.hash, e));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, commit.hash);
  });

  return row;
}

interface UncommittedRowOptions {
  laneIndex: number;
  summary: { staged: number; unstaged: number; untracked: number };
  selectHash: string;
  label: string;
  isTopRow: boolean;
  /** When true, draw the node on a separate branch-out column (for other worktrees) */
  asBranch?: boolean;
  /** Pre-calculated column for the uncommitted node (used with asBranch) */
  uncommittedCol?: number;
  /** Branch name for worktree uncommitted (undefined = current worktree) */
  branch?: string;
}

function buildUncommittedRow(opts: UncommittedRowOptions): HTMLElement {
  const row = document.createElement("div");
  row.className = "commit-row uncommitted-row";
  if (selectedHash === opts.selectHash) row.classList.add("selected");

  // Graph cell
  const graphCell = document.createElement("div");
  graphCell.className = "graph-cell";
  const canvas = document.createElement("canvas");
  const canvasWidth = Math.max(28, columnWidths.graph);
  canvas.width = canvasWidth;
  canvas.height = 26;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    const laneWidth = 14;
    const refLanes = graphLanes[opts.laneIndex] || [];
    const h = canvas.height;
    const cy = h / 2;
    const uncommittedColor = "#888";
    ctx.lineWidth = 2;

    // Find the node column for the parent commit
    let parentCol = 0;
    const nodeLane = refLanes.find((l) => l.type === "node" || l.type === "start");
    if (nodeLane) {
      parentCol = nodeLane.column;
    }

    // For branch mode, use the pre-calculated column; otherwise use parent column
    const uncommittedCol = (opts.asBranch && opts.uncommittedCol !== undefined) ? opts.uncommittedCol : parentCol;

    // Draw all existing lanes as pass-through
    const drawnColumns = new Set<number>();
    for (const lane of refLanes) {
      const col = lane.column;
      if (drawnColumns.has(col)) continue;

      if (lane.type === "pass" || lane.type === "node" || lane.type === "start") {
        drawnColumns.add(col);
        const lx = col * laneWidth + laneWidth / 2;
        if (col === parentCol && !opts.asBranch) {
          // Current worktree: draw parent column in gray
          ctx.strokeStyle = uncommittedColor;
          ctx.beginPath();
          ctx.moveTo(lx, opts.isTopRow ? cy : 0);
          ctx.lineTo(lx, h);
          ctx.stroke();
        } else {
          // Pass-through in original color
          const laneColor = COLORS[lane.colorIndex % COLORS.length];
          ctx.strokeStyle = laneColor;
          if (lane.dashed) ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(lx, 0);
          ctx.lineTo(lx, h);
          ctx.stroke();
          if (lane.dashed) ctx.setLineDash([]);
        }
      } else if (lane.type === "merge-in" || lane.type === "branch-out") {
        const srcCol = lane.type === "merge-in" ? lane.fromColumn! : lane.toColumn!;
        if (!drawnColumns.has(srcCol)) {
          drawnColumns.add(srcCol);
          const sx = srcCol * laneWidth + laneWidth / 2;
          const laneColor = COLORS[lane.colorIndex % COLORS.length];
          ctx.strokeStyle = laneColor;
          if (lane.dashed) ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, h);
          ctx.stroke();
          if (lane.dashed) ctx.setLineDash([]);
        }
      }
    }

    // For branch mode, draw a vertical line from top to the uncommitted node
    // (the branch-out curve is drawn in the parent commit's row below)
    if (opts.asBranch) {
      const ux = uncommittedCol * laneWidth + laneWidth / 2;
      ctx.strokeStyle = uncommittedColor;
      ctx.beginPath();
      ctx.moveTo(ux, h);
      ctx.lineTo(ux, cy);
      ctx.stroke();
    }

    // Draw the uncommitted node
    const nx = uncommittedCol * laneWidth + laneWidth / 2;
    ctx.fillStyle = uncommittedColor;
    const outerRadius = 5;
    const innerRadius = 3;
    const dotRadius = 1.5;
    ctx.beginPath();
    ctx.arc(nx, cy, outerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(nx, cy, innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(nx, cy, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  graphCell.appendChild(canvas);

  // Message cell
  const msgCell = document.createElement("div");
  msgCell.className = "message-cell";

  const summary = opts.summary;
  if (summary.staged > 0) {
    const badge = document.createElement("span");
    badge.className = "uncommitted-badge staged";
    badge.textContent = `${summary.staged} staged`;
    msgCell.appendChild(badge);
  }
  if (summary.unstaged > 0) {
    const badge = document.createElement("span");
    badge.className = "uncommitted-badge unstaged";
    badge.textContent = `${summary.unstaged} modified`;
    msgCell.appendChild(badge);
  }
  if (summary.untracked > 0) {
    const badge = document.createElement("span");
    badge.className = "uncommitted-badge untracked";
    badge.textContent = `${summary.untracked} untracked`;
    msgCell.appendChild(badge);
  }

  const msgText = document.createElement("span");
  msgText.className = "uncommitted-msg-text";
  msgText.textContent = opts.label;
  msgCell.appendChild(msgText);

  // Author cell (empty)
  const authorCell = document.createElement("div");
  authorCell.className = "author-cell";

  // Hash cell
  const hashCell = document.createElement("div");
  hashCell.className = "hash-cell";
  hashCell.textContent = "*";
  hashCell.style.opacity = "0.4";

  // Date cell
  const dateCell = document.createElement("div");
  dateCell.className = "date-cell";

  row.appendChild(graphCell);
  if (rebaseMode) {
    const placeholder = document.createElement("div");
    placeholder.className = "rebase-action-placeholder";
    row.appendChild(placeholder);
    row.classList.add("rebase-non-target");
  }
  row.appendChild(msgCell);
  row.appendChild(authorCell);
  row.appendChild(hashCell);
  row.appendChild(dateCell);

  row.addEventListener("click", () => handleUncommittedClick(opts.selectHash, opts.branch));

  return row;
}

function handleUncommittedClick(selectHash: string, branch?: string): void {
  if (selectedHash === selectHash) {
    // Toggle off
    selectedHash = null;
    uncommittedDetail = null;
    uncommittedDetailLoading = false;
    uncommittedDetailBranch = undefined;
  } else {
    selectedHash = selectHash;
    secondaryHash = null;
    expandedDetail = null;
    uncommittedDetail = null;
    uncommittedDetailLoading = true;
    uncommittedDetailBranch = branch;
    vscode.postMessage({ type: "requestUncommittedDetail", branch });
  }
  render();
}

function handleUncommittedDetail(detail: UncommittedDetail): void {
  uncommittedDetail = detail;
  uncommittedDetailLoading = false;
  render();
}

function buildUncommittedDetailPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "detail-panel";

  if (uncommittedDetailLoading || !uncommittedDetail) {
    const loading = document.createElement("div");
    loading.className = "detail-loading";
    loading.textContent = "Loading...";
    panel.appendChild(loading);
    return panel;
  }

  const detail = uncommittedDetail;

  // Left side: summary info
  const left = document.createElement("div");
  left.className = "detail-left";

  const meta = document.createElement("div");
  meta.className = "detail-meta";

  const addMeta = (label: string, value: string) => {
    const labelEl = document.createElement("span");
    labelEl.className = "detail-meta-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "detail-meta-value";
    valueEl.textContent = value;
    meta.appendChild(labelEl);
    meta.appendChild(valueEl);
  };

  addMeta("Status", "Uncommitted Changes");
  if (detail.staged > 0) addMeta("Staged", `${detail.staged} file${detail.staged !== 1 ? "s" : ""}`);
  if (detail.unstaged > 0) addMeta("Unstaged", `${detail.unstaged} file${detail.unstaged !== 1 ? "s" : ""}`);
  if (detail.untracked > 0) addMeta("Untracked", `${detail.untracked} file${detail.untracked !== 1 ? "s" : ""}`);

  left.appendChild(meta);

  // Right side: changed files grouped by section
  const right = document.createElement("div");
  right.className = "detail-right";

  const totalFiles = detail.staged + detail.unstaged + detail.untracked;
  const filesHeader = document.createElement("div");
  filesHeader.className = "detail-files-header";
  filesHeader.textContent = `${totalFiles} file${totalFiles !== 1 ? "s" : ""} changed`;
  right.appendChild(filesHeader);

  const buildDiffFileRow = (file: DiffFile, section: "staged" | "unstaged") => {
    const fileRow = document.createElement("div");
    fileRow.className = "detail-file";

    const iconEl = document.createElement("span");
    iconEl.className = `detail-file-icon ${file.status}`;
    iconEl.innerHTML = FILE_STATUS_ICONS[file.status] ?? FILE_STATUS_ICONS.modified;
    iconEl.title = file.status;

    const nameEl = document.createElement("span");
    nameEl.className = "detail-file-name";
    if (file.status === "renamed" && file.oldPath) {
      nameEl.textContent = `${file.oldPath} → ${file.path}`;
    } else {
      nameEl.textContent = file.path;
    }
    nameEl.title = file.path;

    const statEl = document.createElement("span");
    statEl.className = "detail-file-stat";
    statEl.innerHTML = `( <span class="add">+${file.additions}</span> | <span class="del">-${file.deletions}</span> )`;

    fileRow.appendChild(iconEl);
    fileRow.appendChild(nameEl);
    fileRow.appendChild(statEl);

    fileRow.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: "openUncommittedDiff",
        filePath: file.path,
        oldPath: file.oldPath,
        status: file.status,
        section,
        branch: uncommittedDetailBranch,
      });
    });

    return fileRow;
  };

  // Staged files section
  if (detail.stagedFiles.length > 0) {
    const header = document.createElement("div");
    header.className = "uncommitted-section-header";
    header.innerHTML = `${codicon("diff-added", 12)} Staged Changes (${detail.stagedFiles.length})`;
    right.appendChild(header);
    for (const file of detail.stagedFiles) {
      right.appendChild(buildDiffFileRow(file, "staged"));
    }
  }

  // Unstaged (modified) files section
  if (detail.unstagedFiles.length > 0) {
    const header = document.createElement("div");
    header.className = "uncommitted-section-header";
    header.innerHTML = `${codicon("diff-modified", 12)} Modified — Unstaged (${detail.unstagedFiles.length})`;
    right.appendChild(header);
    for (const file of detail.unstagedFiles) {
      right.appendChild(buildDiffFileRow(file, "unstaged"));
    }
  }

  // Untracked files section
  if (detail.untrackedFiles.length > 0) {
    const header = document.createElement("div");
    header.className = "uncommitted-section-header";
    header.innerHTML = `${codicon("question", 12)} Untracked Files (${detail.untrackedFiles.length})`;
    right.appendChild(header);
    for (const filePath of detail.untrackedFiles) {
      const fileRow = document.createElement("div");
      fileRow.className = "detail-file";

      const iconEl = document.createElement("span");
      iconEl.className = "detail-file-icon added";
      iconEl.innerHTML = FILE_STATUS_ICONS.added;
      iconEl.title = "untracked";

      const nameEl = document.createElement("span");
      nameEl.className = "detail-file-name";
      nameEl.textContent = filePath;
      nameEl.title = filePath;

      fileRow.appendChild(iconEl);
      fileRow.appendChild(nameEl);

      fileRow.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: "openUncommittedDiff",
          filePath,
          status: "added",
          section: "untracked",
          branch: uncommittedDetailBranch,
        });
      });

      right.appendChild(fileRow);
    }
  }

  panel.appendChild(left);
  panel.appendChild(right);

  return panel;
}

// --- Stash rendering ---

interface StashRowOptions {
  laneIndex: number;
  stash: StashEntry;
  selectHash: string;
  stashCol: number;
}

function buildStashRow(opts: StashRowOptions): HTMLElement {
  const row = document.createElement("div");
  row.className = "commit-row stash-row";
  if (selectedHash === opts.selectHash) row.classList.add("selected");

  // Graph cell
  const graphCell = document.createElement("div");
  graphCell.className = "graph-cell";
  const canvas = document.createElement("canvas");
  const canvasWidth = Math.max(28, columnWidths.graph);
  canvas.width = canvasWidth;
  canvas.height = 26;

  const ctx = canvas.getContext("2d");
  if (ctx) {
    const laneWidth = 14;
    const refLanes = graphLanes[opts.laneIndex] || [];
    const h = canvas.height;
    const cy = h / 2;
    const stashColor = "#d4915c";
    ctx.lineWidth = 2;

    // Draw all existing lanes as pass-through
    const drawnColumns = new Set<number>();
    for (const lane of refLanes) {
      const col = lane.column;
      if (drawnColumns.has(col)) continue;

      if (lane.type === "pass" || lane.type === "node" || lane.type === "start") {
        drawnColumns.add(col);
        const lx = col * laneWidth + laneWidth / 2;
        const laneColor = COLORS[lane.colorIndex % COLORS.length];
        ctx.strokeStyle = laneColor;
        if (lane.dashed) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(lx, 0);
        ctx.lineTo(lx, h);
        ctx.stroke();
        if (lane.dashed) ctx.setLineDash([]);
      } else if (lane.type === "merge-in" || lane.type === "branch-out") {
        const srcCol = lane.type === "merge-in" ? lane.fromColumn! : lane.toColumn!;
        if (!drawnColumns.has(srcCol)) {
          drawnColumns.add(srcCol);
          const sx = srcCol * laneWidth + laneWidth / 2;
          const laneColor = COLORS[lane.colorIndex % COLORS.length];
          ctx.strokeStyle = laneColor;
          if (lane.dashed) ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, h);
          ctx.stroke();
          if (lane.dashed) ctx.setLineDash([]);
        }
      }
    }

    // Draw vertical line from bottom to stash node (branch-out style)
    const stashCol = opts.stashCol;
    const ux = stashCol * laneWidth + laneWidth / 2;
    ctx.strokeStyle = stashColor;
    ctx.beginPath();
    ctx.moveTo(ux, h);
    ctx.lineTo(ux, cy);
    ctx.stroke();

    // Draw stash node (ring with dot)
    ctx.fillStyle = stashColor;
    const outerRadius = 5;
    const innerRadius = 3;
    const dotRadius = 1.5;
    ctx.beginPath();
    ctx.arc(ux, cy, outerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(ux, cy, innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(ux, cy, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  graphCell.appendChild(canvas);

  // Message cell with inbox icon and stash info
  const msgCell = document.createElement("div");
  msgCell.className = "message-cell";

  const stashBadge = document.createElement("span");
  stashBadge.className = "ref-label ref-stash";
  const icon = document.createElement("span");
  icon.className = "ref-icon";
  icon.innerHTML = `<span class="codicon codicon-inbox" style="font-size:12px"></span>`;
  stashBadge.appendChild(icon);
  const nameSpan = document.createElement("span");
  nameSpan.className = "ref-name";
  nameSpan.textContent = `stash@{${opts.stash.index}}`;
  stashBadge.appendChild(nameSpan);
  msgCell.appendChild(stashBadge);

  msgCell.appendChild(document.createTextNode(opts.stash.message));

  // Author cell (empty)
  const authorCell = document.createElement("div");
  authorCell.className = "author-cell";

  // Hash cell
  const hashCell = document.createElement("div");
  hashCell.className = "hash-cell";
  hashCell.textContent = opts.stash.hash.substring(0, 7);
  hashCell.style.opacity = "0.5";

  // Date cell
  const dateCell = document.createElement("div");
  dateCell.className = "date-cell";
  dateCell.textContent = formatDate(opts.stash.date);

  row.appendChild(graphCell);
  if (rebaseMode) {
    const placeholder = document.createElement("div");
    placeholder.className = "rebase-action-placeholder";
    row.appendChild(placeholder);
    row.classList.add("rebase-non-target");
  }
  row.appendChild(msgCell);
  row.appendChild(authorCell);
  row.appendChild(hashCell);
  row.appendChild(dateCell);

  row.addEventListener("click", () => handleStashClick(opts.selectHash, opts.stash.index));

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showStashContextMenu(e.clientX, e.clientY, opts.stash.index);
  });

  return row;
}

function handleStashClick(selectHash: string, stashIndex: number): void {
  if (selectedHash === selectHash) {
    selectedHash = null;
    stashDetail = null;
    stashDetailLoading = false;
  } else {
    selectedHash = selectHash;
    secondaryHash = null;
    expandedDetail = null;
    uncommittedDetail = null;
    stashDetail = null;
    stashDetailLoading = true;
    vscode.postMessage({ type: "requestStashDetail", index: stashIndex });
  }
  render();
}

function handleStashDetail(detail: { index: number; files: DiffFile[] }): void {
  stashDetail = detail;
  stashDetailLoading = false;
  render();
}

function buildStashDetailPanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "detail-panel";

  if (stashDetailLoading || !stashDetail) {
    const loading = document.createElement("div");
    loading.className = "detail-loading";
    loading.textContent = "Loading...";
    panel.appendChild(loading);
    return panel;
  }

  const detail = stashDetail;

  // Left side: summary
  const left = document.createElement("div");
  left.className = "detail-left";
  const meta = document.createElement("div");
  meta.className = "detail-meta";

  const addMeta = (label: string, value: string) => {
    const labelEl = document.createElement("span");
    labelEl.className = "detail-meta-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "detail-meta-value";
    valueEl.textContent = value;
    meta.appendChild(labelEl);
    meta.appendChild(valueEl);
  };

  addMeta("Status", `stash@{${detail.index}}`);
  addMeta("Files", `${detail.files.length} file${detail.files.length !== 1 ? "s" : ""}`);

  left.appendChild(meta);

  // Right side: file list
  const right = document.createElement("div");
  right.className = "detail-right";

  const filesHeader = document.createElement("div");
  filesHeader.className = "detail-files-header";
  filesHeader.textContent = `${detail.files.length} file${detail.files.length !== 1 ? "s" : ""} changed`;
  right.appendChild(filesHeader);

  for (const file of detail.files) {
    const fileRow = document.createElement("div");
    fileRow.className = "detail-file";

    const iconEl = document.createElement("span");
    iconEl.className = `detail-file-icon ${file.status}`;
    iconEl.innerHTML = FILE_STATUS_ICONS[file.status] ?? FILE_STATUS_ICONS.modified;
    iconEl.title = file.status;

    const nameEl = document.createElement("span");
    nameEl.className = "detail-file-name";
    if (file.status === "renamed" && file.oldPath) {
      nameEl.textContent = `${file.oldPath} → ${file.path}`;
    } else {
      nameEl.textContent = file.path;
    }
    nameEl.title = file.path;

    const statEl = document.createElement("span");
    statEl.className = "detail-file-stat";
    statEl.innerHTML = `( <span class="add">+${file.additions}</span> | <span class="del">-${file.deletions}</span> )`;

    fileRow.appendChild(iconEl);
    fileRow.appendChild(nameEl);
    fileRow.appendChild(statEl);

    right.appendChild(fileRow);
  }

  panel.appendChild(left);
  panel.appendChild(right);

  return panel;
}

function buildDetailPanel(commit: GitCommit): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "detail-panel";

  // Show loading while fetching
  if (detailLoading || !expandedDetail || expandedDetail.hash !== commit.hash) {
    const loading = document.createElement("div");
    loading.className = "detail-loading";
    loading.textContent = "Loading...";
    panel.appendChild(loading);
    return panel;
  }

  const detail = expandedDetail;

  // --- Containment info (tags & branches) at the top ---
  if (containmentInfo && containmentInfo.hash === commit.hash) {
    const containmentRow = document.createElement("div");
    containmentRow.className = "detail-containment";

    if (containmentInfo.tags.length > 0) {
      const label = document.createElement("span");
      label.className = "containment-label";
      label.textContent = "Tags:";
      containmentRow.appendChild(label);

      const maxShow = 3;
      for (const tag of containmentInfo.tags.slice(0, maxShow)) {
        const chip = document.createElement("span");
        chip.className = "containment-chip tag";
        chip.textContent = tag;
        containmentRow.appendChild(chip);
      }
      if (containmentInfo.tags.length > maxShow) {
        const more = document.createElement("span");
        more.className = "containment-label";
        more.textContent = `+${containmentInfo.tags.length - maxShow}`;
        containmentRow.appendChild(more);
      }
    }

    if (containmentInfo.branches.length > 0) {
      const label = document.createElement("span");
      label.className = "containment-label";
      label.textContent = "Branches:";
      containmentRow.appendChild(label);

      const maxShow = 5;
      for (const branch of containmentInfo.branches.slice(0, maxShow)) {
        const chip = document.createElement("span");
        chip.className = "containment-chip";
        chip.textContent = branch.replace(/^remotes\//, "");
        if (rebaseMode) {
          chip.style.cursor = "default";
          chip.style.opacity = "0.5";
          chip.title = "Filtering is disabled during interactive rebase";
        } else {
          chip.title = `Filter to history within ${branch}`;
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            activeFilter = {
              ...activeFilter,
              containingCommit: selectedHash!,
              withinRef: branch,
            };
            commits = [];
            vscode.postMessage({ type: "setFilter", filter: activeFilter });
            updateFilterUI();
          });
        }
        containmentRow.appendChild(chip);
      }
      if (containmentInfo.branches.length > maxShow) {
        const more = document.createElement("span");
        more.className = "containment-label";
        more.textContent = `+${containmentInfo.branches.length - maxShow}`;
        containmentRow.appendChild(more);
      }
    }

    if (containmentInfo.tags.length > 0 || containmentInfo.branches.length > 0) {
      panel.appendChild(containmentRow);
    }
  }

  // --- Left side: commit info ---
  const left = document.createElement("div");
  left.className = "detail-left";

  // Metadata grid
  const meta = document.createElement("div");
  meta.className = "detail-meta";

  const addMeta = (label: string, value: string, isHtml = false) => {
    const labelEl = document.createElement("span");
    labelEl.className = "detail-meta-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "detail-meta-value";
    if (isHtml) {
      valueEl.innerHTML = value;
    } else {
      valueEl.textContent = value;
    }
    meta.appendChild(labelEl);
    meta.appendChild(valueEl);
  };

  addMeta("Commit", detail.hash);
  if (detail.parentHashes.length > 0) {
    const parentLinks = detail.parentHashes.map((h) =>
      `<a class="parent-link" data-hash="${escapeHtml(h)}">${h.substring(0, 7)}</a>`
    ).join(" ");
    addMeta("Parents", parentLinks, true);
  }
  // PR info in detail panel (only show on the merge commit)
  const cachedDetailPR = prInfoCache.get(detail.hash);
  const detailPrInfo = cachedDetailPR !== undefined ? (cachedDetailPR ?? detail.prInfo ?? undefined) : detail.prInfo;
  if (detailPrInfo) {
    let prDisplay = `#${detailPrInfo.number}`;
    if (detailPrInfo.title) prDisplay += ` ${escapeHtml(detailPrInfo.title)}`;
    if (detailPrInfo.sourceBranch) prDisplay += ` (from ${escapeHtml(detailPrInfo.sourceBranch)})`;
    if (detailPrInfo.url) {
      prDisplay = `<a class="pr-link" data-url="${escapeHtml(detailPrInfo.url)}">${prDisplay}</a>`;
    }
    if (detailPrInfo.state) {
      prDisplay += ` <span style="opacity:0.6">[${detailPrInfo.state}]</span>`;
    }
    addMeta("Pull Request", prDisplay, true);
  }

  addMeta("Author", `${escapeHtml(detail.author)} &lt;<a class="email-link" href="mailto:${escapeHtml(detail.authorEmail)}">${escapeHtml(detail.authorEmail)}</a>&gt;`, true);
  addMeta("Committer", `${escapeHtml(detail.committer)} &lt;<a class="email-link" href="mailto:${escapeHtml(detail.committerEmail)}">${escapeHtml(detail.committerEmail)}</a>&gt;`, true);
  addMeta("Date", formatDate(detail.date));

  left.appendChild(meta);

  // Commit message
  if (detail.message) {
    const msgEl = document.createElement("div");
    msgEl.className = "detail-message";
    msgEl.textContent = detail.message;
    left.appendChild(msgEl);
  }

  // Merged commits list (for merge commits)
  if (detail.mergedCommits && detail.mergedCommits.length > 0) {
    const mergedSection = document.createElement("div");
    mergedSection.className = "detail-merged-commits";

    const mergedHeader = document.createElement("div");
    mergedHeader.className = "detail-merged-header";
    mergedHeader.textContent = `${detail.mergedCommits.length} commit${detail.mergedCommits.length !== 1 ? "s" : ""} merged`;
    mergedSection.appendChild(mergedHeader);

    for (const mc of detail.mergedCommits) {
      const row = document.createElement("div");
      row.className = "detail-merged-row";

      const hashEl = document.createElement("span");
      hashEl.className = "detail-merged-hash";
      hashEl.textContent = mc.abbreviatedHash;

      const msgEl = document.createElement("span");
      msgEl.className = "detail-merged-msg";
      msgEl.textContent = mc.message;
      msgEl.title = mc.message;

      const authorEl = document.createElement("span");
      authorEl.className = "detail-merged-author";
      authorEl.textContent = mc.author;

      row.appendChild(hashEl);
      row.appendChild(msgEl);
      row.appendChild(authorEl);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedHash = mc.hash;
        secondaryHash = null;
        expandedDetail = null;
        detailLoading = true;
        vscode.postMessage({ type: "requestCommitDetail", hash: mc.hash });
        vscode.postMessage({ type: "requestCommitContainment", hash: mc.hash });
        render();
        updateFilterUI();
      });

      mergedSection.appendChild(row);
    }

    left.appendChild(mergedSection);
  }

  // --- Right side: changed files ---
  const right = document.createElement("div");
  right.className = "detail-right";

  const filesHeader = document.createElement("div");
  filesHeader.className = "detail-files-header";
  filesHeader.textContent = `${detail.files.length} file${detail.files.length !== 1 ? "s" : ""} changed`;
  right.appendChild(filesHeader);

  for (const file of detail.files) {
    const fileRow = document.createElement("div");
    fileRow.className = "detail-file";

    const iconEl = document.createElement("span");
    iconEl.className = `detail-file-icon ${file.status}`;
    iconEl.innerHTML = FILE_STATUS_ICONS[file.status] ?? FILE_STATUS_ICONS.modified;
    iconEl.title = file.status;

    const nameEl = document.createElement("span");
    nameEl.className = "detail-file-name";
    if (file.status === "renamed" && file.oldPath) {
      nameEl.textContent = `${file.oldPath} → ${file.path}`;
    } else {
      nameEl.textContent = file.path;
    }
    nameEl.title = file.path;

    const statEl = document.createElement("span");
    statEl.className = "detail-file-stat";
    statEl.innerHTML = `( <span class="add">+${file.additions}</span> | <span class="del">-${file.deletions}</span> )`;

    fileRow.appendChild(iconEl);
    fileRow.appendChild(nameEl);
    fileRow.appendChild(statEl);

    fileRow.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: "openDiff",
        hash: detail.hash,
        filePath: file.path,
        oldPath: file.oldPath,
        status: file.status,
      });
    });

    right.appendChild(fileRow);
  }

  panel.appendChild(left);
  panel.appendChild(right);

  // Parent link click handler
  panel.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("parent-link")) {
      e.stopPropagation();
      const parentHash = target.dataset.hash;
      if (parentHash) {
        selectedHash = parentHash;
        secondaryHash = null;
        expandedDetail = null;
        detailLoading = true;
        vscode.postMessage({ type: "requestCommitDetail", hash: parentHash });
        render();
      }
    }
    if (target.classList.contains("pr-link")) {
      e.stopPropagation();
      const url = target.dataset.url;
      if (url) {
        vscode.postMessage({ type: "openUrl", url });
      }
    }
  });

  return panel;
}

function handleCompareDetail(msg: CompareDetailData): void {
  compareDetailData = msg;
  compareLoading = false;
  render();
}

function buildComparePanel(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "compare-panel";

  // Show loading while fetching
  if (compareLoading || !compareDetailData) {
    const loading = document.createElement("div");
    loading.className = "detail-loading";
    loading.textContent = "Loading...";
    panel.appendChild(loading);
    return panel;
  }

  const detail = compareDetailData;

  // --- Left side: two commit infos ---
  const left = document.createElement("div");
  left.className = "compare-left";

  const buildCommitSection = (label: string, commit: CompareDetailData["commit1"]) => {
    const section = document.createElement("div");
    section.className = "compare-commit-section";

    const labelEl = document.createElement("div");
    labelEl.className = "compare-commit-label";
    labelEl.textContent = label;
    section.appendChild(labelEl);

    const meta = document.createElement("div");
    meta.className = "compare-meta";

    const addMeta = (key: string, value: string) => {
      const keyEl = document.createElement("span");
      keyEl.className = "compare-meta-label";
      keyEl.textContent = key;
      const valEl = document.createElement("span");
      valEl.className = "compare-meta-value";
      valEl.textContent = value;
      meta.appendChild(keyEl);
      meta.appendChild(valEl);
    };

    addMeta("Commit", commit.abbreviatedHash);
    addMeta("Author", commit.author);
    addMeta("Date", formatDate(commit.date));
    section.appendChild(meta);

    if (commit.message) {
      const msgEl = document.createElement("div");
      msgEl.className = "compare-message";
      msgEl.textContent = commit.message;
      section.appendChild(msgEl);
    }

    return section;
  };

  left.appendChild(buildCommitSection("From", detail.commit1));
  left.appendChild(buildCommitSection("To", detail.commit2));

  // --- Right side: changed files ---
  const right = document.createElement("div");
  right.className = "compare-right";

  const filesHeader = document.createElement("div");
  filesHeader.className = "detail-files-header";
  filesHeader.textContent = `${detail.files.length} file${detail.files.length !== 1 ? "s" : ""} changed`;
  right.appendChild(filesHeader);

  for (const file of detail.files) {
    const fileRow = document.createElement("div");
    fileRow.className = "detail-file";

    const iconEl = document.createElement("span");
    iconEl.className = `detail-file-icon ${file.status}`;
    iconEl.innerHTML = FILE_STATUS_ICONS[file.status] ?? FILE_STATUS_ICONS.modified;
    iconEl.title = file.status;

    const nameEl = document.createElement("span");
    nameEl.className = "detail-file-name";
    if (file.status === "renamed" && file.oldPath) {
      nameEl.textContent = `${file.oldPath} → ${file.path}`;
    } else {
      nameEl.textContent = file.path;
    }
    nameEl.title = file.path;

    const statEl = document.createElement("span");
    statEl.className = "detail-file-stat";
    statEl.innerHTML = `( <span class="add">+${file.additions}</span> | <span class="del">-${file.deletions}</span> )`;

    fileRow.appendChild(iconEl);
    fileRow.appendChild(nameEl);
    fileRow.appendChild(statEl);

    fileRow.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: "openDiffBetween",
        hash1: detail.hash1,
        hash2: detail.hash2,
        filePath: file.path,
        oldPath: file.oldPath,
      });
    });

    right.appendChild(fileRow);
  }

  panel.appendChild(left);
  panel.appendChild(right);

  return panel;
}

function handleCommitClick(hash: string, e: MouseEvent): void {
  if (e.ctrlKey || e.metaKey) {
    const isSelectedSpecial = selectedHash.startsWith(STASH_HASH_PREFIX) || selectedHash === UNCOMMITTED_HASH;
    if (selectedHash && selectedHash !== hash && !isSelectedSpecial) {
      secondaryHash = hash;
      compareDetailData = null;
      compareLoading = true;
      expandedDetail = null;
      detailLoading = false;
      vscode.postMessage({ type: "requestCompareDetail", hash1: selectedHash, hash2: hash });
      render();
    }
    return;
  }

  if (selectedHash === hash) {
    // Toggle off — collapse detail
    selectedHash = null;
    expandedDetail = null;
    detailLoading = false;
    containmentInfo = null;
  } else {
    // Expand new commit
    selectedHash = hash;
    secondaryHash = null;
    expandedDetail = null;
    detailLoading = true;
    compareDetailData = null;
    compareLoading = false;
    vscode.postMessage({ type: "requestCommitDetail", hash });
    vscode.postMessage({ type: "requestCommitContainment", hash });
  }
  render();
  updateFilterUI();
}

// --- Context menu ---

interface ContextMenuItem {
  label: string;
  icon: string;
  action: () => void;
  separator?: boolean;
  baretreeRecommended?: boolean;
}

let activeContextMenu: HTMLElement | null = null;

function dismissContextMenu(): void {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

document.addEventListener("click", dismissContextMenu);
document.addEventListener("contextmenu", (e) => {
  // Dismiss if clicking outside a commit row
  if (activeContextMenu && !(e.target as HTMLElement).closest(".context-menu")) {
    dismissContextMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dismissContextMenu();
});

function startRewordEdit(entry: RebaseTodoEntry, msgCell: HTMLElement, originalMessage: string): void {
  // Remove existing reword UI elements
  const existingMsg = msgCell.querySelector(".rebase-reword-message");
  const existingIcon = msgCell.querySelector(".rebase-reword-edit-icon");
  if (existingMsg) existingMsg.remove();
  if (existingIcon) existingIcon.remove();

  const input = document.createElement("input");
  input.type = "text";
  input.className = "rebase-reword-input";
  input.value = entry.newMessage !== undefined ? entry.newMessage : originalMessage;
  input.placeholder = originalMessage;
  msgCell.appendChild(input);

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    const newVal = input.value.trim();
    if (newVal && newVal !== originalMessage) {
      entry.newMessage = newVal;
    } else {
      delete entry.newMessage;
    }
    render();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      committed = true;
      render();
    }
    e.stopPropagation();
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}

function showRebaseActionMenu(x: number, y: number, entry: RebaseTodoEntry): void {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const canSquash = isSquashAllowed(entry.hash);
  const items: ContextMenuItem[] = [];
  for (const action of REBASE_ACTIONS) {
    // Skip squash/fixup for the oldest commit (no prior commit to squash into)
    if (!canSquash && (action === "squash" || action === "fixup")) continue;
    const isCurrent = action === entry.action;
    if (action === "drop") {
      items.push({
        label: "",
        icon: "",
        action: () => {},
        separator: true,
      });
    }
    items.push({
      label: `${action}${isCurrent ? " (current)" : ""}`,
      icon: `<span style="color:${REBASE_ACTION_COLORS[action]};font-weight:bold;">&#x25CF;</span>`,
      action: () => {
        const previousAction = entry.action;
        entry.action = action;
        if (previousAction === "reword" && action !== "reword") {
          delete entry.newMessage;
        }
        render();
      },
    });
  }

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement("div");
    row.className = "context-menu-item";

    const iconEl = document.createElement("span");
    iconEl.className = "context-menu-icon";
    iconEl.innerHTML = item.icon;

    const labelEl = document.createElement("span");
    labelEl.className = "context-menu-label";
    labelEl.textContent = item.label;

    row.appendChild(iconEl);
    row.appendChild(labelEl);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      item.action();
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Position the menu
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function showContextMenu(x: number, y: number, hash: string): void {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  let items: ContextMenuItem[];

  if (rebaseMode) {
    // Rebase mode: both target and non-target show only copy hash
    // (action selection is in the dedicated action column)
    items = [
      {
        label: "Copy Commit Hash",
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyHash", hash }),
      },
    ];
  } else {
    // Normal mode
    items = [];
    // Compare with selected commit (only if another commit is already selected)
    if (selectedHash && selectedHash !== hash && !selectedHash.startsWith(STASH_HASH_PREFIX) && selectedHash !== UNCOMMITTED_HASH) {
      items.push({
        label: "Compare with Selected Commit",
        icon: codicon("git-compare", 14),
        action: () => {
          secondaryHash = hash;
          compareDetailData = null;
          compareLoading = true;
          expandedDetail = null;
          detailLoading = false;
          vscode.postMessage({ type: "requestCompareDetail", hash1: selectedHash!, hash2: hash });
          render();
        },
        separator: true,
      });
    }
    items.push(
    {
      label: "Copy Commit Hash",
      icon: codicon("copy", 14),
      action: () => vscode.postMessage({ type: "copyHash", hash }),
    },
    {
      label: "Checkout",
      icon: codicon("check", 14),
      action: () => vscode.postMessage({ type: "checkoutCommit", hash }),
      separator: true,
      baretreeRecommended: baretreeAvailable,
    },
    {
      label: "Create Branch...",
      icon: codicon("git-branch", 14),
      action: () => vscode.postMessage({ type: "createBranchFromCommit", hash }),
      baretreeRecommended: baretreeAvailable,
    },
    ...(baretreeAvailable ? [{
      label: "Create Worktree with baretree...",
      icon: codicon("list-tree", 14),
      action: () => vscode.postMessage({ type: "createWorktreeWithBaretreeFromCommit", hash }),
    }] : []),
    {
      label: "Create Worktree...",
      icon: codicon("list-tree", 14),
      action: () => vscode.postMessage({ type: "createWorktreeFromCommit", hash }),
      baretreeRecommended: baretreeAvailable,
    },
    {
      label: "Cherry-pick",
      icon: codicon("git-commit", 14),
      action: () => vscode.postMessage({ type: "cherryPick", hash }),
    },
    {
      label: "Revert",
      icon: codicon("discard", 14),
      action: () => vscode.postMessage({ type: "revertCommit", hash }),
      separator: true,
    },
    {
      label: "Reset to Here...",
      icon: codicon("history", 14),
      action: () => vscode.postMessage({ type: "resetToCommit", hash }),
      separator: true,
    },
    {
      label: "Create Tag...",
      icon: codicon("tag", 14),
      action: () => vscode.postMessage({ type: "createTagAtCommit", hash }),
    },
    {
      label: "Merge into Current Branch",
      icon: codicon("git-merge", 14),
      action: () => vscode.postMessage({ type: "mergeCommit", hash }),
    },
    {
      label: "Rebase Current Branch onto Here",
      icon: codicon("git-compare", 14),
      action: () => vscode.postMessage({ type: "rebaseOntoCommit", hash }),
    },
    {
      label: "Interactive Rebase onto Here...",
      icon: codicon("list-ordered", 14),
      action: () => vscode.postMessage({ type: "interactiveRebaseOntoCommit", hash }),
    },
    );
  }

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
    }

    const row = document.createElement("div");
    row.className = "context-menu-item" + (item.baretreeRecommended ? " context-menu-item-baretree" : "");

    const iconEl = document.createElement("span");
    iconEl.className = "context-menu-icon";
    iconEl.innerHTML = item.icon;

    const labelEl = document.createElement("span");
    labelEl.className = "context-menu-label";
    labelEl.textContent = item.label;

    row.appendChild(iconEl);
    row.appendChild(labelEl);

    if (item.baretreeRecommended) {
      const badge = document.createElement("span");
      badge.className = "context-menu-baretree-badge";
      badge.textContent = "(use baretree)";
      row.appendChild(badge);
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      item.action();
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Position: ensure menu stays within viewport
  const rect = menu.getBoundingClientRect();
  const menuX = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
  const menuY = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
  menu.style.left = `${Math.max(0, menuX)}px`;
  menu.style.top = `${Math.max(0, menuY)}px`;
}

function showRefContextMenu(x: number, y: number, ref: RefInfo): void {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items: ContextMenuItem[] = [];

  if (rebaseMode) {
    // Rebase mode: show only read-only (non-side-effect) items
    if (ref.type === "branch" || ref.type === "head") {
      items.push({
        label: `Copy Branch Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyBranchName", branch: ref.name }),
      });
    } else if (ref.type === "remote") {
      items.push({
        label: `Copy Branch Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyBranchName", branch: ref.name }),
      });
    } else if (ref.type === "tag") {
      items.push({
        label: `Copy Tag Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyTagName", tag: ref.name }),
      });
    }
  } else {
    // Normal mode: full context menu
    if (ref.type === "branch" || ref.type === "head") {
      if (worktreeBranches.has(ref.name)) {
        items.push({
          label: `Select Worktree Repository`,
          icon: codicon("repo", 14),
          action: () => vscode.postMessage({ type: "selectWorktreeRepo", branch: ref.name }),
        });
        items.push({
          label: `Open Worktree`,
          icon: codicon("list-tree", 14),
          action: () => vscode.postMessage({ type: "openWorktree", branch: ref.name }),
        });
        items.push({
          label: `Add Worktree to Workspace`,
          icon: codicon("window", 14),
          action: () => vscode.postMessage({ type: "addWorktreeToWorkspace", branch: ref.name }),
        });
        if (baretreeAvailable) {
          items.push({
            label: `Rename Worktree '${ref.name}' with baretree`,
            icon: codicon("edit", 14),
            action: () => vscode.postMessage({ type: "renameWorktreeWithBaretree", branch: ref.name }),
          });
        }
        items.push({
          label: `Rename Worktree '${ref.name}'`,
          icon: codicon("edit", 14),
          action: () => vscode.postMessage({ type: "renameWorktree", branch: ref.name }),
          baretreeRecommended: baretreeAvailable,
        });
        if (baretreeAvailable) {
          items.push({
            label: `Delete Worktree '${ref.name}' with baretree`,
            icon: codicon("trash", 14),
            action: () => vscode.postMessage({ type: "deleteWorktreeWithBaretree", branch: ref.name }),
          });
        }
        items.push({
          label: `Delete Worktree '${ref.name}'`,
          icon: codicon("trash", 14),
          action: () => vscode.postMessage({ type: "deleteWorktree", branch: ref.name }),
          baretreeRecommended: baretreeAvailable,
        });
      }
      if (!worktreeBranches.has(ref.name)) {
        if (baretreeAvailable) {
          items.push({
            label: `Create Worktree from '${ref.name}' with baretree`,
            icon: codicon("list-tree", 14),
            action: () => vscode.postMessage({ type: "createWorktreeWithBaretreeFromRef", ref: ref.name, refType: ref.type }),
          });
        }
        items.push({
          label: `Create Worktree from '${ref.name}'`,
          icon: codicon("list-tree", 14),
          action: () => vscode.postMessage({ type: "createWorktreeFromRef", ref: ref.name, refType: ref.type }),
          baretreeRecommended: baretreeAvailable,
        });
      }
      items.push({
        label: `Checkout ${ref.name}`,
        icon: codicon("check", 14),
        action: () => vscode.postMessage({ type: "checkoutRef", ref: ref.name, refType: ref.type }),
        baretreeRecommended: baretreeAvailable,
      });
      items.push({
        label: `Copy Branch Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyBranchName", branch: ref.name }),
      });
      items.push({
        label: `Merge ${ref.name} into Current`,
        icon: codicon("git-merge", 14),
        action: () => vscode.postMessage({ type: "mergeRef", ref: ref.name }),
        separator: true,
      });
      items.push({
        label: `Rebase Current Branch onto ${ref.name}`,
        icon: codicon("git-pull-request", 14),
        action: () => vscode.postMessage({ type: "rebaseOntoRef", ref: ref.name }),
      });
      items.push({
        label: `Interactive Rebase onto ${ref.name}`,
        icon: codicon("list-ordered", 14),
        action: () => vscode.postMessage({ type: "interactiveRebaseOntoRef", ref: ref.name }),
      });
      items.push({
        label: `Push ${ref.name}`,
        icon: codicon("cloud-upload", 14),
        action: () => vscode.postMessage({ type: "pushRef", ref: ref.name }),
        separator: true,
      });
      items.push({
        label: `Pull ${ref.name}`,
        icon: codicon("cloud-download", 14),
        action: () => vscode.postMessage({ type: "pullRef", ref: ref.name }),
      });
      items.push({
        label: `Rename Branch '${ref.name}'`,
        icon: codicon("edit", 14),
        action: () => vscode.postMessage({ type: "renameRef", ref: ref.name }),
        separator: true,
        baretreeRecommended: baretreeAvailable,
      });
      items.push({
        label: `Delete Branch '${ref.name}'`,
        icon: codicon("trash", 14),
        action: () => vscode.postMessage({ type: "deleteRef", ref: ref.name, refType: "branch" }),
        baretreeRecommended: baretreeAvailable && worktreeBranches.has(ref.name),
      });
    } else if (ref.type === "remote") {
      if (baretreeAvailable) {
        items.push({
          label: `Create Worktree from '${ref.name}' with baretree`,
          icon: codicon("list-tree", 14),
          action: () => vscode.postMessage({ type: "createWorktreeWithBaretreeFromRef", ref: ref.name, refType: "remote" }),
        });
      }
      items.push({
        label: `Create Worktree from '${ref.name}'`,
        icon: codicon("list-tree", 14),
        action: () => vscode.postMessage({ type: "createWorktreeFromRef", ref: ref.name, refType: "remote" }),
        baretreeRecommended: baretreeAvailable,
      });
      items.push({
        label: `Checkout ${ref.name}`,
        icon: codicon("check", 14),
        action: () => vscode.postMessage({ type: "checkoutRef", ref: ref.name, refType: "remote" }),
        baretreeRecommended: baretreeAvailable,
      });
      items.push({
        label: `Copy Branch Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyBranchName", branch: ref.name }),
      });
      items.push({
        label: `Merge ${ref.name} into Current`,
        icon: codicon("git-merge", 14),
        action: () => vscode.postMessage({ type: "mergeRef", ref: ref.name }),
        separator: true,
      });
      items.push({
        label: `Rebase Current Branch onto ${ref.name}`,
        icon: codicon("git-pull-request", 14),
        action: () => vscode.postMessage({ type: "rebaseOntoRef", ref: ref.name }),
      });
      items.push({
        label: `Interactive Rebase onto ${ref.name}`,
        icon: codicon("list-ordered", 14),
        action: () => vscode.postMessage({ type: "interactiveRebaseOntoRef", ref: ref.name }),
        separator: true,
      });
      items.push({
        label: `Delete Remote Branch '${ref.name}'`,
        icon: codicon("trash", 14),
        action: () => vscode.postMessage({ type: "deleteRef", ref: ref.name, refType: "remote" }),
      });
    } else if (ref.type === "tag") {
      items.push({
        label: `Checkout ${ref.name}`,
        icon: codicon("check", 14),
        action: () => vscode.postMessage({ type: "checkoutRef", ref: ref.name, refType: "tag" }),
        baretreeRecommended: baretreeAvailable,
      });
      items.push({
        label: `Copy Tag Name`,
        icon: codicon("copy", 14),
        action: () => vscode.postMessage({ type: "copyTagName", tag: ref.name }),
      });
      items.push({
        label: `Push Tag ${ref.name}`,
        icon: codicon("cloud-upload", 14),
        action: () => vscode.postMessage({ type: "pushTag", tag: ref.name }),
        separator: true,
      });
      items.push({
        label: `Delete Tag ${ref.name}`,
        icon: codicon("trash", 14),
        action: () => vscode.postMessage({ type: "deleteTag", tag: ref.name }),
        separator: true,
      });
    }
  }

  if (items.length === 0) return;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
    }

    const row = document.createElement("div");
    row.className = "context-menu-item" + (item.baretreeRecommended ? " context-menu-item-baretree" : "");

    const iconEl = document.createElement("span");
    iconEl.className = "context-menu-icon";
    iconEl.innerHTML = item.icon;

    const labelEl = document.createElement("span");
    labelEl.className = "context-menu-label";
    labelEl.textContent = item.label;

    row.appendChild(iconEl);
    row.appendChild(labelEl);

    if (item.baretreeRecommended) {
      const badge = document.createElement("span");
      badge.className = "context-menu-baretree-badge";
      badge.textContent = "(use baretree)";
      row.appendChild(badge);
    }

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      item.action();
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  const menuX = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
  const menuY = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
  menu.style.left = `${Math.max(0, menuX)}px`;
  menu.style.top = `${Math.max(0, menuY)}px`;
}

function showStashContextMenu(x: number, y: number, stashIndex: number): void {
  dismissContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items: ContextMenuItem[] = rebaseMode
    ? [
        {
          label: "Copy Stash Name",
          icon: codicon("copy", 14),
          action: () => vscode.postMessage({ type: "stashCopyName", index: stashIndex }),
        },
      ]
    : [
        {
          label: "Apply Stash",
          icon: codicon("check", 14),
          action: () => vscode.postMessage({ type: "stashApply", index: stashIndex }),
        },
        {
          label: "Pop Stash",
          icon: codicon("check-all", 14),
          action: () => vscode.postMessage({ type: "stashPop", index: stashIndex }),
          separator: true,
        },
        {
          label: "Create Branch from Stash...",
          icon: codicon("git-branch", 14),
          action: () => vscode.postMessage({ type: "stashCreateBranch", index: stashIndex }),
          separator: true,
        },
        {
          label: "Rename Stash...",
          icon: codicon("edit", 14),
          action: () => vscode.postMessage({ type: "stashRename", index: stashIndex }),
          separator: true,
        },
        {
          label: "Copy Stash Name",
          icon: codicon("copy", 14),
          action: () => vscode.postMessage({ type: "stashCopyName", index: stashIndex }),
          separator: true,
        },
        {
          label: "Drop Stash",
          icon: codicon("trash", 14),
          action: () => vscode.postMessage({ type: "stashDrop", index: stashIndex }),
        },
      ];

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
    }

    const row = document.createElement("div");
    row.className = "context-menu-item";

    const iconEl = document.createElement("span");
    iconEl.className = "context-menu-icon";
    iconEl.innerHTML = item.icon;

    const labelEl = document.createElement("span");
    labelEl.className = "context-menu-label";
    labelEl.textContent = item.label;

    row.appendChild(iconEl);
    row.appendChild(labelEl);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      item.action();
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  activeContextMenu = menu;

  const rect = menu.getBoundingClientRect();
  const menuX = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 4 : x;
  const menuY = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 4 : y;
  menu.style.left = `${Math.max(0, menuX)}px`;
  menu.style.top = `${Math.max(0, menuY)}px`;
}

function handleContainmentInfo(data: { hash: string; branches: string[]; tags: string[] }): void {
  containmentInfo = data;
  render();
}

function updateFilterUI(): void {
  // Show containment filter chip in toolbar when a containment filter is active
  if (activeFilter.withinRef) {
    containmentFilterChip.style.display = "";
    containmentFilterChip.innerHTML = "";
    containmentFilterChip.className = "containment-filter-active";

    const text = document.createElement("span");
    text.textContent = activeFilter.withinRef.replace(/^remotes\//, "");
    containmentFilterChip.appendChild(text);

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "\u00d7";
    close.title = "Clear containment filter";
    containmentFilterChip.appendChild(close);

    containmentFilterChip.addEventListener("click", () => {
      const { containingCommit: _c, withinRef: _w, ...rest } = activeFilter;
      activeFilter = rest;
      commits = [];
      vscode.postMessage({ type: "setFilter", filter: activeFilter });
      updateFilterUI();
    }, { once: true });
  } else {
    containmentFilterChip.style.display = "none";
  }
}

function handlePRInfo(data: Record<string, PullRequestInfo | null>): void {
  let needsRender = false;
  for (const [hash, info] of Object.entries(data)) {
    const existing = prInfoCache.get(hash);
    if (info && (!existing || existing.source === "pattern" || existing.source === "git-config")) {
      prInfoCache.set(hash, info);
      needsRender = true;
    } else if (info && existing && existing.source === "github-api" && existing.state !== info.state) {
      // Update cached github-api entry when PR state has changed (e.g. open -> merged)
      prInfoCache.set(hash, info);
      needsRender = true;
    } else if (info === null && !existing) {
      // Only cache null if there's no existing info to preserve
      const commit = commits.find(c => c.hash === hash);
      if (!commit?.prInfo) {
        prInfoCache.set(hash, null);
      }
    }
  }
  if (needsRender) {
    render();
  }
}

function requestPRInfoForVisibleCommits(): void {
  const hashesToFetch: string[] = [];
  for (const commit of commits) {
    if (prInfoCache.has(commit.hash) || prInfoRequested.has(commit.hash)) continue;
    // Pattern-matched commits with known state don't need API calls
    if (commit.prInfo && commit.prInfo.source === "pattern") {
      prInfoCache.set(commit.hash, commit.prInfo);
      continue;
    }
    // Branch tip commits (including git-config ones) need API to resolve state
    if (commit.isBranchTip) {
      hashesToFetch.push(commit.hash);
    }
  }
  if (hashesToFetch.length > 0) {
    for (const hash of hashesToFetch) {
      prInfoRequested.add(hash);
    }
    vscode.postMessage({ type: "requestPRInfo", hashes: hashesToFetch });
  }
}

// --- Git Config in layout options menu ---

function handleGitConfig(entries: GitConfigEntry[], remotes: GitRemoteInfo[]): void {
  gitConfigEntries = entries;
  gitRemotes = remotes;
  renderConfigSection();
}

let authorList: string[] = [];
let selectedAuthor: string | null = null;

function handleAuthorList(authors: string[]): void {
  authorList = authors;
}

const authorDropdownBtn = document.getElementById("authorDropdownBtn")!;
const authorDropdown = document.getElementById("authorDropdown")!;
const authorSelectedChip = document.getElementById("authorSelectedChip")!;

function selectAuthor(author: string, applyFilter = true): void {
  selectedAuthor = author;
  authorFilterInput.value = "";
  authorFilterInput.style.display = "none";
  authorDropdownBtn.style.display = "none";
  authorDropdown.style.display = "none";

  authorSelectedChip.innerHTML = "";
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = author;
  label.title = author;
  authorSelectedChip.appendChild(label);
  const close = document.createElement("span");
  close.className = "chip-close";
  close.textContent = "\u00d7";
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    clearAuthorSelection();
    applyTextFilters();
  });
  authorSelectedChip.appendChild(close);
  authorSelectedChip.style.display = "";

  if (applyFilter) {
    applyTextFilters();
  }
}

function clearAuthorSelection(): void {
  selectedAuthor = null;
  authorSelectedChip.style.display = "none";
  authorSelectedChip.innerHTML = "";
  authorFilterInput.value = "";
  authorFilterInput.style.display = "";
  authorDropdownBtn.style.display = "";
}

function renderAuthorDropdown(filter: string): void {
  authorDropdown.innerHTML = "";
  const lower = filter.toLowerCase();
  const filtered = lower ? authorList.filter(a => a.toLowerCase().includes(lower)) : authorList;
  for (const author of filtered) {
    const item = document.createElement("div");
    item.className = "author-dropdown-item";
    item.textContent = author;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectAuthor(author);
    });
    authorDropdown.appendChild(item);
  }
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "author-dropdown-item";
    empty.textContent = "No matches";
    empty.style.opacity = "0.5";
    authorDropdown.appendChild(empty);
  }
}

authorDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (authorDropdown.style.display === "none") {
    renderAuthorDropdown(authorFilterInput.value.trim());
    authorDropdown.style.display = "";
  } else {
    authorDropdown.style.display = "none";
  }
});

authorFilterInput.addEventListener("focus", () => {
  if (authorList.length > 0) {
    renderAuthorDropdown(authorFilterInput.value.trim());
    authorDropdown.style.display = "";
  }
});

authorFilterInput.addEventListener("input", () => {
  if (authorDropdown.style.display !== "none") {
    renderAuthorDropdown(authorFilterInput.value.trim());
  }
});

authorFilterInput.addEventListener("blur", () => {
  setTimeout(() => {
    authorDropdown.style.display = "none";
  }, 150);
});

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".author-filter-group")) {
    authorDropdown.style.display = "none";
  }
});

function renderConfigSection(): void {
  const section = document.getElementById("configSection");
  if (!section) return;
  section.innerHTML = "";

  // User info entries
  const userEntries = gitConfigEntries.filter((e) => e.key.startsWith("user."));
  if (userEntries.length > 0) {
    section.appendChild(buildSectionHeader("person", "User"));
    for (const entry of userEntries.sort((a, b) => a.key.localeCompare(b.key))) {
      section.appendChild(buildConfigEntryRow(entry, true));
    }
  }

  // Remotes
  if (gitRemotes.length > 0) {
    const sep = document.createElement("div");
    sep.className = "layout-menu-separator";
    section.appendChild(sep);

    const remoteHeader = buildSectionHeader("cloud", "Remotes");
    const addRemoteBtn = document.createElement("span");
    addRemoteBtn.style.cursor = "pointer";
    addRemoteBtn.style.opacity = "0.6";
    addRemoteBtn.style.fontSize = "12px";
    addRemoteBtn.style.marginLeft = "auto";
    addRemoteBtn.innerHTML = codicon("add", 12);
    addRemoteBtn.title = "Add remote";
    addRemoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      promptAddRemote();
    });
    remoteHeader.appendChild(addRemoteBtn);
    section.appendChild(remoteHeader);

    for (const remote of gitRemotes.sort((a, b) => a.name.localeCompare(b.name))) {
      section.appendChild(buildRemoteSection(remote));
    }
  }

  // Other config entries — grouped by section (first part of the key)
  const otherEntries = gitConfigEntries.filter(
    (e) => !e.key.startsWith("user.") && !e.key.startsWith("remote."),
  );
  if (otherEntries.length > 0) {
    const sep = document.createElement("div");
    sep.className = "layout-menu-separator";
    section.appendChild(sep);

    // Group by top-level section name
    const groups = new Map<string, GitConfigEntry[]>();
    for (const entry of otherEntries) {
      const sectionName = entry.key.split(".")[0];
      if (!groups.has(sectionName)) groups.set(sectionName, []);
      groups.get(sectionName)!.push(entry);
    }

    const sortedSections = [...groups.keys()].sort();
    for (const sectionName of sortedSections) {
      const entries = groups.get(sectionName)!;
      section.appendChild(buildConfigGroupSection(sectionName, entries));
    }
  }

  // Add entry button
  const addSep = document.createElement("div");
  addSep.className = "layout-menu-separator";
  section.appendChild(addSep);
  const addRow = document.createElement("div");
  addRow.className = "config-add-row";
  addRow.innerHTML = `${codicon("add", 12)} Add config entry`;
  addRow.addEventListener("click", (e) => {
    e.stopPropagation();
    promptAddConfig();
  });
  section.appendChild(addRow);
}

function buildSectionHeader(icon: string, label: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "config-section-header";
  header.innerHTML = `${codicon(icon, 12)} ${escapeHtml(label)}`;
  return header;
}

function buildConfigGroupSection(sectionName: string, entries: GitConfigEntry[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "config-group";

  const header = document.createElement("div");
  header.className = "config-group-header";

  const iconName = CONFIG_SECTION_ICONS[sectionName] || "settings-gear";
  header.innerHTML = `${codicon(iconName, 12)} ${escapeHtml(sectionName)}`;

  const toggleIcon = document.createElement("span");
  toggleIcon.className = "config-group-toggle";
  toggleIcon.innerHTML = codicon("chevron-down", 12);
  header.appendChild(toggleIcon);

  const body = document.createElement("div");
  body.className = "config-group-body";

  // Sub-group by subsection if keys have 3+ parts (e.g. branch.main.remote)
  const subGroups = new Map<string, GitConfigEntry[]>();
  const directEntries: GitConfigEntry[] = [];

  for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key))) {
    const parts = entry.key.split(".");
    if (parts.length >= 3) {
      const subKey = parts[1];
      if (!subGroups.has(subKey)) subGroups.set(subKey, []);
      subGroups.get(subKey)!.push(entry);
    } else {
      directEntries.push(entry);
    }
  }

  for (const entry of directEntries) {
    body.appendChild(buildConfigEntryRow(entry, true));
  }

  for (const [subName, subEntries] of [...subGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const subHeader = document.createElement("div");
    subHeader.className = "config-subgroup-header";
    subHeader.textContent = subName;
    body.appendChild(subHeader);

    for (const entry of subEntries) {
      const row = buildConfigEntryRow(entry, true);
      row.style.paddingLeft = "20px";
      body.appendChild(row);
    }
  }

  header.addEventListener("click", (e) => {
    e.stopPropagation();
    const isCollapsed = container.classList.toggle("collapsed");
    toggleIcon.innerHTML = codicon(isCollapsed ? "chevron-right" : "chevron-down", 12);
  });

  container.appendChild(header);
  container.appendChild(body);
  return container;
}

const CONFIG_SECTION_ICONS: Record<string, string> = {
  core: "gear",
  branch: "git-branch",
  merge: "git-merge",
  pull: "cloud-download",
  push: "cloud-upload",
  diff: "diff",
  color: "symbol-color",
  alias: "terminal",
  http: "globe",
  credential: "key",
  init: "new-file",
  fetch: "cloud-download",
  rebase: "git-compare",
  filter: "filter",
  pack: "package",
  gc: "trash",
  log: "history",
  tag: "tag",
  advice: "info",
  status: "info",
  stash: "archive",
  submodule: "file-submodule",
  lfs: "package",
  url: "link",
  safe: "shield",
};

function buildConfigEntryRow(entry: GitConfigEntry, shortKey = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "config-entry-row";

  const keyEl = document.createElement("span");
  keyEl.className = "config-key";
  // When shortKey is true, strip the section prefix for cleaner display
  if (shortKey) {
    const parts = entry.key.split(".");
    keyEl.textContent = parts.length >= 3 ? parts.slice(2).join(".") : parts.slice(1).join(".");
  } else {
    keyEl.textContent = entry.key;
  }
  keyEl.title = entry.key;

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.value = entry.value;
  valueInput.title = `${entry.value} [${entry.scope}]`;
  valueInput.style.flex = "1";
  valueInput.style.minWidth = "0";
  valueInput.addEventListener("change", () => {
    if (valueInput.value.trim() && valueInput.value !== entry.value) {
      vscode.postMessage({
        type: "editGitConfig",
        key: entry.key,
        value: valueInput.value,
        scope: entry.scope,
      });
    }
  });
  valueInput.addEventListener("click", (e) => e.stopPropagation());
  valueInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") valueInput.blur();
  });

  const scopeEl = document.createElement("span");
  scopeEl.className = "config-scope";
  scopeEl.textContent = entry.scope;

  const actions = document.createElement("span");
  actions.className = "config-actions";

  if (!entry.key.startsWith("remote.")) {
    const removeBtn = document.createElement("button");
    removeBtn.innerHTML = codicon("trash", 12);
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: "removeGitConfig",
        key: entry.key,
        scope: entry.scope,
      });
    });
    actions.appendChild(removeBtn);
  }

  row.appendChild(keyEl);
  row.appendChild(valueInput);
  row.appendChild(scopeEl);
  row.appendChild(actions);
  return row;
}

function buildRemoteSection(remote: GitRemoteInfo): HTMLElement {
  const container = document.createElement("div");

  const header = document.createElement("div");
  header.className = "config-remote-header";

  const nameEl = document.createElement("span");
  nameEl.textContent = remote.name;

  const urlEl = document.createElement("span");
  urlEl.style.opacity = "0.5";
  urlEl.style.fontSize = "10px";
  urlEl.style.overflow = "hidden";
  urlEl.style.textOverflow = "ellipsis";
  urlEl.style.whiteSpace = "nowrap";
  urlEl.style.flex = "1";
  urlEl.style.minWidth = "0";
  urlEl.textContent = remote.fetchUrl;
  urlEl.title = `Fetch: ${remote.fetchUrl}\nPush: ${remote.pushUrl}`;

  const actions = document.createElement("span");
  actions.className = "config-actions";

  const renameBtn = document.createElement("button");
  renameBtn.innerHTML = codicon("edit", 12);
  renameBtn.title = "Rename remote";
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    promptRenameRemote(remote.name);
  });

  const urlBtn = document.createElement("button");
  urlBtn.innerHTML = codicon("link", 12);
  urlBtn.title = "Set URL";
  urlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    promptSetRemoteUrl(remote.name, remote.fetchUrl);
  });

  const removeBtn = document.createElement("button");
  removeBtn.innerHTML = codicon("trash", 12);
  removeBtn.title = "Remove remote";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "removeRemote", name: remote.name });
  });

  actions.appendChild(renameBtn);
  actions.appendChild(urlBtn);
  actions.appendChild(removeBtn);

  header.appendChild(nameEl);
  header.appendChild(urlEl);
  header.appendChild(actions);
  container.appendChild(header);

  // Show remote config entries
  const remoteEntries = gitConfigEntries.filter(
    (e) => e.key.startsWith(`remote.${remote.name}.`),
  );
  for (const entry of remoteEntries.sort((a, b) => a.key.localeCompare(b.key))) {
    const row = buildConfigEntryRow(entry, true);
    row.style.paddingLeft = "20px";
    container.appendChild(row);
  }

  return container;
}

// Inline prompt helpers using simple prompt pattern within the menu

function promptAddConfig(): void {
  // Use a small inline form approach: create temporary elements
  const section = document.getElementById("configSection");
  if (!section) return;

  // Remove existing add form if any
  const existing = document.getElementById("configAddForm");
  if (existing) { existing.remove(); return; }

  const form = document.createElement("div");
  form.id = "configAddForm";
  form.style.padding = "4px 10px";
  form.style.display = "flex";
  form.style.flexDirection = "column";
  form.style.gap = "4px";

  const scopeSelect = document.createElement("select");
  scopeSelect.style.cssText = "background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:2px 4px;font-size:11px;";
  scopeSelect.innerHTML = '<option value="local">local</option><option value="global">global</option>';

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.placeholder = "key (e.g. user.name)";
  keyInput.style.cssText = "padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;font-size:11px;";

  const valInput = document.createElement("input");
  valInput.type = "text";
  valInput.placeholder = "value";
  valInput.style.cssText = keyInput.style.cssText;

  const btnRow = document.createElement("div");
  btnRow.style.display = "flex";
  btnRow.style.gap = "4px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add";
  addBtn.style.cssText = "background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:2px 8px;cursor:pointer;font-size:11px;border-radius:2px;";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (keyInput.value.trim() && valInput.value.trim() && keyInput.value.includes(".")) {
      vscode.postMessage({
        type: "addGitConfig",
        key: keyInput.value.trim(),
        value: valInput.value.trim(),
        scope: scopeSelect.value as "local" | "global",
      });
      form.remove();
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "background:none;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 8px;cursor:pointer;font-size:11px;border-radius:2px;opacity:0.7;";
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    form.remove();
  });

  btnRow.appendChild(addBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(scopeSelect);
  form.appendChild(keyInput);
  form.appendChild(valInput);
  form.appendChild(btnRow);

  [scopeSelect, keyInput, valInput, addBtn, cancelBtn].forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") form.remove();
    });
  });

  section.appendChild(form);
  keyInput.focus();
}

function promptAddRemote(): void {
  const section = document.getElementById("configSection");
  if (!section) return;

  const existing = document.getElementById("remoteAddForm");
  if (existing) { existing.remove(); return; }

  const form = document.createElement("div");
  form.id = "remoteAddForm";
  form.style.padding = "4px 10px";
  form.style.display = "flex";
  form.style.flexDirection = "column";
  form.style.gap = "4px";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Remote name (e.g. upstream)";
  nameInput.style.cssText = "padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;font-size:11px;";

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "URL";
  urlInput.style.cssText = nameInput.style.cssText;

  const btnRow = document.createElement("div");
  btnRow.style.display = "flex";
  btnRow.style.gap = "4px";

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add";
  addBtn.style.cssText = "background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:2px 8px;cursor:pointer;font-size:11px;border-radius:2px;";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (nameInput.value.trim() && urlInput.value.trim()) {
      vscode.postMessage({
        type: "addRemote",
        name: nameInput.value.trim(),
        url: urlInput.value.trim(),
      });
      form.remove();
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.cssText = "background:none;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border,transparent);padding:2px 8px;cursor:pointer;font-size:11px;border-radius:2px;opacity:0.7;";
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    form.remove();
  });

  btnRow.appendChild(addBtn);
  btnRow.appendChild(cancelBtn);

  form.appendChild(nameInput);
  form.appendChild(urlInput);
  form.appendChild(btnRow);

  [nameInput, urlInput, addBtn, cancelBtn].forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") form.remove();
    });
  });

  section.appendChild(form);
  nameInput.focus();
}

function promptRenameRemote(oldName: string): void {
  const newName = prompt(`Rename remote '${oldName}' to:`, oldName);
  if (newName && newName !== oldName) {
    vscode.postMessage({ type: "renameRemote", oldName, newName });
  }
}

function promptSetRemoteUrl(name: string, currentUrl: string): void {
  const newUrl = prompt(`New URL for remote '${name}':`, currentUrl);
  if (newUrl && newUrl !== currentUrl) {
    vscode.postMessage({ type: "setRemoteUrl", name, url: newUrl });
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Inline interactive rebase mode ---

function handleRebaseModeData(data: {
  entries: RebaseTodoEntry[];
  currentBranch: string;
  ontoRef: string;
  targetHashes: string[];
}): void {
  rebaseMode = true;
  rebaseOntoRef = data.ontoRef;
  rebaseCurrentBranch = data.currentBranch;
  rebaseTargetHashes = new Set(data.targetHashes);
  rebaseEntries = new Map();
  for (const entry of data.entries) {
    rebaseEntries.set(entry.hash, { ...entry });
  }
  rebaseInProgress = false;
  rebaseState = null;

  updateToolbarForRebaseMode();
  render();
}

function handleRebaseModeExited(): void {
  rebaseMode = false;
  rebaseOntoRef = "";
  rebaseCurrentBranch = "";
  rebaseEntries.clear();
  rebaseTargetHashes.clear();
  rebaseInProgress = false;
  rebaseState = null;

  restoreNormalToolbar();
  render();
}

function handleRebaseProgress(data: { state: RebaseState }): void {
  rebaseState = data.state;
  rebaseInProgress = true;

  // If not already in rebase mode (e.g., detected on webview init), hide normal toolbar
  if (!rebaseMode) {
    rebaseMode = true;
    const filterBar = document.getElementById("filterBar")!;
    const filterBar2 = document.getElementById("filterBar2")!;
    for (const child of Array.from(filterBar.children)) {
      (child as HTMLElement).dataset.rebaseHidden = "true";
      (child as HTMLElement).style.display = "none";
    }
    filterBar2.style.display = "none";
  }

  updateRebaseToolbarProgress();
}

function handleRebaseComplete(_data: { success: boolean; message: string }): void {
  rebaseInProgress = false;
  rebaseState = null;
  // The extension will also send rebaseModeExited + refresh
}

function updateToolbarForRebaseMode(): void {
  const filterBar = document.getElementById("filterBar")!;
  const filterBar2 = document.getElementById("filterBar2")!;
  const bottomBar = document.getElementById("rebaseBottomBar")!;

  // Hide existing toolbar children
  for (const child of Array.from(filterBar.children)) {
    (child as HTMLElement).dataset.rebaseHidden = "true";
    (child as HTMLElement).style.display = "none";
  }
  filterBar2.style.display = "none";

  // Top bar: rebase info only
  const rebaseToolbar = document.createElement("div");
  rebaseToolbar.dataset.rebaseToolbar = "true";
  rebaseToolbar.className = "rebase-toolbar";

  const title = document.createElement("span");
  title.style.cssText = "font-size:12px;font-weight:bold;display:flex;align-items:center;gap:4px;white-space:nowrap;";
  title.innerHTML = `<span class="codicon codicon-git-compare" style="font-size:14px"></span> Interactive Rebase`;
  rebaseToolbar.appendChild(title);

  const ontoLabel = rebaseOntoRef.length > 20 ? rebaseOntoRef.substring(0, 18) + "..." : rebaseOntoRef;
  const info = document.createElement("span");
  info.style.cssText = "font-size:11px;opacity:0.6;font-family:var(--vscode-editor-font-family,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  info.textContent = `${rebaseCurrentBranch} onto ${ontoLabel}`;
  info.title = `${rebaseCurrentBranch} onto ${rebaseOntoRef}`;
  rebaseToolbar.appendChild(info);

  filterBar.appendChild(rebaseToolbar);

  // Bottom bar: action buttons
  bottomBar.innerHTML = "";
  bottomBar.classList.add("visible");

  const bottomInfo = document.createElement("span");
  bottomInfo.className = "rebase-bottom-info";
  bottomInfo.textContent = `${rebaseTargetHashes.size} commit(s)`;
  bottomBar.appendChild(bottomInfo);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "toolbar-btn";
  cancelBtn.title = "Cancel interactive rebase (Esc)";
  cancelBtn.innerHTML = `<span class="codicon codicon-close"></span> Cancel`;
  cancelBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "exitRebaseMode" });
  });
  bottomBar.appendChild(cancelBtn);

  const startBtn = document.createElement("button");
  startBtn.className = "toolbar-btn-primary";
  startBtn.title = "Start interactive rebase";
  startBtn.innerHTML = `<span class="codicon codicon-play"></span> Start Rebase`;
  startBtn.addEventListener("click", () => {
    const orderedEntries: RebaseTodoEntry[] = [];
    for (const [, entry] of rebaseEntries) {
      orderedEntries.push(entry);
    }
    vscode.postMessage({ type: "startRebase", entries: orderedEntries });
  });
  bottomBar.appendChild(startBtn);
}

function updateRebaseToolbarProgress(): void {
  const filterBar = document.getElementById("filterBar")!;
  const bottomBar = document.getElementById("rebaseBottomBar")!;

  // Remove existing rebase toolbar from top
  const existing = filterBar.querySelector("[data-rebase-toolbar]");
  if (existing) existing.remove();

  // Top bar: progress info
  const rebaseToolbar = document.createElement("div");
  rebaseToolbar.dataset.rebaseToolbar = "true";
  rebaseToolbar.className = "rebase-toolbar";

  let stepInfo = "";
  if (rebaseState?.currentStep !== undefined && rebaseState?.totalSteps !== undefined) {
    stepInfo = ` (step ${rebaseState.currentStep}/${rebaseState.totalSteps})`;
  }

  const title = document.createElement("span");
  title.style.cssText = "font-size:12px;font-weight:bold;display:flex;align-items:center;gap:4px;white-space:nowrap;";
  title.innerHTML = `<span class="codicon codicon-sync codicon-modifier-spin" style="font-size:14px"></span> Rebase in progress${escapeHtml(stepInfo)}`;
  rebaseToolbar.appendChild(title);

  if (rebaseState?.conflictedFiles && rebaseState.conflictedFiles.length > 0) {
    const conflict = document.createElement("span");
    conflict.style.cssText = "color:#fcc419;font-size:11px;display:flex;align-items:center;gap:3px;white-space:nowrap;";
    conflict.innerHTML = `<span class="codicon codicon-warning"></span> ${rebaseState.conflictedFiles.length} conflict(s)`;
    rebaseToolbar.appendChild(conflict);
  }

  filterBar.appendChild(rebaseToolbar);

  // Bottom bar: continue/skip/abort buttons
  bottomBar.innerHTML = "";
  bottomBar.classList.add("visible");

  const bottomInfo = document.createElement("span");
  bottomInfo.className = "rebase-bottom-info";
  if (rebaseState?.conflictedFiles && rebaseState.conflictedFiles.length > 0) {
    bottomInfo.textContent = "Resolve conflicts, then continue";
  } else {
    bottomInfo.textContent = stepInfo ? `Step ${rebaseState!.currentStep}/${rebaseState!.totalSteps}` : "Processing...";
  }
  bottomBar.appendChild(bottomInfo);

  const abortBtn = document.createElement("button");
  abortBtn.className = "toolbar-btn-danger";
  abortBtn.title = "Abort rebase";
  abortBtn.innerHTML = `<span class="codicon codicon-stop"></span> Abort`;
  abortBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "inlineRebaseAbort" });
  });
  bottomBar.appendChild(abortBtn);

  const skipBtn = document.createElement("button");
  skipBtn.className = "toolbar-btn";
  skipBtn.title = "Skip current commit";
  skipBtn.innerHTML = `<span class="codicon codicon-debug-step-over"></span> Skip`;
  skipBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "inlineRebaseSkip" });
  });
  bottomBar.appendChild(skipBtn);

  const continueBtn = document.createElement("button");
  continueBtn.className = "toolbar-btn-primary";
  continueBtn.title = "Continue rebase";
  continueBtn.innerHTML = `<span class="codicon codicon-play"></span> Continue`;
  continueBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "inlineRebaseContinue" });
  });
  bottomBar.appendChild(continueBtn);
}

function restoreNormalToolbar(): void {
  const filterBar = document.getElementById("filterBar")!;
  const filterBar2 = document.getElementById("filterBar2")!;
  const bottomBar = document.getElementById("rebaseBottomBar")!;

  // Remove rebase toolbar
  const rebaseToolbar = filterBar.querySelector("[data-rebase-toolbar]");
  if (rebaseToolbar) rebaseToolbar.remove();

  // Hide bottom bar
  bottomBar.classList.remove("visible");
  bottomBar.innerHTML = "";

  // Show original toolbar content
  for (const child of Array.from(filterBar.children)) {
    if ((child as HTMLElement).dataset.rebaseHidden) {
      delete (child as HTMLElement).dataset.rebaseHidden;
      (child as HTMLElement).style.display = "";
    }
  }

  filterBar2.style.display = "";
}

// Keyboard shortcuts for rebase mode
document.addEventListener("keydown", (e) => {
  if (!rebaseMode || rebaseInProgress) return;
  // Don't intercept if user is typing in an input
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

  // Escape cancels rebase mode (but not if a context menu is open)
  if (e.key === "Escape" && !activeContextMenu) {
    e.preventDefault();
    vscode.postMessage({ type: "exitRebaseMode" });
    return;
  }

  if (!selectedHash || !rebaseTargetHashes.has(selectedHash)) return;

  const entry = rebaseEntries.get(selectedHash);
  if (!entry) return;

  const keyMap: Record<string, RebaseAction> = {
    p: "pick",
    r: "reword",
    e: "edit",
    s: "squash",
    f: "fixup",
    d: "drop",
  };

  const action = keyMap[e.key.toLowerCase()];
  if (action) {
    // Block squash/fixup on the oldest commit
    if ((action === "squash" || action === "fixup") && !isSquashAllowed(selectedHash)) return;
    e.preventDefault();
    const previousAction = entry.action;
    entry.action = action;
    if (previousAction === "reword" && action !== "reword") {
      delete entry.newMessage;
    }
    render();
  }
});

vscode.postMessage({ type: "ready" });
