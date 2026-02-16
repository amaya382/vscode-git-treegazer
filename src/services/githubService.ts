import * as vscode from "vscode";
import type { RepoManager } from "./repoManager";
import type { PullRequestInfo } from "../types";

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  html_url: string;
  merged_at: string | null;
  draft: boolean;
}

export class GitHubService implements vscode.Disposable {
  private cache = new Map<string, PullRequestInfo | null>();
  private pendingRequests = new Map<string, Promise<PullRequestInfo | null>>();
  private repoInfo: { owner: string; repo: string } | null | undefined;
  private cachedRepoPath: string | undefined;
  private token: string | null = null;
  private tokenInitialized = false;
  private rateLimitedUntil: number | null = null;
  private rateLimitNotifiedAt: number | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === "github") {
          this.tokenInitialized = false;
          this.token = null;
        }
      }),
      repoManager.onDidChangeActiveRepo(() => {
        this.cache.clear();
        this.repoInfo = undefined;
        this.cachedRepoPath = undefined;
      }),
    );
  }

  private notifyRateLimit(): void {
    const now = Date.now();
    const cooldown = 5 * 60_000; // 5 minutes
    if (this.rateLimitNotifiedAt && now - this.rateLimitNotifiedAt < cooldown) {
      return;
    }
    this.rateLimitNotifiedAt = now;
    vscode.window.showWarningMessage(
      "Git Treegazer: GitHub API rate limit exceeded. PR information may be incomplete. Sign in to GitHub for a higher limit.",
    );
  }

  private async ensureToken(): Promise<string | null> {
    if (this.tokenInitialized) return this.token;
    try {
      const session = await vscode.authentication.getSession("github", [], {
        createIfNone: false,
      });
      this.token = session?.accessToken ?? null;
    } catch {
      this.token = null;
    }
    this.tokenInitialized = true;
    return this.token;
  }

  private async ensureRepoInfo(): Promise<{ owner: string; repo: string } | null> {
    const currentPath = this.repoManager.getActiveRepoPath();
    if (this.repoInfo !== undefined && this.cachedRepoPath === currentPath) {
      return this.repoInfo;
    }
    this.cachedRepoPath = currentPath;
    const service = this.repoManager.getActiveService();
    if (!service) {
      this.repoInfo = null;
      return null;
    }
    try {
      const url = await service.getRemoteUrl();
      this.repoInfo = parseGitHubUrl(url);
    } catch {
      this.repoInfo = null;
    }
    return this.repoInfo;
  }

  async getBatchPRInfo(
    hashes: string[],
    patternResults?: Map<string, PullRequestInfo>,
    branchTipMap?: Map<string, string[]>,
  ): Promise<Record<string, PullRequestInfo | null>> {
    const result: Record<string, PullRequestInfo | null> = {};
    const repo = await this.ensureRepoInfo();
    if (!repo) {
      for (const hash of hashes) {
        result[hash] = patternResults?.get(hash) ?? null;
      }
      return result;
    }

    const token = await this.ensureToken();

    // Filter out already-cached hashes
    const uncached: string[] = [];
    for (const hash of hashes) {
      if (this.cache.has(hash)) {
        result[hash] = this.cache.get(hash)!;
      } else {
        uncached.push(hash);
      }
    }

    // Fetch uncached in batches of 5 concurrent requests
    const batchSize = 5;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const batch = uncached.slice(i, i + batchSize);
      const promises = batch.map((hash) =>
        this.getCommitPR(repo.owner, repo.repo, hash, token, patternResults?.get(hash), branchTipMap?.get(hash)),
      );
      const results = await Promise.all(promises);
      for (let j = 0; j < batch.length; j++) {
        result[batch[j]] = results[j];
      }
    }

    // Fill in missing URLs for pattern-only results using repo info
    for (const hash of hashes) {
      const info = result[hash];
      if (info && !info.url) {
        info.url = `https://github.com/${repo.owner}/${repo.repo}/pull/${info.number}`;
      }
    }

    return result;
  }

  private async getCommitPR(
    owner: string,
    repo: string,
    sha: string,
    token: string | null,
    patternInfo?: PullRequestInfo,
    branchNames?: string[],
  ): Promise<PullRequestInfo | null> {
    // Check cache
    if (this.cache.has(sha)) {
      return this.cache.get(sha)!;
    }

    // Deduplicate in-flight requests
    if (this.pendingRequests.has(sha)) {
      return this.pendingRequests.get(sha)!;
    }

    const promise = this.fetchCommitPR(owner, repo, sha, token, patternInfo, branchNames);
    this.pendingRequests.set(sha, promise);

    try {
      const info = await promise;
      this.cache.set(sha, info);
      return info;
    } finally {
      this.pendingRequests.delete(sha);
    }
  }

  private async fetchCommitPR(
    owner: string,
    repo: string,
    sha: string,
    token: string | null,
    patternInfo?: PullRequestInfo,
    branchNames?: string[],
  ): Promise<PullRequestInfo | null> {
    // Skip API calls if we've recently hit rate limit
    if (this.rateLimitedUntil && Date.now() < this.rateLimitedUntil) {
      return patternInfo ?? null;
    }

    const headers: Record<string, string> = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "git-treegazer",
    };
    if (token) {
      headers["Authorization"] = `token ${token}`;
    }

    // Try SHA-based lookup first
    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}/pulls`;
      const response = await fetch(url, { headers });

      if (response.ok) {
        const prs = (await response.json()) as GitHubPR[];
        if (prs.length > 0) {
          let pr = prs[0];
          if (patternInfo) {
            const matching = prs.find((p) => p.number === patternInfo.number);
            if (matching) pr = matching;
          }

          const state: PullRequestInfo["state"] = pr.merged_at
            ? "merged"
            : pr.state === "closed"
              ? "closed"
              : pr.draft
                ? "draft"
                : "open";

          return {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            state,
            source: "github-api",
            sourceBranch: patternInfo?.sourceBranch,
          };
        }
      } else if (response.status === 403 || response.status === 429) {
        console.warn("Git Treegazer: GitHub API rate limit exceeded, pausing for 60s");
        this.rateLimitedUntil = Date.now() + 60_000;
        this.notifyRateLimit();
        return patternInfo ?? null;
      }
    } catch {
      // Fall through to branch-based lookup
    }

    // Fallback: try branch-name-based PR lookup for branch tip commits
    if (branchNames && branchNames.length > 0) {
      const result = await this.fetchBranchPR(owner, repo, branchNames, headers);
      if (result) return result;
    }

    return patternInfo ?? null;
  }

  private async fetchBranchPR(
    owner: string,
    repo: string,
    branchNames: string[],
    headers: Record<string, string>,
  ): Promise<PullRequestInfo | null> {
    for (const branch of branchNames) {
      if (this.rateLimitedUntil && Date.now() < this.rateLimitedUntil) {
        return null;
      }
      try {
        const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(owner + ":" + branch)}&state=all&per_page=1`;
        const response = await fetch(url, { headers });
        if (response.status === 403 || response.status === 429) {
          this.rateLimitedUntil = Date.now() + 60_000;
          this.notifyRateLimit();
          return null;
        }
        if (!response.ok) continue;

        const prs = (await response.json()) as GitHubPR[];
        if (prs.length > 0) {
          const pr = prs[0];
          const state: PullRequestInfo["state"] = pr.merged_at
            ? "merged"
            : pr.state === "closed"
              ? "closed"
              : pr.draft
                ? "draft"
                : "open";
          return {
            number: pr.number,
            title: pr.title,
            url: pr.html_url,
            state,
            source: "github-api",
            sourceBranch: branch,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}
