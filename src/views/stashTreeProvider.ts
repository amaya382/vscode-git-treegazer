import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import type { GitStash } from "../types";

class StashItem extends vscode.TreeItem {
  constructor(public readonly stash: GitStash) {
    super(stash.message || `stash@{${stash.index}}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = "stashEntry";
    this.iconPath = new vscode.ThemeIcon("archive");
    this.description = `stash@{${stash.index}}`;

    const date = new Date(stash.date);
    this.tooltip = `${stash.message}\n${date.toLocaleString()}\n${stash.hash.substring(0, 7)}`;

    this.command = {
      command: "gitTreegazer.stashShowDiff",
      title: "Show Stash Diff",
      arguments: [stash.index],
    };
  }
}

export class StashTreeProvider
  implements vscode.TreeDataProvider<StashItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    StashItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private stashes: GitStash[] = [];
  private disposables: vscode.Disposable[] = [];
  private treeView?: vscode.TreeView<StashItem>;

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => this.refresh()),
      repoManager.onDidChangeRepos(() => this.updateDescription()),
    );
  }

  setTreeView(view: vscode.TreeView<StashItem>): void {
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
    if (service) {
      try {
        this.stashes = await service.getStashList();
      } catch {
        this.stashes = [];
      }
    } else {
      this.stashes = [];
    }
    this.updateDescription();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: StashItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StashItem): vscode.ProviderResult<StashItem[]> {
    if (element) return [];
    return this.stashes.map((s) => new StashItem(s));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
