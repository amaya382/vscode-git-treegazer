import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import { COMMANDS } from "../constants";
import type { DiffFile } from "../types";

export function registerCommitCommands(
  context: vscode.ExtensionContext,
  repoManager: RepoManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.SHOW_COMMIT_DIFF,
      async (hash: string) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        try {
          const files = await service.getCommitDiff(hash);
          if (files.length === 0) {
            vscode.window.showInformationMessage("No changes in this commit.");
            return;
          }

          const items = files.map((f) => ({
            label: statusIcon(f.status) + " " + f.path,
            description: `+${f.additions} -${f.deletions}`,
            file: f,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `${hash.substring(0, 7)} — Select a file to view diff`,
            matchOnDescription: true,
          });

          if (selected) {
            await openCommitFileDiff(
              service.repoPath,
              hash,
              selected.file,
            );
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to get commit diff: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.COMPARE_COMMITS,
      async (hash1: string, hash2: string) => {
        const service = repoManager.getActiveService();
        if (!service) return;

        try {
          const files = await service.getDiffBetween(hash1, hash2);
          if (files.length === 0) {
            vscode.window.showInformationMessage(
              "No differences between these commits.",
            );
            return;
          }

          const items = files.map((f) => ({
            label: statusIcon(f.status) + " " + f.path,
            description: `+${f.additions} -${f.deletions}`,
            file: f,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `${hash1.substring(0, 7)}..${hash2.substring(0, 7)} — Select a file to view diff`,
            matchOnDescription: true,
          });

          if (selected) {
            await openTwoCommitDiff(
              hash1,
              hash2,
              selected.file,
            );
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to compare commits: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      COMMANDS.COPY_COMMIT_HASH,
      async (hash: string) => {
        await vscode.env.clipboard.writeText(hash);
        vscode.window.showInformationMessage(`Copied: ${hash}`);
      },
    ),
  );
}

async function openCommitFileDiff(
  _repoPath: string,
  hash: string,
  file: DiffFile,
): Promise<void> {
  const parentRef = `${hash}~1`;
  const leftUri = createGitUri(parentRef, file.oldPath || file.path);
  const rightUri = createGitUri(hash, file.path);
  const title = `${file.path} (${hash.substring(0, 7)})`;

  if (file.status === "added") {
    // New file — show only right side
    const doc = await vscode.workspace.openTextDocument(rightUri);
    await vscode.window.showTextDocument(doc);
  } else if (file.status === "deleted") {
    // Deleted file — show only left side
    const doc = await vscode.workspace.openTextDocument(leftUri);
    await vscode.window.showTextDocument(doc);
  } else {
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
  }
}

async function openTwoCommitDiff(
  hash1: string,
  hash2: string,
  file: DiffFile,
): Promise<void> {
  const leftUri = createGitUri(hash1, file.oldPath || file.path);
  const rightUri = createGitUri(hash2, file.path);
  const title = `${file.path} (${hash1.substring(0, 7)}..${hash2.substring(0, 7)})`;

  await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
}

function createGitUri(ref: string, filePath: string): vscode.Uri {
  // Use the built-in git extension's URI scheme
  return vscode.Uri.parse(`git-treegazer:${filePath}?${encodeURIComponent(JSON.stringify({ ref, path: filePath }))}`);
}

function statusIcon(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    case "renamed":
      return "R";
  }
}
