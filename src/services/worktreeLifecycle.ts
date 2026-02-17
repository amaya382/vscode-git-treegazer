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

  async checkMergedBranches(
    mergedBranches: string[],
    worktreeBranchNames: Set<string>,
    currentBranch: string,
    branchPRConfig: Map<string, PullRequestInfo>,
    worktreeUncommitted: Record<string, { staged: number; unstaged: number; untracked: number }>,
  ): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) return;

    const isBt = await service.isBtRepo();

    for (const branchName of mergedBranches) {
      if (branchName === currentBranch) continue;
      if (this.notifiedBranches.has(branchName)) continue;
      if (worktreeUncommitted[branchName]) continue;

      const branchPR = branchPRConfig.get(branchName);
      this.notifiedBranches.add(branchName);

      if (worktreeBranchNames.has(branchName)) {
        if (isBt) {
          this.showBtWorktreeCleanupNotification(service, branchName, branchPR?.number);
        } else {
          this.showWorktreeCleanupNotification(service, branchName, branchPR?.number);
        }
      } else {
        this.showBranchCleanupNotification(service, branchName, branchPR?.number);
      }
    }
  }

  private async showBtWorktreeCleanupNotification(
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
      try {
        await service.btRemoveWorktree(branch, withBranch, false);
      } catch (err) {
        const forceConfirm = await vscode.window.showWarningMessage(
          `Worktree '${branch}' has uncommitted changes. Force remove?`,
          { modal: true },
          "Force Remove",
        );
        if (forceConfirm !== "Force Remove") return;
        await service.btRemoveWorktree(branch, withBranch, true);
      }
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

  private async showWorktreeCleanupNotification(
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
      const wtPath = this.repoManager.getWorktreePathForBranch(branch);
      if (!wtPath) {
        vscode.window.showErrorMessage(`Could not find worktree path for branch '${branch}'.`);
        return;
      }
      try {
        await service.removeWorktree(wtPath, false);
      } catch (err) {
        const forceConfirm = await vscode.window.showWarningMessage(
          `Worktree '${branch}' has uncommitted changes. Force remove?`,
          { modal: true },
          "Force Remove",
        );
        if (forceConfirm !== "Force Remove") return;
        await service.removeWorktree(wtPath, true);
      }
      if (withBranch) {
        await service.deleteBranch(branch);
      }
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

  private async showBranchCleanupNotification(
    service: GitService,
    branch: string,
    prNumber?: number,
  ): Promise<void> {
    const prLabel = prNumber ? `PR #${prNumber} for ` : "";
    const action = await vscode.window.showInformationMessage(
      `${prLabel}Branch '${branch}' has been merged. Delete the branch?`,
      "Delete Branch",
      "Dismiss",
    );

    if (!action || action === "Dismiss") return;

    try {
      await service.deleteBranch(branch);
      vscode.window.showInformationMessage(`Branch '${branch}' deleted.`);
      vscode.commands.executeCommand(COMMANDS.REFRESH_BRANCHES);
      vscode.commands.executeCommand(COMMANDS.REFRESH_LOG);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  dispose(): void {
    this.notifiedBranches.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
