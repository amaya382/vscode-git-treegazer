import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import type { GitBranch } from "../types";

type BranchTreeItem = BranchGroupItem | BranchItem;

class BranchGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupLabel: string,
    public readonly groupType: "tracked" | "localOnly" | "remoteOnly",
  ) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `branch-group:${groupType}`;
    this.contextValue = "branchGroup";
    if (groupType === "tracked") {
      this.iconPath = new vscode.ThemeIcon("git-compare");
    } else if (groupType === "localOnly") {
      this.iconPath = new vscode.ThemeIcon("git-branch");
    } else {
      this.iconPath = new vscode.ThemeIcon("cloud");
    }
  }
}

interface TrackedPair {
  local: GitBranch;
  remote: GitBranch | undefined;
}

class BranchItem extends vscode.TreeItem {
  constructor(
    public readonly branch: GitBranch,
    pairedRemote?: GitBranch,
    worktreeInfo?: { name: string; path: string },
  ) {
    super(branch.name, vscode.TreeItemCollapsibleState.None);
    this.id = `branch:${branch.remote ? "remote" : "local"}:${branch.name}`;

    const hasLocal = !branch.remote;
    const hasRemote = !!pairedRemote || branch.remote;

    // Context value for menus
    if (hasLocal && pairedRemote) {
      this.contextValue = branch.current ? "trackedBranchCurrent" : worktreeInfo ? "trackedBranchWorktree" : "trackedBranch";
    } else if (branch.remote) {
      this.contextValue = "remoteBranch";
    } else {
      this.contextValue = branch.current ? "localBranchCurrent" : worktreeInfo ? "localBranchWorktree" : "localBranch";
    }

    // Icon: current branch gets check, worktree=window, otherwise local=git-branch, remote=cloud
    if (branch.current) {
      this.iconPath = new vscode.ThemeIcon("check");
    } else if (worktreeInfo) {
      this.iconPath = new vscode.ThemeIcon("window");
    } else if (branch.remote) {
      this.iconPath = new vscode.ThemeIcon("cloud");
    } else {
      this.iconPath = new vscode.ThemeIcon("git-branch");
    }

    // Description
    const parts: string[] = [];

    // Show local/remote presence icons as text markers
    if (hasLocal && hasRemote) {
      // Both local and remote exist — show both markers
      if (branch.current) {
        // Icon is already "check", add branch+cloud markers
        parts.push("⑂ ☁");
      } else {
        // Icon is git-branch, add cloud marker
        parts.push("☁");
      }
    }

    if (worktreeInfo) {
      parts.push("⌂");
    }

    // Ahead/behind for tracked branches
    if (branch.tracking) {
      const ab: string[] = [];
      if (branch.ahead && branch.ahead > 0) ab.push(`↑${branch.ahead}`);
      if (branch.behind && branch.behind > 0) ab.push(`↓${branch.behind}`);
      if (ab.length > 0) {
        parts.push(ab.join(" "));
      }
    }

    parts.push(branch.commitHash.substring(0, 7));
    this.description = parts.join("  ");

    // Tooltip
    const tooltipParts = [branch.name];
    if (hasLocal) tooltipParts.push("Local: ✓");
    if (hasRemote) tooltipParts.push(`Remote: ${pairedRemote?.name ?? branch.name}`);
    if (branch.tracking) tooltipParts.push(`tracking: ${branch.tracking}`);
    if (branch.current) tooltipParts.push("(current)");
    if (worktreeInfo) tooltipParts.push(`Worktree: ${worktreeInfo.name} (${worktreeInfo.path})`);
    if (branch.ahead && branch.ahead > 0) tooltipParts.push(`${branch.ahead} ahead`);
    if (branch.behind && branch.behind > 0) tooltipParts.push(`${branch.behind} behind`);
    this.tooltip = tooltipParts.join("\n");

    // Command on click: checkout
    this.command = {
      command: "gitTreegazer.checkout",
      title: "Checkout",
      arguments: [branch.name],
    };
  }
}

export class BranchTreeProvider
  implements vscode.TreeDataProvider<BranchTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    BranchTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private branches: GitBranch[] = [];
  private worktreeBranchInfo: Map<string, { name: string; path: string }> = new Map();
  private disposables: vscode.Disposable[] = [];
  private treeView?: vscode.TreeView<BranchTreeItem>;

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => this.refresh()),
      repoManager.onDidChangeRepos(() => this.updateDescription()),
    );
  }

  setTreeView(view: vscode.TreeView<BranchTreeItem>): void {
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
        this.branches = await service.getBranches();
      } catch {
        this.branches = [];
      }
    } else {
      this.branches = [];
    }
    this.worktreeBranchInfo = this.repoManager.getWorktreeBranchInfo();
    this.updateDescription();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BranchTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BranchTreeItem): vscode.ProviderResult<BranchTreeItem[]> {
    if (!element) {
      // Root: group by tracked / local-only / remote-only
      const localBranches = this.branches.filter((b) => !b.remote);
      const remoteBranches = this.branches.filter((b) => b.remote);

      // Build tracked pairs: local branches that have a tracking remote
      const trackedPairs: TrackedPair[] = [];
      const pairedRemoteNames = new Set<string>();
      const localOnlyBranches: GitBranch[] = [];

      for (const local of localBranches) {
        if (local.tracking) {
          const remote = remoteBranches.find((r) => r.name === local.tracking);
          trackedPairs.push({ local, remote });
          if (remote) pairedRemoteNames.add(remote.name);
        } else {
          localOnlyBranches.push(local);
        }
      }

      const remoteOnlyBranches = remoteBranches.filter(
        (r) => !pairedRemoteNames.has(r.name),
      );

      const groups: BranchGroupItem[] = [];
      if (trackedPairs.length > 0) {
        groups.push(new BranchGroupItem("Tracked", "tracked"));
      }
      if (localOnlyBranches.length > 0) {
        groups.push(new BranchGroupItem("Local", "localOnly"));
      }
      if (remoteOnlyBranches.length > 0) {
        groups.push(new BranchGroupItem("Remote", "remoteOnly"));
      }
      return groups;
    }

    if (element instanceof BranchGroupItem) {
      const localBranches = this.branches.filter((b) => !b.remote);
      const remoteBranches = this.branches.filter((b) => b.remote);

      if (element.groupType === "tracked") {
        // Show local branches that have tracking, paired with their remote
        return localBranches
          .filter((b) => b.tracking)
          .sort((a, b) => {
            if (a.current && !b.current) return -1;
            if (!a.current && b.current) return 1;
            return a.name.localeCompare(b.name);
          })
          .map((local) => {
            const remote = remoteBranches.find((r) => r.name === local.tracking);
            const wtInfo = this.worktreeBranchInfo.get(local.name);
            return new BranchItem(local, remote, wtInfo);
          });
      }

      if (element.groupType === "localOnly") {
        return localBranches
          .filter((b) => !b.tracking)
          .sort((a, b) => {
            if (a.current && !b.current) return -1;
            if (!a.current && b.current) return 1;
            return a.name.localeCompare(b.name);
          })
          .map((b) => {
            const wtInfo = this.worktreeBranchInfo.get(b.name);
            return new BranchItem(b, undefined, wtInfo);
          });
      }

      if (element.groupType === "remoteOnly") {
        // Remote branches not paired with any local tracking
        const pairedRemoteNames = new Set<string>();
        for (const local of localBranches) {
          if (local.tracking) pairedRemoteNames.add(local.tracking);
        }
        return remoteBranches
          .filter((r) => !pairedRemoteNames.has(r.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((b) => new BranchItem(b));
      }
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
