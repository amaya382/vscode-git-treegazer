import simpleGit from "simple-git";
import type { ConflictResult } from "../types";

export class ConflictDetector {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async checkMergeConflict(targetBranch: string): Promise<ConflictResult> {
    const git = simpleGit(this.repoPath);

    try {
      // Try git merge-tree (Git 2.38+) — safe, doesn't touch working tree
      const currentHead = (await git.raw(["rev-parse", "HEAD"])).trim();
      const targetHead = (await git.raw(["rev-parse", targetBranch])).trim();
      const mergeBase = (
        await git.raw(["merge-base", currentHead, targetHead])
      ).trim();

      const result = await git.raw([
        "merge-tree",
        mergeBase,
        currentHead,
        targetHead,
      ]);

      // merge-tree (3-way) outputs conflict markers if conflicts exist
      const conflictedFiles: string[] = [];
      const lines = result.split("\n");
      for (const line of lines) {
        // Lines starting with "+" followed by "<<<<<<" indicate conflicts in traditional merge-tree
        if (line.includes("<<<<<<<") || line.includes("changed in both")) {
          // Extract filename from merge-tree output
          const fileMatch = line.match(
            /(?:our|their|base)\s+\d+\s+\w+\s+(.+)/,
          );
          if (fileMatch && !conflictedFiles.includes(fileMatch[1])) {
            conflictedFiles.push(fileMatch[1]);
          }
        }
      }

      // Also check for "changed in both" sections which indicate conflicts
      const bothChangedRegex = /changed in both\n\s+base\s+\d+\s+\w+\s+(.+)/g;
      let match;
      while ((match = bothChangedRegex.exec(result)) !== null) {
        if (!conflictedFiles.includes(match[1])) {
          conflictedFiles.push(match[1]);
        }
      }

      return {
        hasConflicts: conflictedFiles.length > 0,
        conflictedFiles,
      };
    } catch {
      // Fallback: use --no-commit merge and abort
      return this.checkMergeConflictFallback(targetBranch);
    }
  }

  private async checkMergeConflictFallback(
    targetBranch: string,
  ): Promise<ConflictResult> {
    const git = simpleGit(this.repoPath);

    try {
      await git.merge(["--no-commit", "--no-ff", targetBranch]);
      // No conflicts — abort the merge to restore state
      await git.merge(["--abort"]).catch(() => {
        // If abort fails, try reset
        return git.raw(["reset", "--merge"]);
      });
      return { hasConflicts: false, conflictedFiles: [] };
    } catch {
      // Merge failed = conflicts
      const conflictedFiles: string[] = [];
      try {
        const status = await git.status();
        conflictedFiles.push(...status.conflicted);
      } catch {
        // Can't get status
      }

      // Always abort
      await git.merge(["--abort"]).catch(() => {
        return git.raw(["reset", "--merge"]);
      });

      return {
        hasConflicts: true,
        conflictedFiles,
      };
    }
  }

  async checkStashApplyConflict(stashIndex: number): Promise<ConflictResult> {
    const git = simpleGit(this.repoPath);

    // Check if working tree is dirty
    const status = await git.status();
    const dirtyFiles = [
      ...status.modified,
      ...status.deleted,
      ...status.created,
    ];

    if (dirtyFiles.length === 0) {
      // Clean working tree — stash apply is unlikely to conflict
      return { hasConflicts: false, conflictedFiles: [] };
    }

    // Get list of files in the stash
    let stashFiles: string[];
    try {
      const stashDiff = await git.raw([
        "stash",
        "show",
        "--name-only",
        `stash@{${stashIndex}}`,
      ]);
      stashFiles = stashDiff.trim().split("\n").filter(Boolean);
    } catch {
      return { hasConflicts: false, conflictedFiles: [] };
    }

    // Check overlap between dirty files and stash files
    const conflictedFiles = stashFiles.filter((f) => dirtyFiles.includes(f));

    return {
      hasConflicts: conflictedFiles.length > 0,
      conflictedFiles,
    };
  }
}
