import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { LogPanel } from "../views/logPanel";
import { COMMANDS } from "../constants";

function resolveRef(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "label" in arg) {
    const label = (arg as { label: unknown }).label;
    if (typeof label === "string") return label;
  }
  return undefined;
}

export function registerRebaseCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
  logPanel: LogPanel,
  onRefresh: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.INTERACTIVE_REBASE,
      async (arg?: unknown) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        let onto = resolveRef(arg);

        if (!onto) {
          const branches = await service.getBranches();
          const nonCurrent = branches.filter((b) => !b.current);
          const picked = await vscode.window.showQuickPick(
            nonCurrent.map((b) => ({
              label: b.name,
              description: b.remote ? "remote" : "local",
            })),
            { placeHolder: "Select branch to interactively rebase onto" },
          );
          if (!picked) return;
          onto = picked.label;
        }

        await logPanel.enterRebaseModeFromCommand(onto);
      },
    ),

    vscode.commands.registerCommand(COMMANDS.REBASE_CONTINUE, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;
      try {
        const result = await service.rebaseContinue();
        vscode.window.showInformationMessage(result);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Rebase continue failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand(COMMANDS.REBASE_ABORT, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;
      const confirm = await vscode.window.showWarningMessage(
        "Abort the current rebase? All progress will be lost.",
        { modal: true },
        "Abort",
      );
      if (confirm !== "Abort") return;
      try {
        const result = await service.rebaseAbort();
        vscode.window.showInformationMessage(result);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Rebase abort failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand(COMMANDS.REBASE_SKIP, async () => {
      const service = repoManager.getActiveService();
      if (!service) return;
      try {
        const result = await service.rebaseSkip();
        vscode.window.showInformationMessage(result);
        onRefresh();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Rebase skip failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );
}
