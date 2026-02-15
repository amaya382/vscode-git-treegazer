import * as vscode from "vscode";
import type { RepoManager } from "./repoManager";
import type { GitService } from "./gitService";
import type { PullRequestInfo } from "../types";
import { COMMANDS } from "../constants";

export class WorktreeLifecycleService implements vscode.Disposable {
  private notifiedBranches = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => {
        this.notifiedBranches.clear();
      }),
    );
  }

  async checkMergedWorktrees(
    worktreeBranchNames: Set<string>,
    currentBranch: string,
    branchPRConfig: Map<string, PullRequestInfo>,
  ): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service || !await service.isBtRepo()) return;

    const defaultBranch = await service.btGetDefaultBranch();
    if (!defaultBranch) return;

    const mergedBranches = await service.getMergedBranches(defaultBranch);

    for (const branchName of worktreeBranchNames) {
      if (branchName === currentBranch) continue;
      if (branchName === defaultBranch) continue;
      if (this.notifiedBranches.has(branchName)) continue;
      if (!mergedBranches.has(branchName)) continue;

      const branchPR = branchPRConfig.get(branchName);
      this.notifiedBranches.add(branchName);
      this.showCleanupNotification(service, branchName, branchPR?.number);
    }
  }

  private async showCleanupNotification(
    service: GitService,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    const prLabel = prNumber ? `PR #${prNumber} for ` : "";
    const action = await vscode.window.showInformationMessage(
      `${prLabel}Worktree '${branch}' has been merged. Clean up the worktree?`,
      "Remove Worktree & Branch",
      "Remove Worktree Only",
      "Dismiss",
    );

    if (!action || action === "Dismiss") return;

    try {
      const withBranch = action === "Remove Worktree & Branch";
      await service.btRemoveWorktree(branch, withBranch, false);
      vscode.window.showInformationMessage(
        `Worktree '${branch}' removed${withBranch ? " with branch" : ""}.`,
      );
      vscode.commands.executeCommand(COMMANDS.REFRESH_WORKTREES);
      vscode.commands.executeCommand(COMMANDS.REFRESH_BRANCHES);
      vscode.commands.executeCommand(COMMANDS.REFRESH_LOG);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  dispose(): void {
    this.notifiedBranches.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
