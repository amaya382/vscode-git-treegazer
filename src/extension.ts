import * as vscode from "vscode";
import { RepoManager } from "./services/repoManager";
import { LogPanel } from "./views/logPanel";
import { BranchTreeProvider } from "./views/branchTreeProvider";
import { StashTreeProvider } from "./views/stashTreeProvider";
import { ConfigTreeProvider } from "./views/configTreeProvider";
import { registerCommitCommands } from "./commands/commitCommands";
import { registerBranchCommands } from "./commands/branchCommands";
import { registerStashCommands } from "./commands/stashCommands";
import { registerConfigCommands } from "./commands/configCommands";
import { registerRebaseCommands } from "./commands/rebaseCommands";
import { registerWorktreeCommands } from "./commands/worktreeCommands";
import { GitHubService } from "./services/githubService";
import { ScmSyncService } from "./services/scmSync";
import { WorktreeTreeProvider } from "./views/worktreeTreeProvider";
import { StatusBarManager } from "./views/statusBarItem";
import { COMMANDS, LOG_VIEW_ID, SCM_LOG_VIEW_ID, BRANCHES_VIEW_ID, STASHES_VIEW_ID, CONFIG_VIEW_ID, WORKTREES_VIEW_ID } from "./constants";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Initialize repository manager
  const repoManager = new RepoManager();
  await repoManager.initialize();
  context.subscriptions.push(repoManager);

  // Initialize GitHub service
  const githubService = new GitHubService(repoManager);
  context.subscriptions.push(githubService);

  // Initialize SCM sync service
  const scmSync = new ScmSyncService(repoManager);
  context.subscriptions.push(scmSync);

  // Initialize views
  const logPanel = new LogPanel(context.extensionUri, repoManager, githubService);
  const branchTree = new BranchTreeProvider(repoManager);
  const stashTree = new StashTreeProvider(repoManager);
  const configTree = new ConfigTreeProvider(repoManager);
  const worktreeTree = new WorktreeTreeProvider(repoManager);

  // Register webview providers (activity bar + SCM panel)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LOG_VIEW_ID, logPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(SCM_LOG_VIEW_ID, logPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Register tree views
  const branchTreeView = vscode.window.createTreeView(BRANCHES_VIEW_ID, {
    treeDataProvider: branchTree,
    showCollapseAll: true,
  });
  branchTree.setTreeView(branchTreeView);
  context.subscriptions.push(branchTreeView);

  const stashTreeView = vscode.window.createTreeView(STASHES_VIEW_ID, {
    treeDataProvider: stashTree,
  });
  stashTree.setTreeView(stashTreeView);
  context.subscriptions.push(stashTreeView);

  const configTreeView = vscode.window.createTreeView(CONFIG_VIEW_ID, {
    treeDataProvider: configTree,
    showCollapseAll: true,
  });
  configTree.setTreeView(configTreeView);
  context.subscriptions.push(configTreeView);

  const worktreeTreeView = vscode.window.createTreeView(WORKTREES_VIEW_ID, {
    treeDataProvider: worktreeTree,
    showCollapseAll: true,
  });
  worktreeTree.setTreeView(worktreeTreeView);
  context.subscriptions.push(worktreeTreeView);

  // Update baretree context when active repo changes
  context.subscriptions.push(
    repoManager.onDidChangeActiveRepo(async (service) => {
      const isBt = service ? await service.isBtRepo() : false;
      vscode.commands.executeCommand("setContext", "gitTreegazer.baretreeAvailable", isBt);
    }),
  );

  // Set initial baretree context
  const initialService = repoManager.getActiveService();
  if (initialService) {
    initialService.isBtRepo().then((isBt) => {
      vscode.commands.executeCommand("setContext", "gitTreegazer.baretreeAvailable", isBt);
    });
  }

  // Set initial showOpenInWorktree context and listen for config changes
  const updateShowOpenInWorktreeContext = () => {
    const show = vscode.workspace.getConfiguration("gitTreegazer").get<boolean>("showOpenInWorktree", true);
    vscode.commands.executeCommand("setContext", "gitTreegazer.showOpenInWorktree", show);
  };
  updateShowOpenInWorktreeContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("gitTreegazer.showOpenInWorktree")) {
        updateShowOpenInWorktreeContext();
      }
    }),
  );

  // Initialize status bar
  const statusBar = new StatusBarManager(repoManager);
  context.subscriptions.push(statusBar);

  // Refresh all views
  const refreshAll = async () => {
    await repoManager.refreshWorktreeMetadata();
    vscode.commands.executeCommand("setContext", "gitTreegazer.hasWorktrees", repoManager.hasMultipleWorktrees());
    logPanel.refresh();
    branchTree.refresh();
    stashTree.refresh();
    configTree.refresh();
    worktreeTree.refresh();
    statusBar.update();
  };

  // Register commands
  registerCommitCommands(context, repoManager);
  registerBranchCommands(context, repoManager, refreshAll);
  registerStashCommands(context, repoManager, refreshAll);
  registerConfigCommands(context, repoManager, refreshAll);
  registerRebaseCommands(context, repoManager, logPanel, refreshAll);
  registerWorktreeCommands(context, repoManager, refreshAll);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.REFRESH_LOG, () =>
      logPanel.refresh(true),
    ),
    vscode.commands.registerCommand(COMMANDS.REFRESH_BRANCHES, () =>
      branchTree.refresh(),
    ),
    vscode.commands.registerCommand(COMMANDS.REFRESH_STASHES, () =>
      stashTree.refresh(),
    ),
    vscode.commands.registerCommand(COMMANDS.REFRESH_CONFIG, () =>
      configTree.refresh(),
    ),
    vscode.commands.registerCommand(COMMANDS.REFRESH_WORKTREES, () =>
      worktreeTree.refresh(),
    ),
    vscode.commands.registerCommand(COMMANDS.OPEN_IN_EDITOR, () =>
      logPanel.openInEditor(),
    ),
    vscode.commands.registerCommand(COMMANDS.SHOW_LOG, () =>
      logPanel.openInEditor(),
    ),
    vscode.commands.registerCommand(COMMANDS.SELECT_REPO, async () => {
      const repos = repoManager.getRepoList();
      if (repos.length <= 1) {
        vscode.window.showInformationMessage("Only one repository found.");
        return;
      }
      const activePath = repoManager.getActiveRepoPath();
      const picked = await vscode.window.showQuickPick(
        repos.map((r) => ({
          label: r.path === activePath ? `$(check) ${r.name}` : r.name,
          description: r.group || r.path,
          detail: r.group ? r.path : undefined,
          repoPath: r.path,
        })),
        {
          placeHolder: "Select repository",
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (picked) {
        repoManager.setActiveRepo(picked.repoPath);
      }
    }),
  );

  // Register git URI content provider for diff viewing
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("git-treegazer", {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        try {
          const params = JSON.parse(decodeURIComponent(uri.query));
          let service = repoManager.getActiveService();
          if (params.repoPath) {
            service = repoManager.getServiceForPath(params.repoPath) || service;
          }
          if (!service) return "";
          return await service.getFileContentAtCommit(params.ref, params.path);
        } catch {
          return "";
        }
      },
    }),
  );

  // Watch for git changes to auto-refresh
  const gitWatcher = vscode.workspace.createFileSystemWatcher("**/.git/{HEAD,refs/**,index,config,worktrees/**}");
  context.subscriptions.push(gitWatcher);

  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshTimeout) clearTimeout(refreshTimeout);
    refreshTimeout = setTimeout(refreshAll, 500);
  };

  gitWatcher.onDidChange(debouncedRefresh);
  gitWatcher.onDidCreate(debouncedRefresh);
  gitWatcher.onDidDelete(debouncedRefresh);

  // Initial refresh
  vscode.commands.executeCommand("setContext", "gitTreegazer.hasWorktrees", repoManager.hasMultipleWorktrees());
  branchTree.refresh();
  stashTree.refresh();
  configTree.refresh();
  worktreeTree.refresh();
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
