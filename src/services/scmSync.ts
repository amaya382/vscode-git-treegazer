import * as vscode from "vscode";
import type { RepoManager } from "./repoManager";
import type { GitExtension, API } from "../types/git";

export class ScmSyncService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private gitApi: API | undefined;
  private isSyncing = false;

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo((service) => {
        if (service) {
          this.syncToScm(service.repoPath);
        }
      }),
    );
  }

  private async getGitApi(): Promise<API | undefined> {
    if (this.gitApi) return this.gitApi;
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) return undefined;
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
    const git = gitExtension.exports;
    if (!git.enabled) return undefined;
    this.gitApi = git.getAPI(1);
    return this.gitApi;
  }

  private async syncToScm(repoPath: string): Promise<void> {
    if (this.isSyncing) return;
    const config = vscode.workspace.getConfiguration("gitTreegazer");
    if (!config.get<boolean>("syncWithScm", true)) return;

    this.isSyncing = true;
    try {
      const api = await this.getGitApi();
      if (!api) return;

      // Ensure the repository is registered in the built-in git extension
      const repoUri = vscode.Uri.file(repoPath);
      if (!api.getRepository(repoUri)) {
        await api.openRepository(repoUri);
      }

      // Trigger SCM auto-follow by re-focusing an already-open file from this repo
      const openEditor = vscode.window.visibleTextEditors.find((editor) =>
        editor.document.uri.fsPath.startsWith(repoPath),
      );
      if (openEditor) {
        await vscode.window.showTextDocument(openEditor.document, {
          preview: true,
          preserveFocus: true,
          viewColumn: openEditor.viewColumn,
        });
      }
    } finally {
      this.isSyncing = false;
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
