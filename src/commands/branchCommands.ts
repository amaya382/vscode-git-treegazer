import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { ConflictDetector } from "../services/conflictDetector";
import { COMMANDS } from "../constants";

/** Resolve branch name from either a string or a TreeItem (context menu passes TreeItem). */
function resolveBranchName(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "label" in arg) {
    const label = (arg as { label: unknown }).label;
    if (typeof label === "string") return label;
  }
  return undefined;
}

export function registerBranchCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
  onRefresh: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.CREATE_BRANCH,
      async () => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const name = await vscode.window.showInputBox({
          prompt: "Branch name",
          placeHolder: "feature/my-branch",
          validateInput: (value) => {
            if (!value.trim()) return "Branch name is required";
            if (/\s/.test(value)) return "Branch name cannot contain spaces";
            return null;
          },
        });
        if (!name) return;

        try {
          await service.createBranch(name);
          vscode.window.showInformationMessage(`Branch '${name}' created.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to create branch: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.DELETE_BRANCH,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const localBranches = branches.filter((b) => !b.remote && !b.current);
          if (localBranches.length === 0) {
            vscode.window.showInformationMessage("No deletable branches.");
            return;
          }

          const picked = await vscode.window.showQuickPick(
            localBranches.map((b) => ({
              label: b.name,
              description: b.commitHash.substring(0, 7),
            })),
            { placeHolder: "Select branch to delete" },
          );
          if (!picked) return;
          branchName = picked.label;
        }

        // Check if this branch has an associated worktree
        const wtPath = repoManager.getWorktreePathForBranch(branchName);
        if (wtPath) {
          const isBt = await service.isBtRepo();
          const confirm = await vscode.window.showWarningMessage(
            `Branch '${branchName}' has a worktree. Delete the branch and remove the worktree?`,
            { modal: true },
            "Remove Worktree & Delete Branch",
            "Delete Branch Only",
          );
          if (!confirm) return;

          try {
            if (confirm === "Remove Worktree & Delete Branch") {
              if (isBt) {
                try {
                  await service.btRemoveWorktree(branchName, true, false);
                } catch {
                  const forceConfirm = await vscode.window.showWarningMessage(
                    `Worktree '${branchName}' has uncommitted changes. Force remove?`,
                    { modal: true },
                    "Force Remove",
                  );
                  if (forceConfirm !== "Force Remove") return;
                  await service.btRemoveWorktree(branchName, true, true);
                }
              } else {
                try {
                  await service.removeWorktree(wtPath, false);
                } catch {
                  const forceConfirm = await vscode.window.showWarningMessage(
                    `Worktree '${branchName}' has uncommitted changes. Force remove?`,
                    { modal: true },
                    "Force Remove",
                  );
                  if (forceConfirm !== "Force Remove") return;
                  await service.removeWorktree(wtPath, true);
                }
                await service.deleteBranch(branchName);
              }
              vscode.window.showInformationMessage(
                `Worktree and branch '${branchName}' removed.`,
              );
            } else {
              await service.deleteBranch(branchName);
              vscode.window.showInformationMessage(`Branch '${branchName}' deleted.`);
            }
            onRefresh();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to delete branch: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else {
          const confirm = await vscode.window.showWarningMessage(
            `Delete branch '${branchName}'?`,
            { modal: true },
            "Delete",
            "Force Delete",
          );

          if (!confirm) return;

          try {
            await service.deleteBranch(branchName, confirm === "Force Delete");
            vscode.window.showInformationMessage(`Branch '${branchName}' deleted.`);
            onRefresh();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to delete branch: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CHECKOUT,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const picked = await vscode.window.showQuickPick(
            branches.map((b) => ({
              label: b.current ? `$(check) ${b.name}` : b.name,
              description: b.remote ? "remote" : "local",
              branchName: b.name,
            })),
            { placeHolder: "Select branch to checkout" },
          );
          if (!picked) return;
          branchName = picked.branchName;
        }

        // For remote branches, create local tracking branch
        if (branchName.includes("/")) {
          const localName = branchName.split("/").slice(1).join("/");
          try {
            await service.checkout(localName);
          } catch {
            // Local branch doesn't exist, create it tracking remote
            try {
              await service.createBranch(localName, branchName);
              await service.checkout(localName);
            } catch (err) {
              vscode.window.showErrorMessage(
                `Failed to checkout: ${err instanceof Error ? err.message : err}`,
              );
              return;
            }
          }
        } else {
          try {
            await service.checkout(branchName);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to checkout: ${err instanceof Error ? err.message : err}`,
            );
            return;
          }
        }

        onRefresh();
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.MERGE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const nonCurrent = branches.filter((b) => !b.current);
          const picked = await vscode.window.showQuickPick(
            nonCurrent.map((b) => ({
              label: b.name,
              description: b.remote ? "remote" : "local",
            })),
            { placeHolder: "Select branch to merge into current" },
          );
          if (!picked) return;
          branchName = picked.label;
        }

        // Check for conflicts
        const detector = new ConflictDetector(service.repoPath);
        const conflictResult = await detector.checkMergeConflict(branchName);

        if (conflictResult.hasConflicts) {
          const files = conflictResult.conflictedFiles.join("\n  ");
          const choice = await vscode.window.showWarningMessage(
            `Merge will cause conflicts:\n  ${files}`,
            { modal: true },
            "Merge Anyway",
            "Cancel",
          );
          if (choice !== "Merge Anyway") return;
        } else {
          const confirm = await vscode.window.showInformationMessage(
            `Merge '${branchName}' into current branch? No conflicts detected.`,
            { modal: true },
            "Merge",
          );
          if (confirm !== "Merge") return;
        }

        try {
          const result = await service.merge(branchName);
          vscode.window.showInformationMessage(`Merge completed: ${result}`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Merge failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(COMMANDS.FETCH, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Fetching...",
          },
          async () => {
            await service.fetch();
          },
        );
        vscode.window.showInformationMessage("Fetch completed.");
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Fetch failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      COMMANDS.RENAME_BRANCH,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const localBranches = branches.filter((b) => !b.remote);
          const picked = await vscode.window.showQuickPick(
            localBranches.map((b) => ({
              label: b.current ? `$(check) ${b.name}` : b.name,
              branchName: b.name,
            })),
            { placeHolder: "Select branch to rename" },
          );
          if (!picked) return;
          branchName = picked.branchName;
        }

        const newName = await vscode.window.showInputBox({
          prompt: `Rename '${branchName}' to`,
          value: branchName,
          validateInput: (value) => {
            if (!value.trim()) return "Branch name is required";
            if (/\s/.test(value)) return "Branch name cannot contain spaces";
            if (value === branchName) return "New name must be different";
            return null;
          },
        });
        if (!newName) return;

        try {
          await service.renameBranch(branchName, newName);
          vscode.window.showInformationMessage(
            `Branch '${branchName}' renamed to '${newName}'.`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to rename branch: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.REBASE_ONTO,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const nonCurrent = branches.filter((b) => !b.current);
          const picked = await vscode.window.showQuickPick(
            nonCurrent.map((b) => ({
              label: b.name,
              description: b.remote ? "remote" : "local",
            })),
            { placeHolder: "Select branch to rebase current branch onto" },
          );
          if (!picked) return;
          branchName = picked.label;
        }

        const currentBranch = await service.getCurrentBranch();
        const confirm = await vscode.window.showWarningMessage(
          `Rebase '${currentBranch}' onto '${branchName}'?`,
          { modal: true },
          "Rebase",
        );
        if (confirm !== "Rebase") return;

        try {
          const result = await service.rebase(branchName);
          vscode.window.showInformationMessage(`Rebase completed: ${result}`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Rebase failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.PUSH_BRANCH,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const branches = await service.getBranches();
          const localBranches = branches.filter((b) => !b.remote);
          const picked = await vscode.window.showQuickPick(
            localBranches.map((b) => ({
              label: b.current ? `$(check) ${b.name}` : b.name,
              description: b.tracking ?? "no upstream",
              branchName: b.name,
            })),
            { placeHolder: "Select branch to push" },
          );
          if (!picked) return;
          branchName = picked.branchName;
        }

        // Check if branch has upstream
        const branches = await service.getBranches();
        const branch = branches.find((b) => b.name === branchName);
        const setUpstream = !branch?.tracking;

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Pushing '${branchName}'...`,
            },
            async () => {
              await service.push(branchName!, "origin", setUpstream);
            },
          );
          vscode.window.showInformationMessage(`Push '${branchName}' completed.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Push failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.PULL_BRANCH,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const currentBranch = await service.getCurrentBranch();
        let branchName = resolveBranchName(arg);
        if (!branchName) {
          branchName = currentBranch;
        }

        // If the branch is checked out in another worktree, pull from that worktree
        // to avoid "refusing to fetch into branch checked out at ..." errors.
        let pullService = service;
        if (branchName !== currentBranch) {
          const wtPath = repoManager.getWorktreePathForBranch(branchName);
          if (wtPath) {
            const wtService = repoManager.getServiceForPath(wtPath);
            if (wtService) {
              pullService = wtService;
            }
          }
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Pulling '${branchName}'...`,
            },
            async () => {
              await pullService.pull(branchName!);
            },
          );
          vscode.window.showInformationMessage(`Pull '${branchName}' completed.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Pull failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.OPEN_WORKTREE,
      async (arg?: unknown) => {
        let branchName = resolveBranchName(arg);
        if (!branchName) return;

        const wtPath = repoManager.getWorktreePathForBranch(branchName);
        if (wtPath) {
          vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.SELECT_WORKTREE_REPO,
      async (arg?: unknown) => {
        let branchName = resolveBranchName(arg);
        if (!branchName) return;

        const wtPath = repoManager.getWorktreePathForBranch(branchName);
        if (wtPath) {
          repoManager.setActiveRepo(wtPath);
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CREATE_WORKTREE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) return;

        if (await service.isBtRepo()) {
          const btConfirm = await vscode.window.showWarningMessage(
            `This repository uses baretree. "Create Worktree with baretree" is recommended instead. Continue anyway?`,
            { modal: true },
            "Continue",
          );
          if (btConfirm !== "Continue") return;
        }

        // For remote branches (e.g. "origin/feature"), create a local tracking branch
        const isRemote = branchName.includes("/");
        const localName = isRemote ? branchName.split("/").slice(1).join("/") : branchName;

        try {
          const wtPath = await vscode.window.showInputBox({
            prompt: `Worktree path for '${localName}'`,
            placeHolder: "/path/to/worktree",
            validateInput: (value) => {
              if (!value.trim()) return "Path is required";
              return null;
            },
          });
          if (!wtPath) return;

          if (isRemote) {
            await service.addWorktree(wtPath, localName, branchName);
          } else {
            await service.addWorktreeForExistingBranch(wtPath, branchName);
          }
          const action = await vscode.window.showInformationMessage(
            `Worktree created at '${wtPath}' for '${localName}'.`,
            "Open Worktree",
          );
          if (action === "Open Worktree") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
          }
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to create worktree: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CREATE_WORKTREE_WITH_BARETREE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let branchName = resolveBranchName(arg);
        if (!branchName) return;

        // For remote branches (e.g. "origin/feature"), create a local tracking branch
        const isRemote = branchName.includes("/");
        const localName = isRemote ? branchName.split("/").slice(1).join("/") : branchName;

        try {
          const result = isRemote
            ? await service.btAddWorktree(localName, branchName)
            : await service.btAddWorktreeForExistingBranch(branchName);
          onRefresh();
          const action = await vscode.window.showInformationMessage(
            `Worktree created for '${localName}'.${result ? `\n${result}` : ""}`,
            "Open Worktree",
          );
          if (action === "Open Worktree") {
            const wtPath = repoManager.getWorktreePathForBranch(localName);
            if (wtPath) {
              vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
            }
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to create worktree: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CREATE_WORKTREE_FROM_BASE_WITH_BARETREE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const baseBranchName = resolveBranchName(arg);
        if (!baseBranchName) return;

        const newBranchName = await vscode.window.showInputBox({
          prompt: `New branch name (base: ${baseBranchName})`,
          placeHolder: "feat/new-feature",
          validateInput: (value) => {
            if (!value.trim()) return "Branch name is required";
            if (/\s/.test(value)) return "Branch name cannot contain spaces";
            return null;
          },
        });
        if (!newBranchName) return;

        try {
          const result = await service.btAddWorktree(newBranchName.trim(), baseBranchName);
          onRefresh();
          const action = await vscode.window.showInformationMessage(
            `Worktree created for '${newBranchName.trim()}' (base: ${baseBranchName}).${result ? `\n${result}` : ""}`,
            "Open Worktree",
          );
          if (action === "Open Worktree") {
            const wtPath = repoManager.getWorktreePathForBranch(newBranchName.trim());
            if (wtPath) {
              vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
            }
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to create worktree: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CREATE_WORKTREE_FROM_BASE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const baseBranchName = resolveBranchName(arg);
        if (!baseBranchName) return;

        if (await service.isBtRepo()) {
          const btConfirm = await vscode.window.showWarningMessage(
            `This repository uses baretree. "Create Worktree from This Branch with baretree" is recommended instead. Continue anyway?`,
            { modal: true },
            "Continue",
          );
          if (btConfirm !== "Continue") return;
        }

        const newBranchName = await vscode.window.showInputBox({
          prompt: `New branch name (base: ${baseBranchName})`,
          placeHolder: "feat/new-feature",
          validateInput: (value) => {
            if (!value.trim()) return "Branch name is required";
            if (/\s/.test(value)) return "Branch name cannot contain spaces";
            return null;
          },
        });
        if (!newBranchName) return;

        const wtPath = await vscode.window.showInputBox({
          prompt: `Worktree path for '${newBranchName.trim()}'`,
          placeHolder: "/path/to/worktree",
          validateInput: (value) => {
            if (!value.trim()) return "Path is required";
            return null;
          },
        });
        if (!wtPath) return;

        try {
          await service.addWorktree(wtPath, newBranchName.trim(), baseBranchName);
          const action = await vscode.window.showInformationMessage(
            `Worktree created at '${wtPath}' for '${newBranchName.trim()}' (base: ${baseBranchName}).`,
            "Open Worktree",
          );
          if (action === "Open Worktree") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wtPath), { forceNewWindow: true });
          }
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to create worktree: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.COPY_BRANCH_NAME,
      async (arg?: unknown) => {
        let branchName = resolveBranchName(arg);
        if (!branchName) {
          const service = repoManager.getActiveService();
          if (!service) return;

          const branches = await service.getBranches();
          const picked = await vscode.window.showQuickPick(
            branches.map((b) => ({
              label: b.current ? `$(check) ${b.name}` : b.name,
              branchName: b.name,
            })),
            { placeHolder: "Select branch to copy name" },
          );
          if (!picked) return;
          branchName = picked.branchName;
        }

        await vscode.env.clipboard.writeText(branchName);
        vscode.window.showInformationMessage(`Copied '${branchName}' to clipboard.`);
      },
    ),
  );
}
