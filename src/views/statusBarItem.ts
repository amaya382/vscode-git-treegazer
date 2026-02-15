import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { COMMANDS } from "../constants";

export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly repoManager: RepoManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      95,
    );
    this.statusBarItem.command = COMMANDS.SHOW_LOG;
    this.statusBarItem.tooltip = "Show Git Treegazer Log";

    this.disposables.push(
      this.statusBarItem,
      repoManager.onDidChangeActiveRepo(() => this.update()),
    );

    this.update();
  }

  async update(): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (!service) {
      this.statusBarItem.hide();
      return;
    }

    try {
      const branch = await service.getCurrentBranch();
      this.statusBarItem.text = "$(telescope)";
      this.statusBarItem.tooltip = `Git Treegazer: ${branch} (click to show log)`;
      this.statusBarItem.show();
    } catch {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
