import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { ConflictDetector } from "../services/conflictDetector";
import { COMMANDS } from "../constants";

export function registerStashCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
  onRefresh: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.STASH_CREATE, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      const mode = await vscode.window.showQuickPick(
        [
          { label: "All changes", description: "Stash all changes (staged + unstaged)", keepIndex: false },
          { label: "Unstaged only", description: "Stash only unstaged changes (keep staged)", keepIndex: true },
        ],
        { placeHolder: "What to stash?" },
      );
      if (!mode) return;

      const message = await vscode.window.showInputBox({
        prompt: "Stash message (optional)",
        placeHolder: "WIP: my changes",
      });

      // User pressed Escape
      if (message === undefined) return;

      try {
        await service.stash(message || undefined, mode.keepIndex);
        vscode.window.showInformationMessage("Changes stashed.");
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Stash failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      COMMANDS.STASH_APPLY,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        // Check for conflicts
        const detector = new ConflictDetector(service.repoPath);
        const result = await detector.checkStashApplyConflict(index);

        if (result.hasConflicts) {
          const files = result.conflictedFiles.join("\n  ");
          const choice = await vscode.window.showWarningMessage(
            `Stash apply may cause conflicts with working tree changes:\n  ${files}`,
            { modal: true },
            "Apply Anyway",
            "Cancel",
          );
          if (choice !== "Apply Anyway") return;
        }

        try {
          await service.stashApply(index);
          vscode.window.showInformationMessage(`Stash@{${index}} applied.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Stash apply failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_POP,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        // Check for conflicts
        const detector = new ConflictDetector(service.repoPath);
        const result = await detector.checkStashApplyConflict(index);

        if (result.hasConflicts) {
          const files = result.conflictedFiles.join("\n  ");
          const choice = await vscode.window.showWarningMessage(
            `Stash pop may cause conflicts with working tree changes:\n  ${files}`,
            { modal: true },
            "Pop Anyway",
            "Cancel",
          );
          if (choice !== "Pop Anyway") return;
        }

        try {
          await service.stashPop(index);
          vscode.window.showInformationMessage(`Stash@{${index}} popped.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Stash pop failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_DROP,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Drop stash@{${index}}? This cannot be undone.`,
          { modal: true },
          "Drop",
        );
        if (confirm !== "Drop") return;

        try {
          await service.stashDrop(index);
          vscode.window.showInformationMessage(`Stash@{${index}} dropped.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Stash drop failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_COPY_NAME,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        const name = `stash@{${index}}`;
        await vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied: ${name}`);
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_CREATE_BRANCH,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        const branchName = await vscode.window.showInputBox({
          prompt: "Branch name",
          placeHolder: "my-branch",
          validateInput: (value) => {
            if (!value.trim()) return "Branch name is required";
            if (/\s/.test(value)) return "Branch name cannot contain spaces";
            return undefined;
          },
        });
        if (!branchName) return;

        try {
          await service.stashBranch(branchName, index);
          vscode.window.showInformationMessage(
            `Branch '${branchName}' created from stash@{${index}}.`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Create branch from stash failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_RENAME,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        const stashes = await service.getStashList();
        const currentStash = stashes.find(s => s.index === index);
        const currentMessage = currentStash?.message ?? "";
        // Strip "On <branch>: " prefix that git prepends automatically
        const defaultValue = currentMessage.replace(/^On [^:]+: /, "");

        const newMessage = await vscode.window.showInputBox({
          prompt: `Rename stash@{${index}}`,
          value: defaultValue,
          validateInput: (value) => {
            if (!value.trim()) return "Message is required";
            return undefined;
          },
        });
        if (!newMessage) return;

        try {
          await service.stashRename(index, newMessage);
          vscode.window.showInformationMessage(`Stash@{${index}} renamed.`);
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Stash rename failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.STASH_SHOW_DIFF,
      async (index?: number) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        if (index === undefined) {
          index = await pickStash(service);
          if (index === undefined) return;
        }

        try {
          const files = await service.getStashDiff(index);
          if (files.length === 0) {
            vscode.window.showInformationMessage("No changes in this stash.");
            return;
          }

          const items = files.map((f) => ({
            label: `${f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"} ${f.path}`,
            description: `+${f.additions} -${f.deletions}`,
          }));

          await vscode.window.showQuickPick(items, {
            placeHolder: `stash@{${index}} — Files changed`,
          });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to show stash diff: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),
  );
}

async function pickStash(
  service: import("../services/gitService").GitService,
): Promise<number | undefined> {
  const stashes = await service.getStashList();
  if (stashes.length === 0) {
    vscode.window.showInformationMessage("No stashes found.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    stashes.map((s) => ({
      label: `stash@{${s.index}}: ${s.message}`,
      description: s.hash.substring(0, 7),
      index: s.index,
    })),
    { placeHolder: "Select a stash" },
  );

  return picked?.index;
}
