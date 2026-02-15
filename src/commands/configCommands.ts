import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { COMMANDS } from "../constants";
import type { GitConfigEntry, GitRemoteInfo } from "../types";

function resolveConfigEntry(arg: unknown): GitConfigEntry | undefined {
  if (
    arg &&
    typeof arg === "object" &&
    "key" in arg &&
    "value" in arg &&
    "scope" in arg
  ) {
    return arg as GitConfigEntry;
  }
  return undefined;
}

export function registerConfigCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
  onRefresh: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.CONFIG_EDIT_VALUE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const entry = resolveConfigEntry(arg);
        if (!entry) return;

        const newValue = await vscode.window.showInputBox({
          prompt: `Edit ${entry.key} (${entry.scope})`,
          value: entry.value,
          validateInput: (v) =>
            v.trim() === "" ? "Value cannot be empty" : null,
        });
        if (newValue === undefined) return;

        try {
          await service.setConfig(entry.key, newValue, entry.scope);
          vscode.window.showInformationMessage(
            `Updated ${entry.key} = ${newValue}`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to update config: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CONFIG_ADD_ENTRY,
      async () => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const scope = await vscode.window.showQuickPick(
          [
            { label: "local", description: "Repository-level config" },
            { label: "global", description: "User-level config" },
          ],
          { placeHolder: "Select config scope" },
        );
        if (!scope) return;

        const key = await vscode.window.showInputBox({
          prompt: "Config key (e.g. user.name, core.editor)",
          placeHolder: "section.key",
          validateInput: (v) => {
            if (!v.trim()) return "Key is required";
            if (!v.includes("."))
              return "Key must contain a dot (e.g. section.key)";
            return null;
          },
        });
        if (!key) return;

        const value = await vscode.window.showInputBox({
          prompt: `Value for ${key}`,
          validateInput: (v) =>
            v.trim() === "" ? "Value cannot be empty" : null,
        });
        if (value === undefined) return;

        try {
          await service.setConfig(
            key,
            value,
            scope.label as "local" | "global",
          );
          vscode.window.showInformationMessage(
            `Added ${key} = ${value} [${scope.label}]`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to add config: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CONFIG_REMOVE_ENTRY,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        const entry = resolveConfigEntry(arg);
        if (!entry) return;

        const confirm = await vscode.window.showWarningMessage(
          `Remove config '${entry.key}' from ${entry.scope}?`,
          { modal: true },
          "Remove",
        );
        if (confirm !== "Remove") return;

        try {
          await service.unsetConfig(entry.key, entry.scope);
          vscode.window.showInformationMessage(
            `Removed ${entry.key} [${entry.scope}]`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to remove config: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.CONFIG_COPY_VALUE,
      async (arg?: unknown) => {
        const entry = resolveConfigEntry(arg);
        if (!entry) return;
        await vscode.env.clipboard.writeText(entry.value);
        vscode.window.showInformationMessage(
          `Copied '${entry.value}' to clipboard.`,
        );
      },
    ),

    vscode.commands.registerCommand(COMMANDS.REMOTE_ADD, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;

      const name = await vscode.window.showInputBox({
        prompt: "Remote name",
        placeHolder: "upstream",
        validateInput: (v) => {
          if (!v.trim()) return "Remote name is required";
          if (/\s/.test(v)) return "Remote name cannot contain spaces";
          return null;
        },
      });
      if (!name) return;

      const url = await vscode.window.showInputBox({
        prompt: `URL for remote '${name}'`,
        placeHolder: "https://github.com/user/repo.git",
        validateInput: (v) => (!v.trim() ? "URL is required" : null),
      });
      if (!url) return;

      try {
        await service.addRemote(name, url);
        vscode.window.showInformationMessage(`Remote '${name}' added.`);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to add remote: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      COMMANDS.REMOTE_REMOVE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let remoteName: string | undefined;
        if (arg && typeof arg === "object" && "remoteName" in arg) {
          remoteName = (arg as { remoteName: string }).remoteName;
        }
        if (!remoteName) return;

        const confirm = await vscode.window.showWarningMessage(
          `Remove remote '${remoteName}'? This will remove all its tracking branches.`,
          { modal: true },
          "Remove",
        );
        if (confirm !== "Remove") return;

        try {
          await service.removeRemote(remoteName);
          vscode.window.showInformationMessage(
            `Remote '${remoteName}' removed.`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to remove remote: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.REMOTE_RENAME,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let remoteName: string | undefined;
        if (arg && typeof arg === "object" && "remoteName" in arg) {
          remoteName = (arg as { remoteName: string }).remoteName;
        }
        if (!remoteName) return;

        const newName = await vscode.window.showInputBox({
          prompt: `Rename remote '${remoteName}' to`,
          value: remoteName,
          validateInput: (v) => {
            if (!v.trim()) return "Remote name is required";
            if (/\s/.test(v)) return "Remote name cannot contain spaces";
            if (v === remoteName) return "New name must be different";
            return null;
          },
        });
        if (!newName) return;

        try {
          await service.renameRemote(remoteName, newName);
          vscode.window.showInformationMessage(
            `Remote '${remoteName}' renamed to '${newName}'.`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to rename remote: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.REMOTE_SET_URL,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let remoteName: string | undefined;
        let currentUrl: string | undefined;
        if (arg && typeof arg === "object" && "remoteName" in arg) {
          remoteName = (arg as { remoteName: string }).remoteName;
        }
        if (arg && typeof arg === "object" && "remote" in arg) {
          const remote = (arg as { remote: GitRemoteInfo }).remote;
          currentUrl = remote.fetchUrl;
        }
        if (!remoteName) return;

        const newUrl = await vscode.window.showInputBox({
          prompt: `New URL for remote '${remoteName}'`,
          value: currentUrl,
          validateInput: (v) => (!v.trim() ? "URL is required" : null),
        });
        if (!newUrl) return;

        try {
          await service.setRemoteUrl(remoteName, newUrl);
          vscode.window.showInformationMessage(
            `Remote '${remoteName}' URL updated.`,
          );
          onRefresh();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to set remote URL: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),
  );
}
