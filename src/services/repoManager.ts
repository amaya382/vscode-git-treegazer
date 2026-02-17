import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import simpleGit from "simple-git";
import { GitService } from "./gitService";
import type { RepoInfo } from "../types";

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  isBare: boolean;
}

export class RepoManager implements vscode.Disposable {
  private repos = new Map<string, GitService>();
  private activeRepoPath: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private worktreeGroups = new Map<string, string>();
  private worktreeBranches = new Map<string, string>();
  private btWorktreePathCache = new Map<string, string>(); // branchName → absolute path

  private readonly _onDidChangeRepos = new vscode.EventEmitter<void>();
  readonly onDidChangeRepos = this._onDidChangeRepos.event;

  private readonly _onDidChangeActiveRepo = new vscode.EventEmitter<GitService | undefined>();
  readonly onDidChangeActiveRepo = this._onDidChangeActiveRepo.event;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.detectRepos()),
    );
  }

  async initialize(): Promise<void> {
    await this.detectRepos();
  }

  private async listWorktrees(gitPath: string): Promise<WorktreeInfo[]> {
    try {
      const git = simpleGit(gitPath);
      const raw = await git.raw(["worktree", "list", "--porcelain"]);
      if (!raw.trim()) return [];

      const worktrees: WorktreeInfo[] = [];
      const blocks = raw.trim().split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let wtPath = "";
        let head = "";
        let branch: string | null = null;
        let isBare = false;

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            wtPath = line.substring("worktree ".length);
          } else if (line.startsWith("HEAD ")) {
            head = line.substring("HEAD ".length);
          } else if (line.startsWith("branch ")) {
            branch = line.substring("branch ".length);
          } else if (line === "bare") {
            isBare = true;
          }
        }

        if (wtPath) {
          worktrees.push({ path: wtPath, head, branch, isBare });
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }

  private async registerWorktrees(gitPath: string, newPaths: Set<string>, processedBareRoots: Set<string>): Promise<void> {
    const worktrees = await this.listWorktrees(gitPath);
    const nonBareWorktrees = worktrees.filter(wt => !wt.isBare);

    if (nonBareWorktrees.length <= 1) {
      // Single worktree or none — register as normal repo (no group metadata)
      if (nonBareWorktrees.length === 1) {
        const wt = nonBareWorktrees[0];
        if (!newPaths.has(wt.path)) {
          newPaths.add(wt.path);
          if (!this.repos.has(wt.path) && fs.existsSync(wt.path)) {
            this.repos.set(wt.path, new GitService(wt.path));
          }
        }
      }
      return;
    }

    // Multiple worktrees — find the bare root for group name
    const bareEntry = worktrees.find(wt => wt.isBare);
    const groupName = bareEntry
      ? path.basename(bareEntry.path)
      : path.basename(path.dirname(nonBareWorktrees[0].path));

    // Track processed bare roots to avoid duplicate worktree registration
    const bareRoot = bareEntry?.path || "";
    if (bareRoot && processedBareRoots.has(bareRoot)) return;
    if (bareRoot) processedBareRoots.add(bareRoot);

    for (const wt of nonBareWorktrees) {
      if (!newPaths.has(wt.path)) {
        newPaths.add(wt.path);
        if (!this.repos.has(wt.path) && fs.existsSync(wt.path)) {
          this.repos.set(wt.path, new GitService(wt.path));
        }
      }
      this.worktreeGroups.set(wt.path, groupName);
      if (wt.branch) {
        this.worktreeBranches.set(wt.path, wt.branch);
      }
    }
  }

  private async detectRepos(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      this.repos.clear();
      this.worktreeGroups.clear();
      this.worktreeBranches.clear();
      this.activeRepoPath = undefined;
      this._onDidChangeRepos.fire();
      this._onDidChangeActiveRepo.fire(undefined);
      return;
    }

    const newPaths = new Set<string>();
    const processedBareRoots = new Set<string>();

    // Clear worktree metadata (will be rebuilt)
    this.worktreeGroups.clear();
    this.worktreeBranches.clear();

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath;

      // Detect git repo at the workspace folder level
      try {
        const git = simpleGit(folderPath);
        const root = await git.revparse(["--show-toplevel"]);
        const repoPath = root.trim();

        // Check for worktrees before registering as a plain repo
        await this.registerWorktrees(repoPath, newPaths, processedBareRoots);

        // If registerWorktrees didn't add it (single worktree case handled there,
        // but also cover the case where it's already in newPaths)
        if (!newPaths.has(repoPath)) {
          newPaths.add(repoPath);
          if (!this.repos.has(repoPath)) {
            this.repos.set(repoPath, new GitService(repoPath));
          }
        }
      } catch {
        // Not a regular git repository — check if it's a bare repo
        try {
          const git = simpleGit(folderPath);
          const isBare = await git.raw(["rev-parse", "--is-bare-repository"]);
          if (isBare.trim() === "true") {
            await this.registerWorktrees(folderPath, newPaths, processedBareRoots);
          }
        } catch {
          // Not a git repository at all
        }
      }

      // Scan immediate subdirectories for nested git repos
      try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const subDir = path.join(folderPath, entry.name);
          try {
            const git = simpleGit(subDir);
            const root = await git.revparse(["--show-toplevel"]);
            const repoPath = root.trim();
            if (!newPaths.has(repoPath)) {
              await this.registerWorktrees(repoPath, newPaths, processedBareRoots);
              if (!newPaths.has(repoPath)) {
                newPaths.add(repoPath);
                if (!this.repos.has(repoPath)) {
                  this.repos.set(repoPath, new GitService(repoPath));
                }
              }
            }
          } catch {
            // Not a regular git repo — check bare
            try {
              const git = simpleGit(subDir);
              const isBare = await git.raw(["rev-parse", "--is-bare-repository"]);
              if (isBare.trim() === "true") {
                await this.registerWorktrees(subDir, newPaths, processedBareRoots);
              }
            } catch {
              // Not a git repository
            }
          }
        }
      } catch {
        // Cannot read directory
      }
    }

    // Remove repos no longer in workspace
    for (const repoPath of this.repos.keys()) {
      if (!newPaths.has(repoPath)) {
        this.repos.delete(repoPath);
      }
    }

    // Ensure active repo is valid
    if (!this.activeRepoPath || !this.repos.has(this.activeRepoPath)) {
      this.activeRepoPath = this.repos.keys().next().value;
    }

    vscode.commands.executeCommand("setContext", "gitTreegazer.multiRepo", this.repos.size > 1);
    this._onDidChangeRepos.fire();
    this._onDidChangeActiveRepo.fire(this.getActiveService());
  }

  getRepoList(): RepoInfo[] {
    return Array.from(this.repos.entries()).map(([repoPath]) => {
      const group = this.worktreeGroups.get(repoPath);
      const branch = this.worktreeBranches.get(repoPath);
      let name: string;
      if (group) {
        name = branch
          ? branch.replace(/^refs\/heads\//, "")
          : path.basename(repoPath);
      } else {
        name = path.basename(repoPath);
      }
      return { name, path: repoPath, group, branch };
    });
  }

  getRepoCount(): number {
    return this.repos.size;
  }

  getActiveRepoName(): string | undefined {
    if (!this.activeRepoPath) return undefined;
    const group = this.worktreeGroups.get(this.activeRepoPath);
    const branch = this.worktreeBranches.get(this.activeRepoPath);
    if (group && branch) {
      return `${group}/${branch.replace(/^refs\/heads\//, "")}`;
    }
    return path.basename(this.activeRepoPath);
  }

  getActiveService(): GitService | undefined {
    if (!this.activeRepoPath) return undefined;
    return this.repos.get(this.activeRepoPath);
  }

  getActiveRepoPath(): string | undefined {
    return this.activeRepoPath;
  }

  setActiveRepo(pathOrName: string): void {
    // Try exact path match first
    if (this.repos.has(pathOrName) && this.activeRepoPath !== pathOrName) {
      this.activeRepoPath = pathOrName;
      this._onDidChangeActiveRepo.fire(this.getActiveService());
      return;
    }
    // Try name match (for QuickPick selection)
    for (const repoPath of this.repos.keys()) {
      if (path.basename(repoPath) === pathOrName) {
        if (this.activeRepoPath !== repoPath) {
          this.activeRepoPath = repoPath;
          this._onDidChangeActiveRepo.fire(this.getActiveService());
        }
        return;
      }
    }
  }

  async refreshWorktreeMetadata(): Promise<void> {
    this.worktreeGroups.clear();
    this.worktreeBranches.clear();

    const processedBareRoots = new Set<string>();
    const existingPaths = new Set(this.repos.keys());

    for (const repoPath of existingPaths) {
      const worktrees = await this.listWorktrees(repoPath);
      const nonBareWorktrees = worktrees.filter(wt => !wt.isBare);

      if (nonBareWorktrees.length <= 1) continue;

      const bareEntry = worktrees.find(wt => wt.isBare);
      const groupName = bareEntry
        ? path.basename(bareEntry.path)
        : path.basename(path.dirname(nonBareWorktrees[0].path));

      const bareRoot = bareEntry?.path || "";
      if (bareRoot && processedBareRoots.has(bareRoot)) continue;
      if (bareRoot) processedBareRoots.add(bareRoot);

      for (const wt of nonBareWorktrees) {
        // Register new worktrees that appeared since last detectRepos
        if (!this.repos.has(wt.path) && fs.existsSync(wt.path)) {
          this.repos.set(wt.path, new GitService(wt.path));
        }
        this.worktreeGroups.set(wt.path, groupName);
        if (wt.branch) {
          this.worktreeBranches.set(wt.path, wt.branch);
        }
      }
    }
  }

  getWorktreeBranchNames(): Set<string> {
    const names = new Set<string>();
    for (const ref of this.worktreeBranches.values()) {
      names.add(ref.replace(/^refs\/heads\//, ""));
    }
    return names;
  }

  getWorktreeBranchInfo(): Map<string, { name: string; path: string }> {
    const info = new Map<string, { name: string; path: string }>();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const [wtPath, ref] of this.worktreeBranches.entries()) {
      const branchName = ref.replace(/^refs\/heads\//, "");
      const wtName = path.basename(wtPath);
      const relativePath = workspaceRoot
        ? path.relative(workspaceRoot, wtPath)
        : wtPath;
      info.set(branchName, { name: wtName, path: relativePath });
    }
    return info;
  }

  async getWorktreeBranchInfoExtended(): Promise<Map<string, { name: string; path: string; isManaged?: boolean; isDefault?: boolean }>> {
    const baseInfo = this.getWorktreeBranchInfo();
    const service = this.getActiveService();
    if (!service || !await service.isBtRepo()) {
      return baseInfo;
    }

    const [btWorktrees, defaultBranch] = await Promise.all([
      service.btListWorktrees(),
      service.btGetDefaultBranch(),
    ]);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const result = new Map<string, { name: string; path: string; isManaged?: boolean; isDefault?: boolean }>();

    // Start with base info from git worktree list
    for (const [branchName, info] of baseInfo) {
      result.set(branchName, { ...info });
    }

    // Merge/add bt list --json entries (authoritative for baretree-managed worktrees)
    this.btWorktreePathCache.clear();
    for (const wt of btWorktrees) {
      const isDefault = wt.isMain;
      const existing = result.get(wt.branch);
      const wtName = path.basename(wt.path);
      const relativePath = workspaceRoot
        ? path.relative(workspaceRoot, wt.path)
        : wt.path;
      result.set(wt.branch, {
        name: existing?.name ?? wtName,
        path: existing?.path ?? relativePath,
        isManaged: true,
        isDefault,
      });
      this.btWorktreePathCache.set(wt.branch, wt.path);
    }

    return result;
  }

  getWorktreePathForBranch(branchName: string): string | undefined {
    for (const [wtPath, ref] of this.worktreeBranches.entries()) {
      if (ref.replace(/^refs\/heads\//, "") === branchName) {
        return wtPath;
      }
    }
    // Fallback to bt list --json cache
    return this.btWorktreePathCache.get(branchName);
  }

  getServiceForPath(repoPath: string): GitService | undefined {
    return this.repos.get(repoPath);
  }

  dispose(): void {
    this._onDidChangeRepos.dispose();
    this._onDidChangeActiveRepo.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
