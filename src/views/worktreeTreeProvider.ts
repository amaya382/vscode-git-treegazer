import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import type { BaretreeWorktreeEntry, PostCreateAction, SyncToRootEntry } from "../types";

type WorktreeTreeItem =
  | WorktreeGroupItem
  | WorktreeEntryItem
  | PostCreateActionItem
  | SyncToRootItem;

class WorktreeGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupLabel: string,
    public readonly groupType: "worktrees" | "postCreate" | "syncToRoot",
  ) {
    super(
      groupLabel,
      groupType === "worktrees"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `wt-group:${groupType}`;
    this.contextValue = `wtGroup_${groupType}`;
    if (groupType === "worktrees") {
      this.iconPath = new vscode.ThemeIcon("list-tree");
    } else if (groupType === "postCreate") {
      this.iconPath = new vscode.ThemeIcon("zap");
    } else {
      this.iconPath = new vscode.ThemeIcon("file-symlink-directory");
    }
  }
}

class WorktreeEntryItem extends vscode.TreeItem {
  constructor(public readonly worktree: BaretreeWorktreeEntry) {
    super(worktree.branch, vscode.TreeItemCollapsibleState.None);
    this.id = `wt-entry:${worktree.branch}`;
    this.contextValue = worktree.isMain ? "wtEntryDefault" : "wtEntry";

    this.iconPath = worktree.isMain
      ? new vscode.ThemeIcon("star-full")
      : new vscode.ThemeIcon("list-tree");

    const shortHash = worktree.head.substring(0, 7);
    this.description = `${shortHash}  ${worktree.path}`;

    const tooltipParts = [worktree.branch];
    if (worktree.isMain) tooltipParts.push("[Default]");
    tooltipParts.push("[Managed]");
    tooltipParts.push(`HEAD: ${worktree.head}`);
    tooltipParts.push(`Path: ${worktree.path}`);
    this.tooltip = tooltipParts.join("\n");
  }
}

class PostCreateActionItem extends vscode.TreeItem {
  constructor(public readonly action: PostCreateAction) {
    const label = action.type === "command"
      ? `${action.type}: ${action.source}`
      : `${action.type}: ${action.source} (${action.managed ? "managed" : "non-managed"})`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `wt-postcreate:${action.type}:${action.source}`;
    this.contextValue = "wtPostCreateAction";
    if (action.type === "symlink") {
      this.iconPath = new vscode.ThemeIcon("file-symlink-file");
    } else if (action.type === "copy") {
      this.iconPath = new vscode.ThemeIcon("files");
    } else {
      this.iconPath = new vscode.ThemeIcon("terminal");
    }
  }
}

class SyncToRootItem extends vscode.TreeItem {
  constructor(public readonly entry: SyncToRootEntry) {
    const label = !entry.target || entry.source === entry.target
      ? entry.source
      : `${entry.source} -> ${entry.target}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `wt-synctoroot:${entry.source}`;
    this.contextValue = "wtSyncToRootEntry";
    this.iconPath = new vscode.ThemeIcon("file-symlink-file");
  }
}

export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<WorktreeTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    WorktreeTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private worktrees: BaretreeWorktreeEntry[] = [];
  private postCreateActions: PostCreateAction[] = [];
  private syncToRootEntries: SyncToRootEntry[] = [];
  private isBtRepo = false;
  private disposables: vscode.Disposable[] = [];
  private treeView?: vscode.TreeView<WorktreeTreeItem>;

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => this.refresh()),
      repoManager.onDidChangeRepos(() => this.updateDescription()),
    );
  }

  setTreeView(view: vscode.TreeView<WorktreeTreeItem>): void {
    this.treeView = view;
  }

  private updateDescription(): void {
    if (!this.treeView) return;
    if (this.repoManager.getRepoCount() > 1) {
      this.treeView.description = this.repoManager.getActiveRepoName();
    } else {
      this.treeView.description = undefined;
    }
  }

  async refresh(): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (service && await service.isBtRepo()) {
      this.isBtRepo = true;
      const toml = await service.btConfigExport();
      const parsed = service.btParseConfigExport(toml);
      const [worktrees] = await Promise.all([
        service.btListWorktrees(),
      ]);
      this.worktrees = worktrees;
      this.postCreateActions = parsed.postCreate;
      this.syncToRootEntries = parsed.syncToRoot;
    } else {
      this.isBtRepo = false;
      this.worktrees = [];
      this.postCreateActions = [];
      this.syncToRootEntries = [];
    }
    vscode.commands.executeCommand("setContext", "gitTreegazer.btRepo", this.isBtRepo);
    this.updateDescription();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorktreeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(
    element?: WorktreeTreeItem,
  ): vscode.ProviderResult<WorktreeTreeItem[]> {
    if (!this.isBtRepo) {
      return [];
    }

    if (!element) {
      return [
        new WorktreeGroupItem("Worktrees", "worktrees"),
        new WorktreeGroupItem("Post-Create Actions", "postCreate"),
        new WorktreeGroupItem("Sync-to-Root", "syncToRoot"),
      ];
    }

    if (element instanceof WorktreeGroupItem) {
      switch (element.groupType) {
        case "worktrees":
          return [...this.worktrees]
            .sort((a, b) => {
              if (a.isMain && !b.isMain) return -1;
              if (!a.isMain && b.isMain) return 1;
              return a.branch.localeCompare(b.branch);
            })
            .map(wt => new WorktreeEntryItem(wt));
        case "postCreate":
          return this.postCreateActions.map(a => new PostCreateActionItem(a));
        case "syncToRoot":
          return this.syncToRootEntries.map(e => new SyncToRootItem(e));
      }
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
