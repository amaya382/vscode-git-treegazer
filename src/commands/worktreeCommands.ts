import * as vscode from "vscode";
import * as path from "path";
import { RepoManager } from "../services/repoManager";
import { COMMANDS } from "../constants";
import type { BaretreeWorktreeEntry, PostCreateAction, SyncToRootEntry } from "../types";

export function registerWorktreeCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
  onRefresh: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.WORKTREE_ADD, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      const branchName = await vscode.window.showInputBox({
        prompt: "Create worktree with baretree",
        placeHolder: "Branch name (e.g. feat/my-feature)",
        validateInput: (v) => v.trim() ? null : "Branch name is required",
      });
      if (!branchName) return;

      try {
        await service.btAddWorktree(branchName.trim());
        vscode.window.showInformationMessage(`Worktree "${branchName.trim()}" created with baretree`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Create worktree failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_REMOVE, async (arg?: unknown) => {
      const service = repoManager.getActiveService();
      if (!service) return;

      let branch: string | undefined;
      if (arg && typeof arg === "object" && "worktree" in arg) {
        const wt = (arg as { worktree: BaretreeWorktreeEntry }).worktree;
        if (wt.isMain) {
          vscode.window.showWarningMessage("Cannot remove the default worktree.");
          return;
        }
        branch = wt.branch;
      }

      if (!branch) {
        vscode.window.showErrorMessage("No worktree specified.");
        return;
      }

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
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Remove worktree failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_ADD_TO_WORKSPACE, async (arg?: unknown) => {
      let worktreePath: string | undefined;

      if (arg && typeof arg === "object" && "worktree" in arg) {
        worktreePath = (arg as { worktree: BaretreeWorktreeEntry }).worktree.path;
      } else if (typeof arg === "string") {
        worktreePath = repoManager.getWorktreePathForBranch(arg);
      }

      if (!worktreePath) {
        vscode.window.showErrorMessage("Could not determine worktree path.");
        return;
      }

      const uri = vscode.Uri.file(worktreePath);
      const name = path.basename(worktreePath);

      const existing = vscode.workspace.workspaceFolders?.find(
        f => f.uri.fsPath === worktreePath,
      );
      if (existing) {
        vscode.window.showInformationMessage(`'${name}' is already in workspace.`);
        return;
      }

      vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0, 0,
        { uri, name },
      );
      vscode.window.showInformationMessage(`Added '${name}' to workspace folders.`);
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_POST_CREATE_ADD, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      const actionType = await vscode.window.showQuickPick(
        [
          { label: "symlink", description: "Symlink a shared file into new worktrees" },
          { label: "copy", description: "Copy a file into new worktrees" },
          { label: "command", description: "Run a shell command in new worktrees" },
        ],
        { placeHolder: "Select post-create action type" },
      );
      if (!actionType) return;

      const source = await vscode.window.showInputBox({
        prompt: actionType.label === "command"
          ? "Command to run in new worktrees"
          : "File path to share across worktrees",
        placeHolder: actionType.label === "command" ? "e.g. npm install" : "e.g. .env",
        validateInput: (v) => v.trim() ? null : "Value is required",
      });
      if (!source) return;

      let managed = true;
      if (actionType.label !== "command") {
        const managedChoice = await vscode.window.showQuickPick(
          [
            { label: "Managed", description: "Store in .shared/ directory (independent of any worktree)" },
            { label: "Non-managed", description: "Source from the default branch worktree" },
          ],
          { placeHolder: "File management mode" },
        );
        if (!managedChoice) return;
        managed = managedChoice.label === "Managed";
      }

      try {
        await service.btAddPostCreateAction(
          actionType.label as "symlink" | "copy" | "command",
          source.trim(),
          managed,
        );
        vscode.window.showInformationMessage(`Post-create action added: ${actionType.label} ${source.trim()}`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Add post-create action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_POST_CREATE_REMOVE, async (arg?: unknown) => {
      const service = repoManager.getActiveService();
      if (!service) return;

      let source: string | undefined;
      if (arg && typeof arg === "object" && "action" in arg) {
        source = (arg as { action: PostCreateAction }).action.source;
      }
      if (!source) return;

      const confirm = await vscode.window.showWarningMessage(
        `Remove post-create action '${source}'?`,
        { modal: true },
        "Remove",
      );
      if (confirm !== "Remove") return;

      try {
        await service.btRemovePostCreateAction(source);
        vscode.window.showInformationMessage(`Post-create action '${source}' removed`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Remove post-create action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_SYNC_TO_ROOT_ADD, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      const source = await vscode.window.showInputBox({
        prompt: "Source file path (relative to default worktree)",
        placeHolder: "e.g. CLAUDE.md",
        validateInput: (v) => v.trim() ? null : "Source path is required",
      });
      if (!source) return;

      const target = await vscode.window.showInputBox({
        prompt: "Target name at repository root (leave empty if same as source)",
        placeHolder: source.trim(),
      });

      try {
        const targetValue = target?.trim() || undefined;
        await service.btAddSyncToRoot(source.trim(), targetValue);
        vscode.window.showInformationMessage(`Sync-to-root entry added: ${source.trim()}`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Add sync-to-root failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand(COMMANDS.OPEN_TERMINAL_AT_WORKTREE, async (arg?: unknown) => {
      let worktreePath: string | undefined;

      if (arg && typeof arg === "object" && "worktree" in arg) {
        worktreePath = (arg as { worktree: BaretreeWorktreeEntry }).worktree.path;
      } else if (typeof arg === "string") {
        worktreePath = repoManager.getWorktreePathForBranch(arg);
      } else if (arg && typeof arg === "object" && "label" in arg) {
        const label = (arg as { label: unknown }).label;
        if (typeof label === "string") {
          worktreePath = repoManager.getWorktreePathForBranch(label);
        }
      }

      if (!worktreePath) {
        vscode.window.showErrorMessage("Could not determine worktree path.");
        return;
      }

      const terminal = vscode.window.createTerminal({
        cwd: worktreePath,
        name: path.basename(worktreePath),
      });
      terminal.show();
    }),

    vscode.commands.registerCommand(COMMANDS.WORKTREE_SYNC_TO_ROOT_REMOVE, async (arg?: unknown) => {
      const service = repoManager.getActiveService();
      if (!service) return;

      let source: string | undefined;
      if (arg && typeof arg === "object" && "entry" in arg) {
        source = (arg as { entry: SyncToRootEntry }).entry.source;
      }
      if (!source) return;

      const confirm = await vscode.window.showWarningMessage(
        `Remove sync-to-root entry '${source}'?`,
        { modal: true },
        "Remove",
      );
      if (confirm !== "Remove") return;

      try {
        await service.btRemoveSyncToRoot(source);
        vscode.window.showInformationMessage(`Sync-to-root entry '${source}' removed`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Remove sync-to-root failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
