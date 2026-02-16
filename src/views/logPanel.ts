import * as vscode from "vscode";
import * as path from "path";
import { RepoManager } from "../services/repoManager";
import { GitHubService, parseGitHubUrl } from "../services/githubService";
import { DEFAULT_LOG_COUNT, COMMANDS, SCM_LOG_VIEW_ID } from "../constants";
import { WorktreeLifecycleService } from "../services/worktreeLifecycle";
import type { WebviewMessage, ExtensionMessage, LogFilter, LayoutOptions, PullRequestInfo, RebaseTodoEntry, RebaseState } from "../types";

interface WebviewTarget {
  webview: vscode.Webview;
  visible: boolean;
}

export class LogPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private sidebarView?: vscode.WebviewView;
  private scmView?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private currentFilter: LogFilter = {};
  private lastSentCommits = new Map<string, PullRequestInfo>();
  private branchTipMap = new Map<string, string[]>();

  // Inline interactive rebase mode state
  private rebaseMode = false;
  private rebaseOntoRef = "";
  private rebaseCurrentBranch = "";
  private rebaseEntries: RebaseTodoEntry[] = [];
  private rebaseTargetHashes = new Set<string>();
  private rebaseWebview: vscode.Webview | null = null;

  private readonly worktreeLifecycle: WorktreeLifecycleService;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly repoManager: RepoManager,
    private readonly githubService: GitHubService,
  ) {
    this.worktreeLifecycle = new WorktreeLifecycleService(repoManager);
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => {
        this.sendRepoList();
        this.refresh();
      }),
      repoManager.onDidChangeRepos(() => this.sendRepoList()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gitTreegazer.layout")) {
          this.sendLayoutOptions();
        }
      }),
    );
  }

  // --- Sidebar / SCM (WebviewViewProvider) ---

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    if (webviewView.viewType === SCM_LOG_VIEW_ID) {
      this.scmView = webviewView;
    } else {
      this.sidebarView = webviewView;
    }
    this.setupWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.refresh();
      }
    }, undefined, this.disposables);
  }

  // --- Editor panel ---

  openInEditor(): void {
    if (this.editorPanel) {
      this.editorPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "gitTreegazer.logEditor",
      "Git Treegazer",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "out", "webview"),
          vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist"),
        ],
      },
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "icon-light.svg"),
    };
    this.editorPanel = panel;
    this.setupWebview(panel.webview);

    panel.onDidDispose(() => {
      this.editorPanel = undefined;
    }, undefined, this.disposables);
  }

  // --- Shared setup ---

  private setupWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "out", "webview"),
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist"),
      ],
    };

    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg, webview),
      undefined,
      this.disposables,
    );
  }

  private async handleMessage(msg: WebviewMessage, source: vscode.Webview): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.sendRepoListTo(source);
        this.sendLayoutOptionsTo(source);
        this.sendGitConfig(source);
        this.sendAuthors(source);
        this.sendLogTo(source, DEFAULT_LOG_COUNT, 0);
        break;

      case "requestLog":
        await this.sendLogTo(source, msg.count, msg.skip, msg.filter || this.currentFilter);
        break;

      case "setFilter":
        this.currentFilter = msg.filter;
        await this.sendLogTo(source, DEFAULT_LOG_COUNT, 0, msg.filter);
        break;

      case "requestCommitContainment":
        await this.sendCommitContainment(source, msg.hash);
        break;

      case "selectCommit":
        // Keep for backwards compat — no-op now, detail handled inline
        break;

      case "requestCommitDetail":
        await this.sendCommitDetail(source, msg.hash);
        break;

      case "compareCommits":
      case "requestCompareDetail":
        await this.sendCompareDetail(source, msg.hash1, msg.hash2);
        break;

      case "openDiff": {
        const uri1 = createGitUri(`${msg.hash}~1`, msg.oldPath || msg.filePath);
        const uri2 = createGitUri(msg.hash, msg.filePath);
        const title = `${msg.filePath} (${msg.hash.substring(0, 7)})`;
        if (msg.status === "added") {
          const doc = await vscode.workspace.openTextDocument(uri2);
          await vscode.window.showTextDocument(doc, { preview: true });
        } else if (msg.status === "deleted") {
          const doc = await vscode.workspace.openTextDocument(uri1);
          await vscode.window.showTextDocument(doc, { preview: true });
        } else {
          await vscode.commands.executeCommand("vscode.diff", uri1, uri2, title);
        }
        break;
      }

      case "openDiffBetween": {
        const uriA = createGitUri(msg.hash1, msg.oldPath || msg.filePath);
        const uriB = createGitUri(msg.hash2, msg.filePath);
        const titleAB = `${msg.filePath} (${msg.hash1.substring(0, 7)}..${msg.hash2.substring(0, 7)})`;
        await vscode.commands.executeCommand("vscode.diff", uriA, uriB, titleAB);
        break;
      }

      case "copyHash":
        vscode.env.clipboard.writeText(msg.hash);
        vscode.window.showInformationMessage(`Copied: ${msg.hash}`);
        break;

      case "checkoutCommit":
        await this.handleCheckoutCommit(msg.hash);
        break;

      case "createBranchFromCommit":
        await this.handleCreateBranchFromCommit(msg.hash);
        break;

      case "createWorktreeFromCommit":
        await this.handleCreateWorktreeFromCommit(msg.hash);
        break;

      case "createWorktreeFromRef":
        await vscode.commands.executeCommand(COMMANDS.CREATE_WORKTREE, msg.ref);
        break;

      case "createWorktreeWithBaretreeFromRef":
        await vscode.commands.executeCommand(COMMANDS.CREATE_WORKTREE_WITH_BARETREE, msg.ref);
        break;

      case "cherryPick":
        await this.handleCherryPick(msg.hash);
        break;

      case "revertCommit":
        await this.handleRevertCommit(msg.hash);
        break;

      case "resetToCommit":
        await this.handleResetToCommit(msg.hash);
        break;

      case "createTagAtCommit":
        await this.handleCreateTagAtCommit(msg.hash);
        break;

      case "mergeCommit":
        await this.handleMergeCommit(msg.hash);
        break;

      case "rebaseOntoCommit":
        await this.handleRebaseOntoCommit(msg.hash);
        break;

      case "interactiveRebaseOntoCommit":
        await this.enterRebaseMode(source, msg.hash);
        break;

      case "checkoutRef":
        await this.handleCheckoutRef(msg.ref, msg.refType);
        break;

      case "mergeRef":
        await this.handleMergeRef(msg.ref);
        break;

      case "deleteRef":
        await this.handleDeleteRef(msg.ref, msg.refType);
        break;

      case "deleteTag":
        await this.handleDeleteTag(msg.tag);
        break;

      case "pushTag":
        await this.handlePushTag(msg.tag);
        break;

      case "copyBranchName":
        await vscode.env.clipboard.writeText(msg.branch);
        vscode.window.showInformationMessage(`Copied '${msg.branch}' to clipboard.`);
        break;

      case "rebaseOntoRef":
        await this.handleRebaseOntoRef(msg.ref);
        break;

      case "interactiveRebaseOntoRef":
        await this.enterRebaseMode(source, msg.ref);
        break;

      case "pushRef":
        vscode.commands.executeCommand(COMMANDS.PUSH_BRANCH, msg.ref);
        break;

      case "pullRef":
        vscode.commands.executeCommand(COMMANDS.PULL_BRANCH, msg.ref);
        break;

      case "renameRef":
        vscode.commands.executeCommand(COMMANDS.RENAME_BRANCH, msg.ref);
        break;

      case "copyTagName":
        await vscode.env.clipboard.writeText(msg.tag);
        vscode.window.showInformationMessage(`Copied '${msg.tag}' to clipboard.`);
        break;

      case "setLayoutOption": {
        const config = vscode.workspace.getConfiguration("gitTreegazer.layout");
        config.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        break;
      }

      case "selectRepo":
        this.repoManager.setActiveRepo(msg.path);
        break;

      case "fetch":
        await this.handleFetch(source);
        break;

      case "requestPRInfo":
        this.handleRequestPRInfo(source, msg.hashes);
        break;

      case "openUrl":
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;

      case "openWorktree": {
        const wtPath = this.repoManager.getWorktreePathForBranch(msg.branch);
        if (wtPath) {
          vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
        }
        break;
      }

      case "openTerminalAtWorktree": {
        const wtPathForTerminal = this.repoManager.getWorktreePathForBranch(msg.branch);
        if (wtPathForTerminal) {
          const terminal = vscode.window.createTerminal({
            cwd: wtPathForTerminal,
            name: path.basename(wtPathForTerminal),
          });
          terminal.show();
        }
        break;
      }

      case "addWorktreeToWorkspace": {
        const wtPathForWs = this.repoManager.getWorktreePathForBranch(msg.branch);
        if (wtPathForWs) {
          const uri = vscode.Uri.file(wtPathForWs);
          const name = path.basename(wtPathForWs);
          const existing = vscode.workspace.workspaceFolders?.find(
            f => f.uri.fsPath === wtPathForWs,
          );
          if (existing) {
            vscode.window.showInformationMessage(`'${name}' is already in workspace.`);
          } else {
            vscode.workspace.updateWorkspaceFolders(
              vscode.workspace.workspaceFolders?.length ?? 0, 0,
              { uri, name },
            );
            vscode.window.showInformationMessage(`Added '${name}' to workspace folders.`);
          }
        }
        break;
      }

      case "selectWorktreeRepo": {
        const wtRepoPath = this.repoManager.getWorktreePathForBranch(msg.branch);
        if (wtRepoPath) {
          this.repoManager.setActiveRepo(wtRepoPath);
        }
        break;
      }

      case "createWorktreeWithBaretreeFromCommit":
        await this.handleCreateWorktreeWithBaretreeFromCommit(msg.hash);
        break;

      case "renameWorktree":
        await this.handleRenameWorktree(msg.branch);
        break;

      case "renameWorktreeWithBaretree":
        await this.handleRenameWorktreeWithBaretree(msg.branch);
        break;

      case "deleteWorktree":
        await this.handleDeleteWorktree(msg.branch);
        break;

      case "deleteWorktreeWithBaretree":
        await this.handleDeleteWorktreeWithBaretree(msg.branch);
        break;

      case "refresh":
        await this.sendLogTo(source, DEFAULT_LOG_COUNT, 0, this.currentFilter);
        break;

      case "requestGitConfig":
        await this.sendGitConfig(source);
        break;

      case "editGitConfig":
        await this.handleEditGitConfig(source, msg.key, msg.value, msg.scope);
        break;

      case "addGitConfig":
        await this.handleAddGitConfig(source, msg.key, msg.value, msg.scope);
        break;

      case "removeGitConfig":
        await this.handleRemoveGitConfig(source, msg.key, msg.scope);
        break;

      case "addRemote":
        await this.handleAddRemote(source, msg.name, msg.url);
        break;

      case "removeRemote":
        await this.handleRemoveRemote(source, msg.name);
        break;

      case "renameRemote":
        await this.handleRenameRemote(source, msg.oldName, msg.newName);
        break;

      case "setRemoteUrl":
        await this.handleSetRemoteUrl(source, msg.name, msg.url);
        break;

      case "requestAuthors":
        await this.sendAuthors(source);
        break;

      case "requestUncommittedDetail":
        await this.sendUncommittedDetail(source, msg.branch);
        break;

      case "openUncommittedDiff":
        await this.handleOpenUncommittedDiff(msg.filePath, msg.oldPath, msg.status, msg.section, msg.branch);
        break;

      case "requestStashDetail":
        await this.sendStashDetail(source, msg.index);
        break;

      case "stashApply":
        vscode.commands.executeCommand(COMMANDS.STASH_APPLY, msg.index);
        break;

      case "stashPop":
        vscode.commands.executeCommand(COMMANDS.STASH_POP, msg.index);
        break;

      case "stashDrop":
        vscode.commands.executeCommand(COMMANDS.STASH_DROP, msg.index);
        break;

      case "stashCopyName":
        vscode.commands.executeCommand(COMMANDS.STASH_COPY_NAME, msg.index);
        break;

      case "stashCreateBranch":
        vscode.commands.executeCommand(COMMANDS.STASH_CREATE_BRANCH, msg.index);
        break;

      case "stashRename":
        vscode.commands.executeCommand(COMMANDS.STASH_RENAME, msg.index);
        break;

      case "exitRebaseMode":
        await this.exitRebaseMode(source);
        break;

      case "startRebase":
        await this.executeInlineRebase(source, msg.entries);
        break;

      case "inlineRebaseContinue":
        await this.handleInlineRebaseContinue(source);
        break;

      case "inlineRebaseAbort":
        await this.handleInlineRebaseAbort(source);
        break;

      case "inlineRebaseSkip":
        await this.handleInlineRebaseSkip(source);
        break;

      case "worktreeRebaseContinue":
        await this.handleWorktreeRebaseAction(source, msg.branch, msg.worktreePath, "continue");
        break;

      case "worktreeRebaseAbort":
        await this.handleWorktreeRebaseAction(source, msg.branch, msg.worktreePath, "abort");
        break;

      case "worktreeRebaseSkip":
        await this.handleWorktreeRebaseAction(source, msg.branch, msg.worktreePath, "skip");
        break;
    }
  }

  private async handleRequestPRInfo(webview: vscode.Webview, hashes: string[]): Promise<void> {
    try {
      const patternResults = new Map<string, PullRequestInfo>();
      for (const hash of hashes) {
        const pr = this.lastSentCommits.get(hash);
        if (pr) {
          patternResults.set(hash, pr);
        }
      }
      // Build branch tip map for hashes that are branch tips
      const tipMap = new Map<string, string[]>();
      for (const hash of hashes) {
        const branches = this.branchTipMap.get(hash);
        if (branches) {
          tipMap.set(hash, branches);
        }
      }
      const data = await this.githubService.getBatchPRInfo(hashes, patternResults, tipMap);
      this.postTo(webview, { type: "prInfo", data });
    } catch {
      // Silently fail — PR info is supplementary
    }
  }

  private async sendCommitDetail(webview: vscode.Webview, hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      const [files, commit] = await Promise.all([
        service.getCommitDiff(hash),
        service.getCommitInfo(hash),
      ]);
      const isMerge = (commit?.parentHashes.length ?? 0) > 1;
      const mergedCommits = isMerge ? await service.getMergedCommits(hash) : undefined;
      this.postTo(webview, {
        type: "commitDetail",
        hash,
        author: commit?.author ?? "",
        authorEmail: commit?.authorEmail ?? "",
        committer: commit?.committer ?? "",
        committerEmail: commit?.committerEmail ?? "",
        date: commit?.date ?? "",
        message: commit?.message ?? "",
        parentHashes: commit?.parentHashes ?? [],
        files,
        mergedCommits,
        prInfo: commit?.prInfo,
      });
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendCompareDetail(webview: vscode.Webview, hash1: string, hash2: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      const [files, commit1, commit2] = await Promise.all([
        service.getDiffBetween(hash1, hash2),
        service.getCommitInfo(hash1),
        service.getCommitInfo(hash2),
      ]);
      this.postTo(webview, {
        type: "compareDetail",
        hash1,
        hash2,
        files,
        commit1: {
          hash: commit1?.hash ?? hash1,
          abbreviatedHash: commit1?.abbreviatedHash ?? hash1.substring(0, 7),
          author: commit1?.author ?? "",
          date: commit1?.date ?? "",
          message: commit1?.message ?? "",
        },
        commit2: {
          hash: commit2?.hash ?? hash2,
          abbreviatedHash: commit2?.abbreviatedHash ?? hash2.substring(0, 7),
          author: commit2?.author ?? "",
          date: commit2?.date ?? "",
          message: commit2?.message ?? "",
        },
      });
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendUncommittedDetail(webview: vscode.Webview, branch?: string): Promise<void> {
    let service = this.repoManager.getActiveService();
    if (branch) {
      const wtPath = this.repoManager.getWorktreePathForBranch(branch);
      if (wtPath) {
        service = this.repoManager.getServiceForPath(wtPath) || service;
      }
    }
    if (!service) return;

    try {
      const [diff, summary] = await Promise.all([
        service.getUncommittedDiff(),
        service.getUncommittedSummary(),
      ]);
      this.postTo(webview, {
        type: "uncommittedDetail",
        stagedFiles: diff.stagedFiles,
        unstagedFiles: diff.unstagedFiles,
        untrackedFiles: diff.untrackedFiles,
        staged: summary.staged,
        unstaged: summary.unstaged,
        untracked: summary.untracked,
      });
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendStashDetail(webview: vscode.Webview, index: number): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      const files = await service.getStashDiff(index);
      this.postTo(webview, { type: "stashDetail", index, files });
    } catch (err) {
      this.postTo(webview, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleOpenUncommittedDiff(filePath: string, oldPath: string | undefined, status: string, section: "staged" | "unstaged" | "untracked", branch?: string): Promise<void> {
    let service = this.repoManager.getActiveService();
    if (branch) {
      const wtPath = this.repoManager.getWorktreePathForBranch(branch);
      if (wtPath) {
        service = this.repoManager.getServiceForPath(wtPath) || service;
      }
    }
    if (!service) return;

    const repoPath = service.repoPath;
    const workingUri = vscode.Uri.file(path.join(repoPath, filePath));

    if (section === "untracked") {
      // Untracked: just open the file
      const doc = await vscode.workspace.openTextDocument(workingUri);
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }

    if (section === "staged") {
      // Staged: diff HEAD vs index (staged)
      const headUri = createGitUri("HEAD", oldPath || filePath, repoPath);
      const indexUri = createGitUri(":0", filePath, repoPath); // :0 = index/staged
      const title = `${filePath} (Staged)`;

      if (status === "added") {
        const doc = await vscode.workspace.openTextDocument(indexUri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } else if (status === "deleted") {
        const doc = await vscode.workspace.openTextDocument(headUri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } else {
        await vscode.commands.executeCommand("vscode.diff", headUri, indexUri, title);
      }
      return;
    }

    // Unstaged: diff index vs working tree
    const indexUri = createGitUri(":0", oldPath || filePath, repoPath);
    const title = `${filePath} (Unstaged)`;

    if (status === "added") {
      const doc = await vscode.workspace.openTextDocument(workingUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } else if (status === "deleted") {
      const doc = await vscode.workspace.openTextDocument(indexUri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } else {
      await vscode.commands.executeCommand("vscode.diff", indexUri, workingUri, title);
    }
  }

  // --- Context menu actions ---

  private async handleCheckoutCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const btConfirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Create Worktree with baretree" is recommended instead. Continue with checkout anyway?`,
        { modal: true },
        "Continue",
      );
      if (btConfirm !== "Continue") return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Checkout commit ${hash.substring(0, 7)}? This will enter detached HEAD state.`,
      { modal: true },
      "Checkout",
    );
    if (confirm !== "Checkout") return;

    try {
      await service.checkout(hash);
      vscode.window.showInformationMessage(`Checked out ${hash.substring(0, 7)}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Checkout failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCreateBranchFromCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const btConfirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Create Worktree with baretree" is recommended instead. Continue with creating a branch anyway?`,
        { modal: true },
        "Continue",
      );
      if (btConfirm !== "Continue") return;
    }

    const name = await vscode.window.showInputBox({
      prompt: `Create branch from ${hash.substring(0, 7)}`,
      placeHolder: "Branch name",
      validateInput: (v) => v.trim() ? null : "Branch name is required",
    });
    if (!name) return;

    try {
      await service.createBranch(name.trim(), hash);
      vscode.window.showInformationMessage(`Branch "${name.trim()}" created`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Create branch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCreateWorktreeFromCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const btConfirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Create Worktree with baretree" is recommended instead. Continue anyway?`,
        { modal: true },
        "Continue",
      );
      if (btConfirm !== "Continue") return;
    }

    const branchName = await vscode.window.showInputBox({
      prompt: `Create worktree from ${hash.substring(0, 7)}`,
      placeHolder: "Branch name",
      validateInput: (v) => v.trim() ? null : "Branch name is required",
    });
    if (!branchName) return;

    const repoPath = service.repoPath;
    const defaultPath = path.join(path.dirname(repoPath), branchName.trim());

    const wtPath = await vscode.window.showInputBox({
      prompt: "Worktree directory path",
      value: defaultPath,
      validateInput: (v) => v.trim() ? null : "Path is required",
    });
    if (!wtPath) return;

    try {
      await service.addWorktree(wtPath.trim(), branchName.trim(), hash);
      vscode.window.showInformationMessage(`Worktree "${branchName.trim()}" created at ${wtPath.trim()}`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Create worktree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCreateWorktreeWithBaretreeFromCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const branchName = await vscode.window.showInputBox({
      prompt: `Create worktree with baretree from ${hash.substring(0, 7)}`,
      placeHolder: "Branch name (e.g. feat/my-feature)",
      validateInput: (v) => v.trim() ? null : "Branch name is required",
    });
    if (!branchName) return;

    try {
      await service.btAddWorktree(branchName.trim(), hash);
      vscode.window.showInformationMessage(`Worktree "${branchName.trim()}" created with baretree`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Create worktree with baretree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRenameWorktree(branch: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const confirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Rename Worktree with baretree" is recommended instead. Continue with git rename anyway?`,
        { modal: true },
        "Continue",
      );
      if (confirm !== "Continue") return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: `Rename worktree branch '${branch}' to`,
      value: branch,
      validateInput: (v) => {
        if (!v.trim()) return "Branch name is required";
        if (/\s/.test(v)) return "Branch name cannot contain spaces";
        if (v === branch) return "New name must be different";
        return null;
      },
    });
    if (!newName) return;

    try {
      await service.renameBranch(branch, newName.trim());
      vscode.window.showInformationMessage(`Worktree branch '${branch}' renamed to '${newName.trim()}'`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Rename worktree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRenameWorktreeWithBaretree(branch: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const newName = await vscode.window.showInputBox({
      prompt: `Rename worktree '${branch}' with baretree to`,
      value: branch,
      validateInput: (v) => {
        if (!v.trim()) return "Branch name is required";
        if (/\s/.test(v)) return "Branch name cannot contain spaces";
        if (v === branch) return "New name must be different";
        return null;
      },
    });
    if (!newName) return;

    try {
      await service.btRenameWorktree(branch, newName.trim());
      vscode.window.showInformationMessage(`Worktree '${branch}' renamed to '${newName.trim()}' with baretree`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Rename worktree with baretree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDeleteWorktree(branch: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const btConfirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Delete Worktree with baretree" is recommended instead. Continue with git worktree remove anyway?`,
        { modal: true },
        "Continue",
      );
      if (btConfirm !== "Continue") return;
    }

    const wtPath = this.repoManager.getWorktreePathForBranch(branch);
    if (!wtPath) {
      vscode.window.showErrorMessage(`Worktree path not found for branch '${branch}'`);
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove worktree for '${branch}' at ${wtPath}? Also delete the branch?`,
      { modal: true },
      "Remove Worktree Only",
      "Remove & Delete Branch",
    );
    if (!confirm) return;

    try {
      await service.removeWorktree(wtPath, false);
      if (confirm === "Remove & Delete Branch") {
        await service.deleteBranch(branch, true);
      }
      vscode.window.showInformationMessage(`Worktree '${branch}' removed`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Remove worktree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDeleteWorktreeWithBaretree(branch: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const confirm = await vscode.window.showWarningMessage(
      `Remove worktree '${branch}' with baretree? Also delete the branch?`,
      { modal: true },
      "Remove Worktree Only",
      "Remove & Delete Branch",
    );
    if (!confirm) return;

    try {
      const withBranch = confirm === "Remove & Delete Branch";
      await service.btRemoveWorktree(branch, withBranch, false);
      vscode.window.showInformationMessage(`Worktree '${branch}' removed with baretree`);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Remove worktree with baretree failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCherryPick(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const confirm = await vscode.window.showWarningMessage(
      `Cherry-pick commit ${hash.substring(0, 7)}?`,
      { modal: true },
      "Cherry-pick",
    );
    if (confirm !== "Cherry-pick") return;

    try {
      await service.cherryPick(hash);
      vscode.window.showInformationMessage(`Cherry-picked ${hash.substring(0, 7)}`);
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Cherry-pick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRevertCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const confirm = await vscode.window.showWarningMessage(
      `Revert commit ${hash.substring(0, 7)}? This creates a new commit that undoes the changes.`,
      { modal: true },
      "Revert",
    );
    if (confirm !== "Revert") return;

    try {
      await service.revert(hash);
      vscode.window.showInformationMessage(`Reverted ${hash.substring(0, 7)}`);
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleResetToCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const mode = await vscode.window.showQuickPick(
      [
        { label: "Soft", description: "Keep changes in staging area", value: "soft" as const },
        { label: "Mixed", description: "Keep changes in working directory (default)", value: "mixed" as const },
        { label: "Hard", description: "Discard all changes", value: "hard" as const },
      ],
      { placeHolder: `Reset to ${hash.substring(0, 7)} — choose mode`, title: "Git Reset" },
    );
    if (!mode) return;

    if (mode.value === "hard") {
      const confirm = await vscode.window.showWarningMessage(
        "Hard reset will discard all uncommitted changes. This cannot be undone.",
        { modal: true },
        "Reset Hard",
      );
      if (confirm !== "Reset Hard") return;
    }

    try {
      await service.reset(hash, mode.value);
      vscode.window.showInformationMessage(`Reset (${mode.value}) to ${hash.substring(0, 7)}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleCreateTagAtCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const name = await vscode.window.showInputBox({
      prompt: `Create tag at ${hash.substring(0, 7)}`,
      placeHolder: "Tag name",
      validateInput: (v) => v.trim() ? null : "Tag name is required",
    });
    if (!name) return;

    try {
      await service.createTag(name.trim(), hash);
      vscode.window.showInformationMessage(`Tag "${name.trim()}" created at ${hash.substring(0, 7)}`);
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Create tag failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleMergeCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const currentBranch = await service.getCurrentBranch();
    const confirm = await vscode.window.showWarningMessage(
      `Merge commit ${hash.substring(0, 7)} into '${currentBranch}'?`,
      { modal: true },
      "Merge",
    );
    if (confirm !== "Merge") return;

    try {
      const result = await service.merge(hash);
      vscode.window.showInformationMessage(`Merge completed: ${result}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRebaseOntoCommit(hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const currentBranch = await service.getCurrentBranch();
    const confirm = await vscode.window.showWarningMessage(
      `Rebase '${currentBranch}' onto commit ${hash.substring(0, 7)}? This will rewrite commit history.`,
      { modal: true },
      "Rebase",
    );
    if (confirm !== "Rebase") return;

    try {
      const result = await service.rebase(hash);
      vscode.window.showInformationMessage(`Rebase completed: ${result}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Rebase failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRebaseOntoRef(ref: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const currentBranch = await service.getCurrentBranch();
    const confirm = await vscode.window.showWarningMessage(
      `Rebase '${currentBranch}' onto '${ref}'?`,
      { modal: true },
      "Rebase",
    );
    if (confirm !== "Rebase") return;

    try {
      const result = await service.rebase(ref);
      vscode.window.showInformationMessage(`Rebase completed: ${result}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Rebase failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Ref context menu actions ---

  private async handleCheckoutRef(ref: string, refType: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (await service.isBtRepo()) {
      const btConfirm = await vscode.window.showWarningMessage(
        `This repository uses baretree. "Create Worktree with baretree" is recommended instead. Continue with checkout anyway?`,
        { modal: true },
        "Continue",
      );
      if (btConfirm !== "Continue") return;
    }

    try {
      if (refType === "remote") {
        // For remote branches, create a local tracking branch
        const localName = ref.split("/").slice(1).join("/");
        try {
          await service.checkout(localName);
        } catch {
          await service.createBranch(localName, ref);
          await service.checkout(localName);
        }
        vscode.window.showInformationMessage(`Checked out ${localName} (tracking ${ref})`);
      } else {
        await service.checkout(ref);
        vscode.window.showInformationMessage(`Checked out ${ref}`);
      }
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Checkout failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleMergeRef(ref: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const currentBranch = await service.getCurrentBranch();
    const confirm = await vscode.window.showWarningMessage(
      `Merge '${ref}' into '${currentBranch}'?`,
      { modal: true },
      "Merge",
    );
    if (confirm !== "Merge") return;

    try {
      const result = await service.merge(ref);
      vscode.window.showInformationMessage(`Merge completed: ${result}`);
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      vscode.window.showErrorMessage(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDeleteRef(ref: string, refType: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    if (refType === "branch") {
      const confirm = await vscode.window.showWarningMessage(
        `Delete branch '${ref}'?`,
        { modal: true },
        "Delete",
        "Force Delete",
      );
      if (!confirm) return;

      try {
        await service.deleteBranch(ref, confirm === "Force Delete");
        vscode.window.showInformationMessage(`Branch '${ref}' deleted`);
        this.refresh();
        vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (refType === "remote") {
      const confirm = await vscode.window.showWarningMessage(
        `Delete remote branch '${ref}'? This will remove it from the remote server.`,
        { modal: true },
        "Delete",
      );
      if (!confirm) return;

      try {
        await service.deleteRemoteBranch(ref);
        vscode.window.showInformationMessage(`Remote branch '${ref}' deleted`);
        this.refresh();
        vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handlePushTag(tag: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing tag '${tag}'...`,
        },
        async () => {
          await service.pushTag(tag);
        },
      );
      vscode.window.showInformationMessage(`Tag '${tag}' pushed.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Push tag failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleDeleteTag(tag: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const confirm = await vscode.window.showWarningMessage(
      `Delete tag '${tag}'?`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") return;

    try {
      await service.deleteTag(tag);
      vscode.window.showInformationMessage(`Tag '${tag}' deleted`);
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Delete tag failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleFetch(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    this.postTo(webview, { type: "loading", loading: true });
    try {
      await service.fetch();
      vscode.window.showInformationMessage("Fetch completed.");
      this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.postTo(webview, { type: "loading", loading: false });
    }
  }

  // --- Git config ---

  private async sendGitConfig(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      const [entries, remotes] = await Promise.all([
        service.listAllConfig(),
        service.getRemoteList(),
      ]);
      this.postTo(webview, { type: "gitConfig", entries, remotes });
    } catch {
      // Silently fail
    }
  }

  private async sendAuthors(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      const authors = await service.getAuthors();
      this.postTo(webview, { type: "authorList", authors });
    } catch {
      // Silently fail — author list is supplementary
    }
  }

  private async handleEditGitConfig(webview: vscode.Webview, key: string, value: string, scope: "local" | "global"): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.setConfig(key, value, scope);
      await this.sendGitConfig(webview);
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to update config: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleAddGitConfig(webview: vscode.Webview, key: string, value: string, scope: "local" | "global"): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.setConfig(key, value, scope);
      await this.sendGitConfig(webview);
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to add config: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleRemoveGitConfig(webview: vscode.Webview, key: string, scope: "local" | "global"): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.unsetConfig(key, scope);
      await this.sendGitConfig(webview);
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to remove config: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleAddRemote(webview: vscode.Webview, name: string, url: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.addRemote(name, url);
      await this.sendGitConfig(webview);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to add remote: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleRemoveRemote(webview: vscode.Webview, name: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.removeRemote(name);
      await this.sendGitConfig(webview);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to remove remote: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleRenameRemote(webview: vscode.Webview, oldName: string, newName: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.renameRemote(oldName, newName);
      await this.sendGitConfig(webview);
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to rename remote: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async handleSetRemoteUrl(webview: vscode.Webview, name: string, url: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;
    try {
      await service.setRemoteUrl(name, url);
      await this.sendGitConfig(webview);
    } catch (err) {
      this.postTo(webview, { type: "error", message: `Failed to set remote URL: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // --- Layout options ---

  private getLayoutOptions(): LayoutOptions {
    const config = vscode.workspace.getConfiguration("gitTreegazer.layout");
    return {
      abbreviateRefPrefixes: config.get<number>("abbreviateRefPrefixes", 0),
    };
  }

  private sendLayoutOptions(): void {
    const options = this.getLayoutOptions();
    for (const webview of this.getActiveWebviews()) {
      this.postTo(webview, { type: "layoutOptions", options });
    }
  }

  private sendLayoutOptionsTo(webview: vscode.Webview): void {
    this.postTo(webview, { type: "layoutOptions", options: this.getLayoutOptions() });
  }

  // --- Data sending ---

  async refresh(): Promise<void> {
    for (const target of this.getActiveWebviews()) {
      await this.sendLogTo(target, DEFAULT_LOG_COUNT, 0, this.currentFilter);
    }
  }

  private async sendLogTo(webview: vscode.Webview, count: number, skip: number, filter?: LogFilter): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    this.postTo(webview, { type: "loading", loading: true });

    try {
      const effectiveFilter = filter || this.currentFilter;
      const [{ commits, totalCount }, currentBranch, remoteNames, branches, branchPRConfig, stashList] = await Promise.all([
        service.getLog(count, skip, effectiveFilter),
        service.getCurrentBranch(),
        service.getRemoteNames(),
        service.getBranches(),
        service.getBranchPRFromConfig(),
        skip === 0 ? service.getStashList() : Promise.resolve([]),
      ]);

      // Build a set of all branch names (local and remote) for quick lookup
      const allBranchNames = new Set<string>();
      for (const b of branches) {
        allBranchNames.add(b.name); // local: "fix/foo", remote: "origin/fix/foo"
      }

      for (const c of commits) {
        // Extract branch names from commit refs to identify branch tips
        const refBranches: string[] = [];
        for (const ref of c.refs) {
          // refs look like "HEAD -> main", "origin/main", "fix/foo", "tag: v1.0"
          const cleaned = ref.replace(/^HEAD -> /, "");
          if (cleaned.startsWith("tag: ")) continue;
          if (allBranchNames.has(cleaned)) {
            refBranches.push(cleaned);
          }
        }
        if (refBranches.length > 0) {
          c.isBranchTip = true;
          // Store branch names for branch-based PR lookup (strip remote prefixes)
          const localNames: string[] = [];
          for (const b of refBranches) {
            let name = b;
            for (const prefix of remoteNames) {
              const p = prefix + "/";
              if (b.startsWith(p)) { name = b.slice(p.length); break; }
            }
            if (!localNames.includes(name)) localNames.push(name);
          }
          this.branchTipMap.set(c.hash, localNames);
          if (!c.prInfo) {
            // Try matching local branch names against branchPRConfig
            for (const branchName of refBranches) {
              const configPR = branchPRConfig.get(branchName);
              if (configPR) {
                c.prInfo = configPR;
                break;
              }
              // For remote branches like "origin/fix/foo", also try the local name "fix/foo"
              for (const prefix of remoteNames) {
                const p = prefix + "/";
                if (branchName.startsWith(p)) {
                  const localName = branchName.slice(p.length);
                  const configPRLocal = branchPRConfig.get(localName);
                  if (configPRLocal) {
                    c.prInfo = configPRLocal;
                    break;
                  }
                }
              }
              if (c.prInfo) break;
            }
          }
        }
        if (c.prInfo) {
          this.lastSentCommits.set(c.hash, c.prInfo);
        }
      }

      // Fill in missing PR URLs using repo info so webview can render clickable links
      const repoUrl = await service.getRemoteUrl().catch(() => "");
      const repoInfo = parseGitHubUrl(repoUrl);
      if (repoInfo) {
        for (const c of commits) {
          if (c.prInfo && !c.prInfo.url) {
            c.prInfo.url = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${c.prInfo.number}`;
          }
        }
      }

      await this.repoManager.refreshWorktreeMetadata();
      const worktreeBranches = Object.fromEntries(await this.repoManager.getWorktreeBranchInfoExtended());
      const baretreeAvailable = await service.isBtRepo();
      const branchDivergence: Record<string, { ahead: number; behind: number }> = {};
      for (const b of branches) {
        if (!b.remote && b.tracking && (b.ahead || b.behind)) {
          branchDivergence[b.name] = { ahead: b.ahead || 0, behind: b.behind || 0 };
        }
      }

      // Get uncommitted changes summary (only on first page)
      let uncommittedChanges: { hasChanges: boolean; staged: number; unstaged: number; untracked: number } | undefined;
      let worktreeUncommitted: Record<string, { staged: number; unstaged: number; untracked: number }> | undefined;
      if (skip === 0) {
        const summary = await service.getUncommittedSummary();
        const hasChanges = summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0;
        if (hasChanges) {
          uncommittedChanges = { hasChanges, ...summary };
        }

        // Collect uncommitted summaries from other worktrees
        const wtBranchInfo = this.repoManager.getWorktreeBranchInfo();
        const activeRepoPath = this.repoManager.getActiveRepoPath();
        const wtEntries: Promise<[string, { staged: number; unstaged: number; untracked: number }] | null>[] = [];
        for (const [branchName] of wtBranchInfo) {
          const wtPath = this.repoManager.getWorktreePathForBranch(branchName);
          if (!wtPath || wtPath === activeRepoPath) continue;
          const wtService = this.repoManager.getServiceForPath(wtPath);
          if (!wtService) continue;
          wtEntries.push(
            wtService.getUncommittedSummary().then((s) => {
              if (s.staged > 0 || s.unstaged > 0 || s.untracked > 0) {
                return [branchName, s] as [string, { staged: number; unstaged: number; untracked: number }];
              }
              return null;
            }).catch(() => null),
          );
        }
        const results = await Promise.all(wtEntries);
        const filtered = results.filter((r): r is [string, { staged: number; unstaged: number; untracked: number }] => r !== null);
        if (filtered.length > 0) {
          worktreeUncommitted = Object.fromEntries(filtered);
        }
      }

      // Collect worktree rebase states
      let worktreeRebaseStates: import("../types").WorktreeRebaseState[] | undefined;
      if (skip === 0) {
        const states = await service.getAllWorktreeRebaseStates();
        if (states.length > 0) {
          worktreeRebaseStates = states;
        }
      }

      this.postTo(webview, { type: "logData", commits, totalCount, currentBranch, remoteNames, worktreeBranches, branchDivergence, activeFilter: effectiveFilter, isReset: skip === 0, uncommittedChanges, worktreeUncommitted, worktreeRebaseStates, stashes: stashList.length > 0 ? stashList : undefined, baretreeAvailable: baretreeAvailable || undefined });

      // Check for merged worktree branches (lifecycle notification)
      if (skip === 0 && baretreeAvailable) {
        const wtBranchNames = new Set(Object.keys(worktreeBranches));
        this.worktreeLifecycle.checkMergedWorktrees(wtBranchNames, currentBranch, branchPRConfig).catch(() => {});
      }
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.postTo(webview, { type: "loading", loading: false });
    }
  }

  private async sendCommitContainment(webview: vscode.Webview, hash: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      const [branches, tags] = await Promise.all([
        service.getBranchesContaining(hash),
        service.getTagsContaining(hash),
      ]);
      this.postTo(webview, { type: "commitContainment", hash, branches, tags });
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendRepoList(): void {
    for (const webview of this.getActiveWebviews()) {
      this.sendRepoListTo(webview);
    }
  }

  private sendRepoListTo(webview: vscode.Webview): void {
    const repos = this.repoManager.getRepoList();
    const activeRepo = this.repoManager.getActiveRepoPath() || "";
    this.postTo(webview, { type: "repoList", repos, activeRepo });
  }

  private postTo(webview: vscode.Webview, msg: ExtensionMessage): void {
    webview.postMessage(msg);
  }

  private getActiveWebviews(): vscode.Webview[] {
    const targets: vscode.Webview[] = [];
    if (this.sidebarView?.visible) targets.push(this.sidebarView.webview);
    if (this.scmView?.visible) targets.push(this.scmView.webview);
    if (this.editorPanel) targets.push(this.editorPanel.webview);
    return targets;
  }

  // --- HTML ---

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "out", "webview", "main.js"),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"),
    );
    const codiconsFontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.ttf"),
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet" />
  <style>
    @font-face {
      font-family: "codicon";
      font-display: block;
      src: url("${codiconsFontUri}") format("truetype");
    }
  </style>
  <title>Git Treegazer Log</title>
  <style>
    :root {
      --row-height: 26px;
      --graph-width: 120px;
      --author-width: 70px;
      --hash-width: 56px;
      --date-width: 80px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      flex-wrap: wrap;
    }
    .toolbar select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 2px 4px;
      font-size: 12px;
      max-width: 200px;
      min-width: 0;
    }
    .toolbar select:disabled {
      opacity: 0.6;
    }
    .toolbar button {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      opacity: 0.8;
    }
    .toolbar button:hover { opacity: 1; }
    .toolbar-separator {
      width: 1px;
      height: 16px;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar input[type="checkbox"] {
      margin: 0;
      accent-color: var(--vscode-focusBorder);
      cursor: pointer;
    }
    .filter-checkbox-label {
      font-size: 11px;
      cursor: pointer;
      opacity: 0.7;
      user-select: none;
    }
    .filter-checkbox-label:hover { opacity: 1; }
    .containment-chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .containment-chip:hover { opacity: 0.8; }
    .containment-chip.tag {
      background: rgba(252, 196, 25, 0.25);
      color: #fcc419;
    }
    .containment-label {
      opacity: 0.5;
      font-size: 10px;
    }
    .containment-filter-active {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      cursor: pointer;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .containment-filter-active:hover {
      opacity: 0.8;
    }
    .containment-filter-active .close {
      margin-left: 2px;
      opacity: 0.6;
    }
    .containment-filter-active .close:hover {
      opacity: 1;
    }
    .layout-options-wrapper {
      position: relative;
      margin-left: auto;
    }
    .layout-options-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 14px;
      opacity: 0.6;
      padding: 2px 4px;
    }
    .layout-options-btn:hover { opacity: 1; }
    .layout-options-menu {
      position: absolute;
      top: 100%;
      right: 0;
      z-index: 50;
      min-width: 320px;
      max-width: 480px;
      max-height: 70vh;
      overflow-y: auto;
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      font-size: 12px;
    }
    .layout-option {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      cursor: pointer;
      user-select: none;
    }
    .layout-option:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    }
    .layout-option input[type="checkbox"] {
      margin: 0;
      accent-color: var(--vscode-focusBorder);
    }
    .layout-option input[type="number"] {
      width: 48px;
      margin: 0;
      padding: 1px 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-size: 12px;
    }
    .layout-option input[type="text"] {
      width: 160px;
      margin: 0;
      padding: 1px 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-size: 12px;
    }
    .layout-menu-separator {
      height: 1px;
      margin: 4px 8px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    .layout-menu-header {
      padding: 4px 10px 2px;
      font-size: 10px;
      font-weight: bold;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .config-entry-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      font-size: 12px;
    }
    .config-entry-row .config-key {
      opacity: 0.7;
      min-width: 70px;
      flex-shrink: 0;
    }
    .config-entry-row .config-scope {
      font-size: 10px;
      opacity: 0.4;
      flex-shrink: 0;
    }
    .config-entry-row .config-actions {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
      opacity: 0;
    }
    .config-entry-row:hover .config-actions {
      opacity: 0.7;
    }
    .config-actions button {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 0 2px;
      font-size: 12px;
      opacity: 0.6;
    }
    .config-actions button:hover {
      opacity: 1;
    }
    .config-remote-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: bold;
      opacity: 0.7;
    }
    .config-remote-header .config-actions {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
      opacity: 0;
      margin-left: auto;
    }
    .config-remote-header:hover .config-actions {
      opacity: 0.7;
    }
    .config-add-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.6;
    }
    .config-add-row:hover {
      opacity: 1;
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    }
    .config-section-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px 2px;
      font-size: 10px;
      font-weight: bold;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .config-group {
      margin: 0;
    }
    .config-group.collapsed .config-group-body {
      display: none;
    }
    .config-group-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: bold;
      opacity: 0.7;
      cursor: pointer;
      user-select: none;
    }
    .config-group-header:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    }
    .config-group-toggle {
      margin-left: auto;
      opacity: 0.5;
      display: inline-flex;
      align-items: center;
    }
    .config-group-body {
      /* visible by default */
    }
    .config-subgroup-header {
      padding: 2px 10px 1px 14px;
      font-size: 10px;
      font-weight: bold;
      opacity: 0.45;
    }
    .scroll-container {
      overflow: auto;
      flex: 1;
      min-height: 0;
    }
    .commit-row {
      display: flex;
      align-items: center;
      height: var(--row-height);
      padding: 0 4px;
      cursor: pointer;
      white-space: nowrap;
      border-bottom: 1px solid transparent;
    }
    .commit-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .commit-row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .commit-row.selected-secondary {
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .header-row {
      cursor: default;
      font-size: 11px;
      font-weight: bold;
      opacity: 0.6;
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .header-row:hover {
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    .header-row > div {
      overflow: visible;
    }
    .resize-handle {
      position: absolute;
      top: 0;
      right: -2px;
      width: 5px;
      height: 100%;
      cursor: col-resize;
      z-index: 2;
    }
    .resize-handle-left {
      right: auto;
      left: -2px;
    }
    .resize-handle:hover,
    .resize-handle:active {
      background: var(--vscode-focusBorder);
      opacity: 0.5;
    }
    .graph-cell {
      width: var(--graph-width);
      min-width: var(--graph-width);
      flex-shrink: 0;
      height: var(--row-height);
      overflow: hidden;
    }
    .graph-cell canvas {
      display: block;
    }
    .message-cell {
      flex: 1 1 0;
      min-width: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 4px;
      font-size: 13px;
    }
    .refs {
      display: inline;
    }
    .ref-label {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 12.5px;
      padding: 0 5px 0 3px;
      margin-right: 3px;
      border-radius: 3px;
      line-height: 16px;
      vertical-align: middle;
      border: 1px solid currentColor;
    }
    .ref-icon {
      display: inline-flex;
      align-items: center;
      -webkit-text-stroke: 0.5px;
    }
    .ref-name {
    }
    .ref-divergence {
      font-size: 10px;
      font-weight: bold;
      opacity: 0.85;
      margin-left: 1px;
      -webkit-text-stroke: 0.3px;
    }
    .ref-branch {
      color: var(--vscode-badge-foreground);
      border-color: var(--vscode-badge-foreground);
    }
    .ref-remote {
      color: #22b8cf;
      border-color: #22b8cf;
    }
    .ref-merged {
      border-style: dashed;
      opacity: 0.6;
    }
    .ref-badge {
      display: inline-block;
      font-size: 9px;
      padding: 0 3px;
      border-radius: 3px;
      margin-left: 2px;
      vertical-align: middle;
      line-height: 14px;
      font-weight: 600;
    }
    .ref-badge-default {
      background: rgba(255, 255, 255, 0.15);
      color: #e0e0e0;
      border: 1px solid rgba(255, 255, 255, 0.3);
    }
    .ref-badge-rebase {
      background: rgba(255, 152, 0, 0.3);
      color: #ffb74d;
      border: 1px solid rgba(255, 152, 0, 0.5);
      font-weight: bold;
      animation: rebase-pulse 2s ease-in-out infinite;
    }
    @keyframes rebase-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .rebase-wt-actions {
      display: inline-flex;
      gap: 2px;
      margin-left: 3px;
      vertical-align: middle;
    }
    .rebase-wt-btn {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: inherit;
      cursor: pointer;
      padding: 0 3px;
      border-radius: 3px;
      font-size: 12px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      opacity: 0.7;
    }
    .rebase-wt-btn:hover {
      opacity: 1;
      background: rgba(255, 255, 255, 0.1);
    }
    .rebase-wt-btn-abort {
      color: #f44336;
      border-color: rgba(244, 67, 54, 0.3);
    }
    .rebase-wt-btn-abort:hover {
      background: rgba(244, 67, 54, 0.15);
    }
    .ref-tag {
      color: #e1b800;
      background: rgba(225, 184, 0, 0.2);
      border: none;
      font-weight: bold;
    }
    .ref-head {
      font-weight: bold;
      border: 1px solid currentColor;
      padding-left: 0;
      overflow: hidden;
    }
    .ref-head .ref-icon:first-child {
      color: var(--vscode-editor-background, var(--vscode-sideBar-background));
      padding: 0 3px;
      margin: -1px 2px -1px -1px;
      align-self: stretch;
      display: inline-flex;
      align-items: center;
      border-radius: 2px 0 0 2px;
    }
    .author-cell {
      width: var(--author-width);
      min-width: var(--author-width);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
      font-size: 11px;
      opacity: 0.7;
      padding: 0 4px;
    }
    .hash-cell {
      width: var(--hash-width);
      min-width: var(--hash-width);
      flex-shrink: 0;
      text-align: right;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      opacity: 0.7;
      padding: 0 4px;
    }
    .date-cell {
      width: var(--date-width);
      min-width: var(--date-width);
      flex-shrink: 0;
      text-align: right;
      font-size: 11px;
      opacity: 0.7;
      padding: 0 4px;
    }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0.5;
    }
    .load-more {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
    }
    .load-more button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .load-more button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      opacity: 0.5;
      text-align: center;
    }
    .pr-label {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 0 5px 0 3px;
      margin-right: 3px;
      border-radius: 3px;
      line-height: 16px;
      vertical-align: middle;
      font-size: 12px;
      cursor: default;
    }
    .pr-label.pr-open {
      background: rgba(81, 207, 102, 0.2);
      color: #51cf66;
    }
    .pr-label.pr-draft {
      background: rgba(140, 149, 159, 0.2);
      color: #8c959f;
    }
    .pr-label.pr-merged {
      background: rgba(217, 142, 255, 0.2);
      color: #d98eff;
    }
    .pr-label.pr-closed {
      background: rgba(255, 68, 102, 0.15);
      color: #ff4466;
    }
    .pr-label.pr-pending {
      background: rgba(255, 193, 7, 0.07);
      color: rgba(230, 167, 0, 0.6);
      border: 1px dashed rgba(255, 193, 7, 0.25);
    }
    .pr-number {
      font-weight: bold;
    }
    .pr-label.has-url {
      cursor: pointer;
    }
    .pr-label.has-url:hover {
      opacity: 0.8;
    }
    .detail-panel {
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      min-height: 80px;
    }
    .detail-containment {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .detail-left {
      flex: 0 0 50%;
      max-width: 50%;
      padding: 8px 12px;
      border-right: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }
    .detail-right {
      flex: 1;
      padding: 8px 12px;
      overflow-y: auto;
      max-height: 300px;
    }
    .detail-meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
      margin-bottom: 8px;
    }
    .detail-meta-label {
      opacity: 0.5;
      font-weight: bold;
      white-space: nowrap;
    }
    .detail-meta-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-meta-value a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .detail-meta-value a:hover {
      text-decoration: underline;
    }
    .detail-message {
      white-space: pre-wrap;
      word-break: break-word;
      margin-top: 6px;
      line-height: 1.4;
    }
    .detail-merged-commits {
      margin-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
      max-height: 200px;
      overflow-y: auto;
    }
    .detail-merged-header {
      font-weight: bold;
      margin-bottom: 4px;
      opacity: 0.7;
      font-size: 11px;
    }
    .detail-merged-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 11px;
    }
    .detail-merged-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .detail-merged-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      opacity: 0.7;
      flex-shrink: 0;
      width: 55px;
    }
    .detail-merged-msg {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-merged-author {
      opacity: 0.5;
      flex-shrink: 0;
      max-width: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-files-header {
      font-weight: bold;
      margin-bottom: 4px;
      opacity: 0.7;
    }
    .detail-file {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 3px;
    }
    .detail-file:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .detail-file-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .detail-file-icon.added { color: #51cf66; }
    .detail-file-icon.deleted { color: #ff6b6b; }
    .detail-file-icon.modified { color: #fcc419; }
    .detail-file-icon.renamed { color: #339af0; }
    .detail-file-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail-file-stat {
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
    }
    .detail-file-stat .add { color: #51cf66; }
    .detail-file-stat .del { color: #ff6b6b; }
    .detail-loading {
      opacity: 0.5;
      padding: 8px 12px;
      width: 100%;
    }
    .compare-panel {
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      display: flex;
      flex-wrap: wrap;
      font-size: 12px;
      min-height: 80px;
    }
    .compare-left {
      flex: 0 0 50%;
      max-width: 50%;
      padding: 8px 12px;
      border-right: 1px solid var(--vscode-panel-border);
      overflow: hidden;
    }
    .compare-right {
      flex: 1;
      padding: 8px 12px;
      overflow-y: auto;
      max-height: 300px;
    }
    .compare-commit-section {
      margin-bottom: 8px;
    }
    .compare-commit-section:last-child {
      margin-bottom: 0;
    }
    .compare-commit-section + .compare-commit-section {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 8px;
    }
    .compare-commit-label {
      font-weight: bold;
      opacity: 0.7;
      margin-bottom: 4px;
      font-size: 11px;
      text-transform: uppercase;
    }
    .compare-meta {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 10px;
    }
    .compare-meta-label {
      opacity: 0.5;
      font-weight: bold;
      white-space: nowrap;
    }
    .compare-meta-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .compare-message {
      margin-top: 4px;
      opacity: 0.8;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 60px;
      overflow-y: auto;
      font-size: 11px;
    }
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-group {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .filter-label {
      font-size: 10px;
      opacity: 0.5;
      white-space: nowrap;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .filter-negate-btn {
      background: none;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 0 3px;
      font-size: 11px;
      line-height: 16px;
      border-radius: 2px;
      min-width: 18px;
      text-align: center;
      opacity: 0.6;
    }
    .filter-negate-btn:hover { opacity: 1; }
    .filter-negate-btn.active {
      background: rgba(255, 68, 102, 0.2);
      color: #ff4466;
      border-color: #ff4466;
      opacity: 1;
    }
    .filter-input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 1px 4px;
      font-size: 11px;
      border-radius: 2px;
      width: 120px;
      outline: none;
    }
    .filter-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .author-filter-group {
      position: relative;
    }
    .author-selected-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      background: var(--vscode-badge-background, #007acc);
      color: var(--vscode-badge-foreground, #fff);
      padding: 0 6px;
      border-radius: 9px;
      font-size: 11px;
      line-height: 18px;
      max-width: 140px;
      white-space: nowrap;
      cursor: default;
    }
    .author-selected-chip .chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .author-selected-chip .chip-close {
      cursor: pointer;
      opacity: 0.7;
      font-size: 12px;
      line-height: 1;
    }
    .author-selected-chip .chip-close:hover {
      opacity: 1;
    }
    .author-dropdown-btn {
      background: none;
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 0 2px;
      font-size: 10px;
      line-height: 16px;
      border-radius: 2px;
      opacity: 0.6;
      display: inline-flex;
      align-items: center;
    }
    .author-dropdown-btn:hover { opacity: 1; }
    .author-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      z-index: 110;
      min-width: 160px;
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 3px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      margin-top: 2px;
    }
    .author-dropdown-item {
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .author-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .filter-clear-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 11px;
      opacity: 0.5;
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .filter-clear-btn:hover { opacity: 1; }
    .context-menu {
      position: fixed;
      z-index: 100;
      min-width: 180px;
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
      border-radius: 4px;
      padding: 4px 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      font-size: 12px;
    }
    .context-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, inherit);
    }
    .context-menu-icon {
      display: inline-flex;
      align-items: center;
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      opacity: 0.8;
    }
    .context-menu-label {
      flex: 1;
    }
    .context-menu-separator {
      height: 1px;
      margin: 4px 8px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    .context-menu-item-baretree {
      opacity: 0.5;
    }
    .context-menu-item-baretree:hover {
      opacity: 0.7;
    }
    .context-menu-baretree-badge {
      font-size: 10px;
      opacity: 0.6;
      margin-left: 4px;
    }
    .uncommitted-row {
      font-style: italic;
    }
    .uncommitted-row .uncommitted-msg-text {
      opacity: 0.5;
    }
    .uncommitted-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .uncommitted-row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .uncommitted-badge {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 10px;
      padding: 0 5px;
      margin-right: 3px;
      border-radius: 3px;
      line-height: 16px;
      vertical-align: middle;
      font-style: normal;
      background: rgba(180, 180, 180, 0.15);
      color: #999;
    }
    .uncommitted-section-header {
      font-weight: bold;
      margin-top: 8px;
      margin-bottom: 4px;
      opacity: 0.7;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .uncommitted-section-header:first-child {
      margin-top: 0;
    }
    .stash-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .stash-row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .ref-stash {
      color: #d4915c;
      background: rgba(212, 145, 92, 0.2);
      border: none;
      font-weight: bold;
    }
    /* Rebase mode styles */
    .rebase-action-cell {
      width: 60px;
      min-width: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
    }
    .rebase-action-cell:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .rebase-action-badge {
      display: inline-flex;
      align-items: center;
      font-size: 10px;
      font-weight: bold;
      font-family: var(--vscode-editor-font-family, monospace);
      padding: 0 5px;
      border: 1px solid currentColor;
      border-radius: 3px;
      line-height: 16px;
      vertical-align: middle;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .rebase-action-placeholder {
      width: 60px;
      min-width: 60px;
    }
    .commit-row.rebase-non-target {
      opacity: 0.35;
    }
    .commit-row.rebase-non-target:hover {
      opacity: 0.5;
    }
    .commit-row.rebase-drop .message-cell {
      text-decoration: line-through;
      opacity: 0.5;
    }
    .rebase-reword-message {
      cursor: default;
    }
    .rebase-reword-edited {
      font-style: italic;
      color: #339af0;
    }
    .rebase-reword-edit-icon {
      display: inline-flex;
      align-items: center;
      cursor: pointer;
      opacity: 0.4;
      margin-right: 4px;
      flex-shrink: 0;
    }
    .rebase-reword-edit-icon:hover {
      opacity: 1;
    }
    .rebase-reword-input {
      flex: 1;
      min-width: 100px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-focusBorder);
      padding: 1px 4px;
      font-size: inherit;
      font-family: inherit;
      outline: none;
      border-radius: 2px;
    }
    .toolbar-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }
    .toolbar-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .toolbar-btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }
    .toolbar-btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .toolbar-btn-danger {
      background: rgba(255, 107, 107, 0.2);
      color: #ff6b6b;
      border: none;
      padding: 3px 10px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: inherit;
    }
    .toolbar-btn-danger:hover {
      background: rgba(255, 107, 107, 0.3);
    }
    .rebase-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
    }
    .rebase-bottom-bar {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      background: var(--vscode-editor-background);
      flex-shrink: 0;
    }
    .rebase-bottom-bar.visible {
      display: flex;
    }
    .rebase-bottom-bar .rebase-bottom-info {
      font-size: 11px;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .rebase-bottom-bar .toolbar-btn {
      padding: 4px 14px;
      font-size: 12px;
    }
    .rebase-bottom-bar .toolbar-btn-primary {
      padding: 4px 14px;
      font-size: 12px;
    }
    .rebase-bottom-bar .toolbar-btn-danger {
      padding: 4px 14px;
      font-size: 12px;
    }
    .codicon-modifier-spin {
      animation: codicon-spin 1.5s steps(30) infinite;
    }
    @keyframes codicon-spin {
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="toolbar" id="filterBar">
    <select id="repoSelect" title="Select repository"></select>
    <button id="fetchBtn" title="Fetch"><i class="codicon codicon-cloud-download"></i></button>
    <button id="refreshBtn" title="Refresh">&#x21bb;</button>
    <span id="containmentFilterChip" style="display:none;"></span>
    <div class="layout-options-wrapper">
      <button id="layoutOptionsBtn" class="layout-options-btn" title="Layout options">&#x2699;</button>
      <div id="layoutOptionsMenu" class="layout-options-menu" style="display:none;">
        <div class="layout-menu-header">Layout</div>
        <label class="layout-option">
          <span>Abbreviate ref prefixes</span>
          <input type="number" id="abbreviateRefPrefixesInput" min="0" value="0">
        </label>
        <div class="layout-menu-separator"></div>
        <div class="layout-menu-header">Git Config</div>
        <div id="configSection"></div>
      </div>
    </div>
    <div class="toolbar-separator"></div>
    <div class="filter-bar" id="filterBar2">
      <div class="filter-group">
        <span class="filter-label"><span class="codicon codicon-git-branch" style="font-size:12px"></span> Branch</span>
        <button class="filter-negate-btn" id="branchNegateBtn" title="Including matches">+</button>
        <input type="text" class="filter-input" id="branchFilterInput" placeholder="branch name..." />
      </div>
      <div class="filter-group">
        <span class="filter-label"><span class="codicon codicon-comment" style="font-size:12px"></span> Message</span>
        <button class="filter-negate-btn" id="messageNegateBtn" title="Including matches">+</button>
        <input type="text" class="filter-input" id="messageFilterInput" placeholder="commit message..." />
      </div>
      <div class="filter-group author-filter-group">
        <span class="filter-label"><span class="codicon codicon-person" style="font-size:12px"></span> Author</span>
        <button class="filter-negate-btn" id="authorNegateBtn" title="Including matches">+</button>
        <span class="author-selected-chip" id="authorSelectedChip" style="display:none;"></span>
        <input type="text" class="filter-input" id="authorFilterInput" placeholder="author name..." />
        <button class="author-dropdown-btn" id="authorDropdownBtn" title="Select author"><span class="codicon codicon-chevron-down" style="font-size:10px"></span></button>
        <div class="author-dropdown" id="authorDropdown" style="display:none;"></div>
      </div>
      <div class="filter-group">
        <input type="checkbox" id="mergesOnlyToggle" title="Show merge commits only">
        <label class="filter-checkbox-label" for="mergesOnlyToggle">Merges only</label>
      </div>
      <button class="filter-clear-btn" id="clearFiltersBtn" title="Clear all filters" style="display:none;">
        <span class="codicon codicon-close" style="font-size:12px"></span> Clear
      </button>
    </div>
  </div>
  <div class="scroll-container" id="scrollContainer">
    <div id="content"></div>
  </div>
  <div class="rebase-bottom-bar" id="rebaseBottomBar"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // --- Inline interactive rebase mode ---

  async enterRebaseModeFromCommand(onto: string): Promise<void> {
    const webviews = this.getActiveWebviews();
    if (webviews.length === 0) return;
    await this.enterRebaseMode(webviews[0], onto);
  }

  private async enterRebaseMode(webview: vscode.Webview, onto: string): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      const result = await service.getRebaseTodoList(onto);
      if (result.entries.length === 0) {
        vscode.window.showInformationMessage("No commits to rebase.");
        return;
      }

      this.rebaseMode = true;
      this.rebaseOntoRef = onto;
      this.rebaseCurrentBranch = await service.getCurrentBranch();
      this.rebaseEntries = result.entries;
      this.rebaseTargetHashes = new Set(result.entries.map(e => e.hash));
      this.rebaseWebview = webview;

      this.postTo(webview, {
        type: "rebaseModeData",
        entries: result.entries,
        currentBranch: this.rebaseCurrentBranch,
        ontoRef: onto,
        targetHashes: Array.from(this.rebaseTargetHashes),
      });
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: `Failed to prepare rebase: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async exitRebaseMode(webview: vscode.Webview, options?: { abortIfInProgress?: boolean }): Promise<void> {
    const shouldAbort = options?.abortIfInProgress ?? true;
    if (shouldAbort) {
      const service = this.repoManager.getActiveService();
      if (service) {
        try {
          const state = await service.getRebaseState();
          if (state.isRebasing) {
            await service.rebaseAbort();
            vscode.window.showInformationMessage("Rebase aborted.");
            this.refresh();
            vscode.commands.executeCommand("gitTreegazer.refreshBranches");
          }
        } catch {
          // Ignore errors — best effort abort
        }
      }
    }

    this.rebaseMode = false;
    this.rebaseOntoRef = "";
    this.rebaseCurrentBranch = "";
    this.rebaseEntries = [];
    this.rebaseTargetHashes.clear();
    this.rebaseWebview = null;
    this.postTo(webview, { type: "rebaseModeExited" });
  }

  private async executeInlineRebase(webview: vscode.Webview, entries: RebaseTodoEntry[]): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Interactive rebase in progress...",
          cancellable: false,
        },
        async () => {
          const result = await service.interactiveRebase(this.rebaseOntoRef, entries);
          console.log("[git-treegazer] interactiveRebase result:", result);

          const state = await service.getRebaseState();
          console.log("[git-treegazer] post-rebase state:", JSON.stringify(state));
          if (state.isRebasing) {
            // Rebase paused (edit/conflict) — exit rebase mode UI without aborting
            this.postTo(webview, { type: "rebaseComplete", success: true, message: "Rebase paused (edit)" });
            await this.exitRebaseMode(webview, { abortIfInProgress: false });
            this.refresh();
            vscode.commands.executeCommand("gitTreegazer.refreshBranches");
          } else {
            this.postTo(webview, { type: "rebaseComplete", success: true, message: "Rebase completed" });
            await this.exitRebaseMode(webview, { abortIfInProgress: false });
            this.refresh();
            vscode.commands.executeCommand("gitTreegazer.refreshBranches");
          }
        },
      );
    } catch (err) {
      console.log("[git-treegazer] interactiveRebase error:", err);
      const state = await service.getRebaseState();
      if (state.isRebasing) {
        // Rebase paused (conflict/edit) — return to normal view without aborting
        await this.exitRebaseMode(webview, { abortIfInProgress: false });
        this.refresh();
        vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      } else {
        this.postTo(webview, {
          type: "error",
          message: `Rebase failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async handleInlineRebaseContinue(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      await service.rebaseContinue();
      const state = await service.getRebaseState();
      this.postTo(webview, { type: "rebaseComplete", success: true, message: state.isRebasing ? "Rebase paused" : "Rebase completed" });
      await this.exitRebaseMode(webview, { abortIfInProgress: false });
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      const state = await service.getRebaseState();
      if (state.isRebasing) {
        await this.exitRebaseMode(webview, { abortIfInProgress: false });
        this.refresh();
        vscode.commands.executeCommand("gitTreegazer.refreshBranches");
      } else {
        this.postTo(webview, {
          type: "error",
          message: `Rebase continue failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private async handleInlineRebaseAbort(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      await service.rebaseAbort();
      this.postTo(webview, { type: "rebaseComplete", success: false, message: "Rebase aborted" });
      await this.exitRebaseMode(webview, { abortIfInProgress: false });
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: `Rebase abort failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleInlineRebaseSkip(webview: vscode.Webview): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    try {
      await service.rebaseSkip();
      const state = await service.getRebaseState();
      this.postTo(webview, { type: "rebaseComplete", success: true, message: state.isRebasing ? "Rebase paused" : "Rebase completed" });
      await this.exitRebaseMode(webview, { abortIfInProgress: false });
      this.refresh();
      vscode.commands.executeCommand("gitTreegazer.refreshBranches");
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: `Rebase skip failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleWorktreeRebaseAction(webview: vscode.Webview, branch: string, worktreePath: string, action: "continue" | "abort" | "skip"): Promise<void> {
    let wtService = this.repoManager.getServiceForPath(worktreePath);
    if (!wtService) {
      // Register the service on the fly if not yet known (rebase detaches HEAD so worktree may not be in repos map)
      const { GitService } = await import("../services/gitService");
      wtService = new GitService(worktreePath);
    }

    try {
      if (action === "abort") {
        const confirm = await vscode.window.showWarningMessage(
          `Abort the rebase on branch "${branch}"? All progress will be lost.`,
          { modal: true },
          "Abort",
        );
        if (confirm !== "Abort") return;
      }

      let result: string;
      switch (action) {
        case "continue":
          result = await wtService.rebaseContinue();
          break;
        case "abort":
          result = await wtService.rebaseAbort();
          break;
        case "skip":
          result = await wtService.rebaseSkip();
          break;
      }
      vscode.window.showInformationMessage(`${branch}: ${result}`);
      this.refresh();
    } catch (err) {
      this.postTo(webview, {
        type: "error",
        message: `Rebase ${action} failed on ${branch}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  dispose(): void {
    this.editorPanel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function createGitUri(ref: string, filePath: string, repoPath?: string): vscode.Uri {
  return vscode.Uri.parse(
    `git-treegazer:${filePath}?${encodeURIComponent(JSON.stringify({ ref, path: filePath, repoPath }))}`,
  );
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
