import simpleGit, { SimpleGit } from "simple-git";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import type { GitCommit, GitBranch, GitStash, DiffFile, LogFilter, MergedCommitSummary, PullRequestInfo, GitConfigEntry, GitRemoteInfo, RebaseTodoEntry, RebaseState, RebaseContextCommit, BaretreeWorktreeEntry, PostCreateAction, PostCreateActionType, SyncToRootEntry, WorktreeRebaseState } from "../types";

const LOG_FORMAT = {
  hash: "%H",
  abbreviatedHash: "%h",
  message: "%s",
  author: "%an",
  authorEmail: "%ae",
  date: "%aI",
  parentHashes: "%P",
  refs: "%D",
};

const LOG_SEPARATOR = "---GIT_TREEGAZER_SEP---";
const FIELD_SEPARATOR = "---GIT_TREEGAZER_FIELD---";

export class GitService {
  private git: SimpleGit;
  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  async getLog(count: number, skip: number, filter?: LogFilter): Promise<{ commits: GitCommit[]; totalCount: number }> {
    const format = Object.values(LOG_FORMAT).join(FIELD_SEPARATOR);
    const logArgs: string[] = [
      "log",
      `--format=${format}${LOG_SEPARATOR}`,
      `--max-count=${count}`,
      `--skip=${skip}`,
    ];

    const countArgs: string[] = ["rev-list", "--count"];

    if (filter?.mergesOnly) {
      logArgs.push("--merges");
      countArgs.push("--merges");
    }

    // Message filter
    if (filter?.messageMatch) {
      logArgs.push(`--grep=${filter.messageMatch}`, "--fixed-strings", "--regexp-ignore-case");
      countArgs.push(`--grep=${filter.messageMatch}`, "--fixed-strings", "--regexp-ignore-case");
    }
    if (filter?.messageExclude) {
      logArgs.push(`--grep=${filter.messageExclude}`, "--invert-grep", "--fixed-strings", "--regexp-ignore-case");
      countArgs.push(`--grep=${filter.messageExclude}`, "--invert-grep", "--fixed-strings", "--regexp-ignore-case");
    }

    // Author filter (positive: exact name match at git level)
    // --author matches against "Name <email>", so use ^name <  to anchor the name portion
    if (filter?.authorMatch) {
      logArgs.push(`--author=^${filter.authorMatch} <`, "--regexp-ignore-case");
      countArgs.push(`--author=^${filter.authorMatch} <`, "--regexp-ignore-case");
    }

    // Author negation: handled via post-filter below
    const needsAuthorPostFilter = !!filter?.authorExclude;
    if (needsAuthorPostFilter) {
      // Over-fetch to account for post-filtering
      logArgs[3] = `--max-count=${count * 3}`;
    }

    // Branch filter / ref determination
    const needsBranchPostFilter = !!filter?.branchExclude;
    if (filter?.containingCommit && filter?.withinRef) {
      logArgs.push(`${filter.containingCommit}^..${filter.withinRef}`, "--ancestry-path");
      countArgs.push(`${filter.containingCommit}^..${filter.withinRef}`, "--ancestry-path");
    } else if (filter?.branchMatch) {
      // Positive: show only commits reachable from matching refs (ancestors included)
      const branches = await this.getMatchingBranches(filter.branchMatch, false);
      if (branches.length === 0) {
        return { commits: [], totalCount: 0 };
      }
      logArgs.splice(1, 0, ...branches);
      countArgs.push(...branches);
    } else {
      // For branchExclude, we still fetch --all and post-filter
      // --exclude must come before --all
      logArgs.splice(1, 0, "--exclude=refs/stash", "--exclude=worktrees/*", "--all");
      countArgs.push("--exclude=refs/stash", "--exclude=worktrees/*", "--all");
      if (needsBranchPostFilter) {
        // Over-fetch to account for post-filtering
        logArgs[3] = `--max-count=${Math.max(count * 3, parseInt(logArgs[3].split("=")[1], 10))}`;
      }
    }

    const raw = await this.git.raw(logArgs);

    let commits = raw
      .split(LOG_SEPARATOR)
      .filter((s) => s.trim())
      .map((entry): GitCommit => {
        const fields = entry.trim().split(FIELD_SEPARATOR);
        const parentHashes = fields[6] ? fields[6].split(" ").filter(Boolean) : [];
        const refs = fields[7]
          ? fields[7].split(",").map((r) => r.trim()).filter(Boolean)
          : [];
        return {
          hash: fields[0],
          abbreviatedHash: fields[1],
          message: fields[2],
          author: fields[3],
          authorEmail: fields[4],
          date: fields[5],
          parentHashes,
          refs,
          isMergeCommit: parentHashes.length > 1,
          prInfo: GitService.detectPrInfo(fields[2]),
        };
      });

    // Post-filter: branch exclusion
    // Remove commits whose only path to a tip goes through an excluded ref,
    // i.e. remove commits that have a matching ref, then recursively remove
    // commits whose children have all been removed.
    if (needsBranchPostFilter) {
      commits = this.applyBranchExcludeFilter(commits, filter!.branchExclude!);
    }

    // Post-filter: author negation
    if (needsAuthorPostFilter) {
      const excludeLower = filter!.authorExclude!.toLowerCase();
      commits = commits.filter(c => c.author.toLowerCase() !== excludeLower);
    }

    const needsPostFilter = needsBranchPostFilter || needsAuthorPostFilter;

    // Keep full post-filtered list for BFS traversal before slicing
    const fullFilteredCommits = needsPostFilter ? [...commits] : commits;

    if (needsPostFilter) {
      commits = commits.slice(0, count);
    }

    // Total count
    let totalCount: number;
    if (needsPostFilter) {
      // For post-filtered results, we cannot get an exact count efficiently.
      // Use an estimate: if we got fewer than the over-fetched amount,
      // the current filtered length is accurate. Otherwise mark as approximate.
      const totalRaw = await this.git.raw(countArgs);
      const rawTotal = parseInt(totalRaw.trim(), 10) || 0;
      // Rough estimate — the ratio of kept vs fetched commits
      const fetchedCount = commits.length < count ? commits.length : count;
      if (fetchedCount === 0) {
        totalCount = 0;
      } else {
        // Just report the raw total as an upper bound for now;
        // the user sees "Load more (N/M)" which works fine.
        totalCount = rawTotal;
      }
    } else {
      const totalRaw = await this.git.raw(countArgs);
      totalCount = parseInt(totalRaw.trim(), 10) || 0;
    }

    // Resolve filteredParentHashes for commits whose direct parents are
    // not in the final commit list (due to post-filtering or merge-only).
    // Also needed when git-level filters (authorMatch, messageMatch, messageExclude)
    // cause gaps between commits.
    const hasGitLevelFilter = !!(filter?.authorMatch || filter?.messageMatch || filter?.messageExclude);
    if (commits.length > 0) {
      if (filter?.mergesOnly) {
        // Merge-only: use git CLI to find nearest merge ancestor
        const commitHashSet = new Set(commits.map(c => c.hash));
        await this.resolveFilteredParents(commits, commitHashSet, ["--merges"]);
      } else if (needsPostFilter) {
        // Post-filtered (branch exclude, author exclude): use in-memory BFS
        this.resolveFilteredParentsInMemory(commits, fullFilteredCommits);
      }

      if (hasGitLevelFilter) {
        // Git-level filters (--author, --grep) create gaps between commits.
        // Use git CLI to find the nearest ancestor that matches the same filter.
        const commitHashSet = new Set(commits.map(c => c.hash));
        const filterArgs: string[] = [];
        if (filter?.authorMatch) {
          filterArgs.push(`--author=^${filter.authorMatch} <`, "--regexp-ignore-case");
        }
        if (filter?.messageMatch) {
          filterArgs.push(`--grep=${filter.messageMatch}`, "--fixed-strings", "--regexp-ignore-case");
        }
        if (filter?.messageExclude) {
          filterArgs.push(`--grep=${filter.messageExclude}`, "--invert-grep", "--fixed-strings", "--regexp-ignore-case");
        }
        if (filter?.mergesOnly) {
          filterArgs.push("--merges");
        }
        await this.resolveFilteredParents(commits, commitHashSet, filterArgs);
      }
    }

    return { commits, totalCount };
  }

  /**
   * Remove commits that are "exclusively" reachable through refs matching the
   * exclude pattern.
   *
   * Algorithm:
   * 1. Mark commits that carry a matching ref as "excluded roots".
   * 2. Build a child→parent graph from the commit list.
   * 3. Walk from newest (index 0) to oldest. A commit is removed if:
   *    - it is an excluded root, OR
   *    - every child it has in the list has been removed.
   *
   * NOTE: filteredParentHashes bridging is NOT done here — it is handled by
   * resolveFilteredParentsInMemory() after the final slice, so that all
   * referenced hashes are guaranteed to exist in the final commit array.
   */
  private applyBranchExcludeFilter(commits: GitCommit[], pattern: string): GitCommit[] {
    if (commits.length === 0) return commits;

    const lowerPattern = pattern.toLowerCase();

    const refMatchesPattern = (ref: string): boolean => {
      const cleaned = ref
        .replace(/^HEAD -> /, "")
        .replace(/^tag: /, "")
        .trim();
      return cleaned.toLowerCase().includes(lowerPattern);
    };

    const excludedRoots = new Set<string>();
    for (const c of commits) {
      if (c.refs.length > 0 && c.refs.some(refMatchesPattern)) {
        excludedRoots.add(c.hash);
      }
    }

    if (excludedRoots.size === 0) return commits;

    // Index commits by hash for quick lookup
    const commitByHash = new Map<string, GitCommit>();
    for (const c of commits) commitByHash.set(c.hash, c);

    // Build parent→children mapping within the commit list
    const childrenOf = new Map<string, Set<string>>();
    for (const c of commits) {
      for (const ph of c.parentHashes) {
        if (commitByHash.has(ph)) {
          if (!childrenOf.has(ph)) childrenOf.set(ph, new Set());
          childrenOf.get(ph)!.add(c.hash);
        }
      }
    }

    // Determine which commits to remove
    const removed = new Set<string>();
    for (const c of commits) {
      const children = childrenOf.get(c.hash);
      const isExcludedRoot = excludedRoots.has(c.hash);

      if (isExcludedRoot) {
        removed.add(c.hash);
      } else if (children && children.size > 0) {
        const allChildrenRemoved = [...children].every(ch => removed.has(ch));
        if (allChildrenRemoved) {
          removed.add(c.hash);
        }
      }
    }

    return commits.filter(c => !removed.has(c.hash));
  }

  private async getMatchingBranches(pattern: string, exclude: boolean): Promise<string[]> {
    const raw = await this.git.raw(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/", "refs/tags/"]);
    if (!raw.trim()) return [];
    const allRefs = raw.trim().split("\n").filter(Boolean).filter(r => !r.includes("/HEAD"));
    const lowerPattern = pattern.toLowerCase();
    const toShortName = (ref: string) =>
      ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "").replace(/^refs\/tags\//, "");
    return allRefs.filter(r => {
      const matches = toShortName(r).toLowerCase().includes(lowerPattern);
      return exclude ? !matches : matches;
    });
  }

  private async resolveFilteredParents(commits: GitCommit[], commitHashSet: Set<string>, extraArgs: string[]): Promise<void> {
    // For each commit, check if its parentHashes are in the filtered set.
    // If not, find the nearest matching ancestor that IS in the set.
    for (const commit of commits) {
      // Skip if already resolved (e.g. by in-memory BFS for post-filters)
      if (commit.filteredParentHashes) continue;

      const filteredParents: string[] = [];
      let needsFiltered = false;

      for (const parentHash of commit.parentHashes) {
        if (commitHashSet.has(parentHash)) {
          filteredParents.push(parentHash);
        } else {
          needsFiltered = true;
          // Find nearest ancestor matching the filter criteria
          try {
            const nearest = await this.git.raw([
              "log", ...extraArgs, "--max-count=1", "--format=%H", parentHash,
            ]);
            const hash = nearest.trim();
            if (hash && commitHashSet.has(hash)) {
              filteredParents.push(hash);
            }
          } catch {
            // Parent may not be reachable; skip
          }
        }
      }

      if (needsFiltered && filteredParents.length > 0) {
        // Deduplicate
        commit.filteredParentHashes = [...new Set(filteredParents)];
      }
    }
  }

  /**
   * For each commit whose parentHashes reference commits NOT in the given set,
   * walk the original full commit list to find the nearest ancestor that IS in
   * the set, and record the result in filteredParentHashes.
   * This is the in-memory equivalent of resolveFilteredParents (which uses git CLI).
   *
   * @param commits     The final filtered & sliced commit array
   * @param fullCommits The full commit array before slicing (used for BFS traversal)
   */
  private resolveFilteredParentsInMemory(commits: GitCommit[], fullCommits: GitCommit[]): void {
    const commitHashSet = new Set(commits.map(c => c.hash));

    // Build a hash→commit map from the full list for BFS traversal
    const fullCommitByHash = new Map<string, GitCommit>();
    for (const c of fullCommits) fullCommitByHash.set(c.hash, c);

    for (const commit of commits) {
      const filteredParents: string[] = [];
      let needsFiltered = false;

      for (const parentHash of commit.parentHashes) {
        if (commitHashSet.has(parentHash)) {
          filteredParents.push(parentHash);
        } else {
          needsFiltered = true;
          // BFS through the full commit list to find nearest ancestor in commitHashSet
          const visited = new Set<string>();
          const queue = [parentHash];
          visited.add(parentHash);

          while (queue.length > 0) {
            const hash = queue.shift()!;
            const ancestor = fullCommitByHash.get(hash);
            if (!ancestor) continue;

            for (const ph of ancestor.parentHashes) {
              if (visited.has(ph)) continue;
              visited.add(ph);

              if (commitHashSet.has(ph)) {
                filteredParents.push(ph);
              } else if (fullCommitByHash.has(ph)) {
                queue.push(ph);
              }
            }
          }
        }
      }

      if (needsFiltered && filteredParents.length > 0) {
        commit.filteredParentHashes = [...new Set(filteredParents)];
      }
    }
  }

  async getCommitInfo(hash: string): Promise<(GitCommit & { committer: string; committerEmail: string }) | null> {
    const detailFormat = [
      ...Object.values(LOG_FORMAT),
      "%cn", // committer name
      "%ce", // committer email
    ].join(FIELD_SEPARATOR);
    const raw = await this.git.raw([
      "log",
      "-1",
      `--format=${detailFormat}`,
      hash,
    ]);
    if (!raw.trim()) return null;
    const fields = raw.trim().split(FIELD_SEPARATOR);
    const parentHashes = fields[6] ? fields[6].split(" ").filter(Boolean) : [];
    const refs = fields[7] ? fields[7].split(",").map((r) => r.trim()).filter(Boolean) : [];
    return {
      hash: fields[0],
      abbreviatedHash: fields[1],
      message: fields[2],
      author: fields[3],
      authorEmail: fields[4],
      date: fields[5],
      parentHashes,
      refs,
      isMergeCommit: parentHashes.length > 1,
      prInfo: GitService.detectPrInfo(fields[2]),
      committer: fields[8] ?? "",
      committerEmail: fields[9] ?? "",
    };
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.git.raw(["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.trim();
  }

  async getCommitDiff(hash: string): Promise<DiffFile[]> {
    // Check if this is a merge commit
    const parentRaw = await this.git.raw(["rev-parse", `${hash}^@`]).catch(() => "");
    const parents = parentRaw.trim().split("\n").filter(Boolean);

    if (parents.length > 1) {
      // Merge commit: diff against the first parent to show all changes introduced by the merge
      const raw = await this.git.raw([
        "diff",
        "--numstat",
        "-M",
        `${parents[0]}...${hash}`,
      ]);
      return this.parseDiffStat(raw);
    }

    const raw = await this.git.raw([
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--numstat",
      "-M",
      hash,
    ]);
    return this.parseDiffStat(raw);
  }

  async getMergedCommits(hash: string): Promise<MergedCommitSummary[]> {
    // Get commits included in this merge (commits reachable from hash
    // but not from the first parent, excluding the merge commit itself)
    try {
      const parentRaw = await this.git.raw(["rev-parse", `${hash}^@`]).catch(() => "");
      const parents = parentRaw.trim().split("\n").filter(Boolean);
      if (parents.length < 2) return [];

      const format = ["%H", "%h", "%s", "%an", "%aI"].join(FIELD_SEPARATOR);
      const raw = await this.git.raw([
        "log",
        `--format=${format}${LOG_SEPARATOR}`,
        `${parents[0]}..${hash}`,
        "--no-merges",
      ]);

      if (!raw.trim()) return [];

      return raw
        .split(LOG_SEPARATOR)
        .filter((s) => s.trim())
        .map((entry) => {
          const fields = entry.trim().split(FIELD_SEPARATOR);
          return {
            hash: fields[0],
            abbreviatedHash: fields[1],
            message: fields[2],
            author: fields[3],
            date: fields[4],
          };
        });
    } catch {
      return [];
    }
  }

  async getDiffBetween(hash1: string, hash2: string): Promise<DiffFile[]> {
    const raw = await this.git.raw(["diff", "--numstat", "-M", hash1, hash2]);
    return this.parseDiffStat(raw);
  }

  async getFileContentAtCommit(hash: string, filePath: string): Promise<string> {
    try {
      return await this.git.show([`${hash}:${filePath}`]);
    } catch {
      return "";
    }
  }

  async getBranches(): Promise<GitBranch[]> {
    const result = await this.git.branch(["-a", "-v", "--no-color"]);
    const branches: GitBranch[] = [];

    for (const [name, data] of Object.entries(result.branches)) {
      const isRemote = name.startsWith("remotes/");
      const cleanName = isRemote
        ? name.replace(/^remotes\//, "")
        : name;

      // Skip HEAD pointer
      if (cleanName.includes("HEAD")) continue;

      const branch: GitBranch = {
        name: cleanName,
        current: data.current,
        remote: isRemote,
        commitHash: data.commit,
      };

      // Get tracking info for local branches
      if (!isRemote) {
        try {
          const tracking = await this.git.raw([
            "for-each-ref",
            `--format=%(upstream:short)`,
            `refs/heads/${cleanName}`,
          ]);
          const trackingBranch = tracking.trim();
          if (trackingBranch) {
            branch.tracking = trackingBranch;
            try {
              const aheadBehind = await this.git.raw([
                "rev-list",
                "--left-right",
                "--count",
                `${cleanName}...${trackingBranch}`,
              ]);
              const [ahead, behind] = aheadBehind.trim().split("\t").map(Number);
              branch.ahead = ahead;
              branch.behind = behind;
            } catch {
              // Tracking branch may not exist on remote
            }
          }
        } catch {
          // No tracking branch
        }
      }

      branches.push(branch);
    }

    return branches;
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = startPoint ? [name, startPoint] : [name];
    await this.git.branch(args);
  }

  async addWorktree(wtPath: string, branch: string, startPoint?: string): Promise<void> {
    const args = ["worktree", "add", wtPath, "-b", branch];
    if (startPoint) args.push(startPoint);
    await this.git.raw(args);
  }

  async addWorktreeForExistingBranch(wtPath: string, branch: string): Promise<void> {
    await this.git.raw(["worktree", "add", wtPath, branch]);
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.git.branch(force ? ["-D", name] : ["-d", name]);
  }

  async deleteRemoteBranch(remoteBranchName: string): Promise<void> {
    // remoteBranchName is like "origin/feat/auth"
    const slashIndex = remoteBranchName.indexOf("/");
    const remote = remoteBranchName.substring(0, slashIndex);
    const branch = remoteBranchName.substring(slashIndex + 1);
    await this.git.push(remote, branch, ["--delete"]);
  }

  async checkout(branchOrHash: string): Promise<void> {
    await this.git.checkout(branchOrHash);
  }

  async merge(branch: string): Promise<string> {
    const result = await this.git.merge([branch]);
    return result.result || "Merge completed";
  }

  async fetch(): Promise<void> {
    await this.git.fetch(["--all", "--prune"]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git.branch(["-m", oldName, newName]);
  }

  async push(branch: string, remote = "origin", setUpstream = false): Promise<string> {
    const args = setUpstream ? ["push", "-u", remote, branch] : ["push", remote, branch];
    const result = await this.git.raw(args);
    return result.trim() || "Push completed";
  }

  async pull(branch: string, remote = "origin"): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    if (branch === currentBranch) {
      // Current branch: normal pull (fetch + merge into working tree)
      const result = await this.git.raw(["pull", remote, branch]);
      return result.trim() || "Pull completed";
    }
    // Non-current branch: fast-forward update via fetch refspec
    const result = await this.git.raw(["fetch", remote, `${branch}:${branch}`]);
    return result.trim() || "Pull completed";
  }

  async getStashList(): Promise<GitStash[]> {
    const raw = await this.git.raw([
      "stash",
      "list",
      `--format=%H${FIELD_SEPARATOR}%gd${FIELD_SEPARATOR}%gs${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%P`,
    ]);
    if (!raw.trim()) return [];

    return raw
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, ref, message, date, parentHashes] = line.split(FIELD_SEPARATOR);
        const indexMatch = ref.match(/\{(\d+)\}/);
        return {
          hash,
          index: indexMatch ? parseInt(indexMatch[1], 10) : 0,
          message,
          date,
          parentHash: parentHashes ? parentHashes.split(" ")[0] : "",
        };
      });
  }

  async stash(message?: string, keepIndex?: boolean): Promise<void> {
    const args = ["push"];
    if (keepIndex) args.push("--keep-index");
    if (message) args.push("-m", message);
    await this.git.stash(args);
  }

  async stashApply(index = 0): Promise<void> {
    await this.git.stash(["apply", `stash@{${index}}`]);
  }

  async stashPop(index = 0): Promise<void> {
    await this.git.stash(["pop", `stash@{${index}}`]);
  }

  async stashDrop(index = 0): Promise<void> {
    await this.git.stash(["drop", `stash@{${index}}`]);
  }

  async stashRename(index: number, newMessage: string): Promise<void> {
    // Git has no native stash rename. Implemented as:
    // 1. Get the commit hash of the stash
    // 2. Drop the old stash entry
    // 3. Re-store it with the new message
    const stashes = await this.getStashList();
    const stash = stashes.find(s => s.index === index);
    if (!stash) throw new Error(`stash@{${index}} not found`);
    const hash = stash.hash;
    await this.git.stash(["drop", `stash@{${index}}`]);
    await this.git.raw(["stash", "store", "-m", newMessage, hash]);
  }

  async stashBranch(branchName: string, index = 0): Promise<void> {
    await this.git.stash(["branch", branchName, `stash@{${index}}`]);
  }

  async getMergedBranches(targetBranch: string): Promise<Set<string>> {
    try {
      const raw = await this.git.raw(["branch", "--merged", targetBranch, "--no-color"]);
      if (!raw.trim()) return new Set();
      const branches = raw.trim().split("\n")
        .map(b => b.trim().replace(/^[*+] /, ""))
        .filter(Boolean);
      return new Set(branches);
    } catch {
      return new Set();
    }
  }

  async getBranchesContaining(hash: string): Promise<string[]> {
    const raw = await this.git.raw(["branch", "-a", "--contains", hash, "--no-color"]);
    if (!raw.trim()) return [];
    return raw.trim().split("\n")
      .map(b => b.trim().replace(/^[*+] /, ""))
      .filter(Boolean)
      .filter(b => !b.includes("HEAD"));
  }

  async getTagsContaining(hash: string): Promise<string[]> {
    try {
      const raw = await this.git.raw(["tag", "--contains", hash]);
      if (!raw.trim()) return [];
      return raw.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async createTag(name: string, hash: string): Promise<void> {
    await this.git.raw(["tag", name, hash]);
  }

  async deleteTag(name: string): Promise<void> {
    await this.git.raw(["tag", "-d", name]);
  }

  async pushTag(name: string, remote = "origin"): Promise<void> {
    await this.git.raw(["push", remote, `refs/tags/${name}`]);
  }

  async cherryPick(hash: string): Promise<void> {
    await this.git.raw(["cherry-pick", hash]);
  }

  async revert(hash: string): Promise<void> {
    await this.git.raw(["revert", hash]);
  }

  async reset(hash: string, mode: "soft" | "mixed" | "hard" = "mixed"): Promise<void> {
    await this.git.raw(["reset", `--${mode}`, hash]);
  }

  async rebase(onto: string): Promise<string> {
    const result = await this.git.raw(["rebase", onto]);
    return result.trim() || "Rebase completed";
  }

  async getRebaseTodoList(onto: string): Promise<{ entries: RebaseTodoEntry[]; contextBefore: RebaseContextCommit[]; contextAfter: RebaseContextCommit[] }> {
    // Run a dry-run of git rebase -i to capture the exact todo list that git
    // would generate. This ensures perfect consistency between the UI preview
    // and the actual rebase execution.
    const todoHashes = await this.dryRunRebaseTodo(onto);

    // Fetch full commit details for each hash in the todo list
    const format = ["%H", "%h", "%s", "%an", "%aI", "%P"].join(FIELD_SEPARATOR);
    const entries: RebaseTodoEntry[] = [];
    for (const hash of todoHashes) {
      const raw = await this.git.raw(["log", "-1", `--format=${format}`, hash]);
      const fields = raw.trim().split(FIELD_SEPARATOR);
      entries.push({
        action: "pick",
        hash: fields[0],
        abbreviatedHash: fields[1],
        message: fields[2],
        author: fields[3],
        date: fields[4],
        parentHashes: (fields[5] || "").split(" ").filter(Boolean),
      });
    }

    // Fetch context commits (1 commit before and after the rebase range)
    const mergeBase = (await this.git.raw(["merge-base", "HEAD", onto])).trim();
    const contextCount = 1;
    const contextBefore = await this.getContextCommits(contextCount, "before");
    const contextAfter = await this.getContextCommits(contextCount, "after", mergeBase);

    return { entries, contextBefore, contextAfter };
  }

  /**
   * Run a dry-run of git rebase -i to capture the todo list git would generate.
   * Uses GIT_SEQUENCE_EDITOR to capture the todo file, then aborts the rebase.
   * Returns commit hashes in newest-first order.
   */
  private async dryRunRebaseTodo(onto: string): Promise<string[]> {
    const tmpFile = path.join(os.tmpdir(), `git-treegazer-rebase-dry-${Date.now()}`);

    // GIT_SEQUENCE_EDITOR: copy todo file then write empty content to abort rebase
    const editorCmd = `node -e "const fs=require('fs'); fs.copyFileSync(process.argv[1], '${tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'); fs.writeFileSync(process.argv[1], '')"`;

    try {
      await this.git
        .env({ ...process.env, GIT_SEQUENCE_EDITOR: editorCmd })
        .raw(["rebase", "-i", onto]);
    } catch {
      // Expected: empty todo causes git rebase to abort with "Nothing to do"
    }

    // Ensure no rebase state is left behind
    try {
      await this.git.raw(["rebase", "--abort"]);
    } catch {
      // Not in rebase state — this is the expected case
    }

    // Parse the todo file
    const hashes: string[] = [];
    try {
      const content = fs.readFileSync(tmpFile, "utf8");
      console.log("[git-treegazer] dryRunRebaseTodo onto:", onto);
      console.log("[git-treegazer] raw todo content:\n" + content);
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        // Format: "pick <hash> <message>"
        const match = trimmed.match(/^\w+\s+([0-9a-f]+)/);
        if (match) {
          hashes.push(match[1]);
        }
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    // git rebase -i outputs oldest-first; reverse to newest-first for UI
    return hashes.reverse();
  }

  private async getContextCommits(
    count: number,
    direction: "before" | "after",
    onto?: string,
  ): Promise<RebaseContextCommit[]> {
    const format = ["%H", "%h", "%s", "%an", "%aI", "%P"].join(FIELD_SEPARATOR);
    try {
      let raw: string;
      if (direction === "after") {
        // Commits before the rebase range (older than onto) — shown below in newest-first view
        raw = await this.git.raw([
          "log",
          `-${count}`,
          `--format=${format}${LOG_SEPARATOR}`,
          onto!,
        ]);
      } else {
        // Commit after the rebase range (child of HEAD) — shown above in newest-first view
        // Try to find commits on the current branch that are ahead of HEAD
        // This is typically empty unless there's a detached HEAD situation
        raw = await this.git.raw([
          "log",
          `-${count}`,
          `--format=${format}${LOG_SEPARATOR}`,
          `HEAD@{1}`,
        ]).catch(() => "");
      }

      if (!raw.trim()) return [];

      return raw
        .split(LOG_SEPARATOR)
        .filter((s) => s.trim())
        .map((entry): RebaseContextCommit => {
          const fields = entry.trim().split(FIELD_SEPARATOR);
          return {
            hash: fields[0],
            abbreviatedHash: fields[1],
            message: fields[2],
            author: fields[3],
            date: fields[4],
            parentHashes: (fields[5] || "").split(" ").filter(Boolean),
          };
        });
    } catch {
      return [];
    }
  }

  async interactiveRebase(onto: string, entries: RebaseTodoEntry[]): Promise<string> {
    // Entries are in newest-first order from the UI; git rebase expects oldest-first
    const reversed = [...entries].reverse();
    const todoContent = reversed
      .map((e) => `${e.action} ${e.hash} ${e.message}`)
      .join("\n") + "\n";

    const tmpFile = path.join(os.tmpdir(), `git-treegazer-rebase-todo-${Date.now()}`);
    fs.writeFileSync(tmpFile, todoContent, "utf8");

    // Cross-platform: use Node.js to copy the todo file
    const seqEditorCmd = `node -e "require('fs').copyFileSync('${tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', process.argv[1])"`;

    // Collect reword messages in oldest-first order (matching git's processing order)
    const rewordMessages: string[] = [];
    for (const entry of reversed) {
      if (entry.action === "reword") {
        rewordMessages.push(entry.newMessage !== undefined ? entry.newMessage : entry.message);
      }
    }

    const rewordDir = path.join(os.tmpdir(), `git-treegazer-reword-${Date.now()}`);
    let gitEditorCmd: string;

    if (rewordMessages.length > 0) {
      fs.mkdirSync(rewordDir, { recursive: true });
      for (let i = 0; i < rewordMessages.length; i++) {
        fs.writeFileSync(path.join(rewordDir, `msg-${i}`), rewordMessages[i], "utf8");
      }
      fs.writeFileSync(path.join(rewordDir, "counter"), "0", "utf8");

      const escapedDir = rewordDir.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      gitEditorCmd = `node -e "` +
        `const fs=require('fs'),p=require('path');` +
        `const dir='${escapedDir}';` +
        `const cf=p.join(dir,'counter');` +
        `const i=parseInt(fs.readFileSync(cf,'utf8'),10);` +
        `const mf=p.join(dir,'msg-'+i);` +
        `if(fs.existsSync(mf)){fs.writeFileSync(process.argv[1],fs.readFileSync(mf,'utf8'))}` +
        `fs.writeFileSync(cf,String(i+1))"`;
    } else {
      gitEditorCmd = "true";
    }

    try {
      const result = await this.git
        .env({ ...process.env, GIT_SEQUENCE_EDITOR: seqEditorCmd, GIT_EDITOR: gitEditorCmd })
        .raw(["rebase", "-i", onto]);
      return result.trim() || "Interactive rebase completed";
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      try { fs.rmSync(rewordDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async getRebaseState(): Promise<RebaseState> {
    try {
      const gitDir = (await this.git.raw(["rev-parse", "--git-dir"])).trim();
      // git rev-parse --git-dir may return an absolute path (e.g., in worktrees)
      const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(this.repoPath, gitDir);
      const rebaseMergePath = path.join(absGitDir, "rebase-merge");
      const rebaseApplyPath = path.join(absGitDir, "rebase-apply");
      console.log("[git-treegazer] getRebaseState gitDir:", gitDir, "absGitDir:", absGitDir, "repoPath:", this.repoPath);

      let isRebasing = false;
      let currentStep: number | undefined;
      let totalSteps: number | undefined;

      for (const dir of [rebaseMergePath, rebaseApplyPath]) {
        if (fs.existsSync(dir)) {
          isRebasing = true;
          const msgnumFile = path.join(dir, "msgnum");
          const endFile = path.join(dir, "end");
          if (fs.existsSync(msgnumFile)) {
            currentStep = parseInt(fs.readFileSync(msgnumFile, "utf8").trim(), 10);
          }
          if (fs.existsSync(endFile)) {
            totalSteps = parseInt(fs.readFileSync(endFile, "utf8").trim(), 10);
          }
          break;
        }
      }

      let conflictedFiles: string[] = [];
      if (isRebasing) {
        const status = await this.git.status();
        conflictedFiles = status.conflicted;
      }

      return { isRebasing, currentStep, totalSteps, conflictedFiles };
    } catch {
      return { isRebasing: false };
    }
  }

  async getAllWorktreeRebaseStates(): Promise<WorktreeRebaseState[]> {
    try {
      const raw = await this.git.raw(["worktree", "list", "--porcelain"]);
      const states: WorktreeRebaseState[] = [];

      for (const block of raw.split("\n\n")) {
        const lines = block.trim().split("\n");
        if (lines.length === 0) continue;

        let wtPath = "";
        let branch = "";
        let isDetached = false;
        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            wtPath = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
          } else if (line === "detached") {
            isDetached = true;
          }
        }
        if (!wtPath) continue;

        // Determine git dir for this worktree
        let wtGit;
        try {
          wtGit = simpleGit(wtPath);
        } catch {
          continue;
        }
        let gitDir: string;
        try {
          gitDir = (await wtGit.raw(["rev-parse", "--git-dir"])).trim();
        } catch {
          continue;
        }
        const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(wtPath, gitDir);

        let rebaseDir: string | undefined;
        for (const dir of [path.join(absGitDir, "rebase-merge"), path.join(absGitDir, "rebase-apply")]) {
          if (fs.existsSync(dir)) {
            rebaseDir = dir;
            break;
          }
        }
        if (!rebaseDir) continue;

        // If detached (rebase in progress detaches HEAD), read original branch from rebase state
        if (!branch && isDetached) {
          const headNameFile = path.join(rebaseDir, "head-name");
          if (fs.existsSync(headNameFile)) {
            branch = fs.readFileSync(headNameFile, "utf8").trim().replace(/^refs\/heads\//, "");
          }
        }
        if (!branch) continue;

        let currentStep: number | undefined;
        let totalSteps: number | undefined;
        const msgnumFile = path.join(rebaseDir, "msgnum");
        const endFile = path.join(rebaseDir, "end");
        if (fs.existsSync(msgnumFile)) {
          currentStep = parseInt(fs.readFileSync(msgnumFile, "utf8").trim(), 10);
        }
        if (fs.existsSync(endFile)) {
          totalSteps = parseInt(fs.readFileSync(endFile, "utf8").trim(), 10);
        }

        let hasConflicts = false;
        try {
          const status = await wtGit.status();
          hasConflicts = status.conflicted.length > 0;
        } catch { /* ignore */ }

        states.push({ branch, worktreePath: wtPath, currentStep, totalSteps, hasConflicts });
      }

      console.log("[git-treegazer] getAllWorktreeRebaseStates:", JSON.stringify(states));
      return states;
    } catch (err) {
      console.log("[git-treegazer] getAllWorktreeRebaseStates error:", err);
      return [];
    }
  }

  async rebaseContinue(): Promise<string> {
    const result = await this.git.raw(["rebase", "--continue"]);
    return result.trim() || "Rebase continue completed";
  }

  async rebaseAbort(): Promise<string> {
    const result = await this.git.raw(["rebase", "--abort"]);
    return result.trim() || "Rebase aborted";
  }

  async rebaseSkip(): Promise<string> {
    const result = await this.git.raw(["rebase", "--skip"]);
    return result.trim() || "Rebase skip completed";
  }

  async getStashDiff(index: number): Promise<DiffFile[]> {
    const raw = await this.git.raw([
      "stash",
      "show",
      "--numstat",
      `stash@{${index}}`,
    ]);
    return this.parseDiffStat(raw);
  }

  async getRemoteUrl(remote = "origin"): Promise<string> {
    try {
      const url = await this.git.raw(["config", "--get", `remote.${remote}.url`]);
      return url.trim();
    } catch {
      return "";
    }
  }

  static detectPrInfo(message: string): PullRequestInfo | undefined {
    // GitHub: "Merge pull request #123 from owner/branch"
    const ghMerge = message.match(/^Merge pull request #(\d+) from (.+)$/);
    if (ghMerge) {
      return {
        number: parseInt(ghMerge[1], 10),
        state: "merged",
        source: "pattern",
        sourceBranch: ghMerge[2],
      };
    }

    // Bitbucket: "Merged in branch-name (pull request #123)"
    const bbMerge = message.match(/^Merged in (.+?) \(pull request #(\d+)\)$/);
    if (bbMerge) {
      return {
        number: parseInt(bbMerge[2], 10),
        state: "merged",
        source: "pattern",
        sourceBranch: bbMerge[1],
      };
    }

    // GitHub squash merge: "title (#123)"
    const ghSquash = message.match(/\(#(\d+)\)\s*$/);
    if (ghSquash) {
      return {
        number: parseInt(ghSquash[1], 10),
        state: "merged",
        source: "pattern",
      };
    }

    return undefined;
  }

  /** Read github-pr-owner-number from git config for all branches. Returns Map<branchName, PullRequestInfo>. */
  async getBranchPRFromConfig(): Promise<Map<string, PullRequestInfo>> {
    const result = new Map<string, PullRequestInfo>();
    try {
      const raw = await this.git.raw(["config", "--local", "--get-regexp", "^branch\\..*\\.github-pr-owner-number$"]);
      for (const line of raw.trim().split("\n")) {
        if (!line) continue;
        // Format: branch.<name>.github-pr-owner-number <owner>#<repo>#<number>
        const match = line.match(/^branch\.(.+?)\.github-pr-owner-number\s+(.+)$/);
        if (!match) continue;
        const branchName = match[1];
        const value = match[2];
        const parts = value.split("#");
        const prNumber = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(prNumber)) {
          result.set(branchName, {
            number: prNumber,
            source: "git-config",
            sourceBranch: branchName,
          });
        }
      }
    } catch {
      // No github-pr-owner-number config entries
    }
    return result;
  }

  async listAllConfig(): Promise<GitConfigEntry[]> {
    const entries: GitConfigEntry[] = [];
    for (const scope of ["local", "global"] as const) {
      try {
        const result = await this.git.listConfig(scope);
        for (const [key, value] of Object.entries(result.all)) {
          if (Array.isArray(value)) {
            for (const v of value) {
              entries.push({ key, value: v, scope });
            }
          } else {
            entries.push({ key, value, scope });
          }
        }
      } catch {
        // Scope may not exist
      }
    }
    return entries;
  }

  async setConfig(key: string, value: string, scope: "local" | "global"): Promise<void> {
    await this.git.addConfig(key, value, false, scope);
  }

  async unsetConfig(key: string, scope: "local" | "global"): Promise<void> {
    const scopeFlag = scope === "local" ? "--local" : "--global";
    await this.git.raw(["config", "--unset", scopeFlag, key]);
  }

  async getRemoteNames(): Promise<string[]> {
    const remotes = await this.git.getRemotes(false);
    return remotes.map((r) => r.name);
  }

  async getAuthors(): Promise<string[]> {
    const raw = await this.git.raw(["log", "--all", "--format=%an"]);
    if (!raw.trim()) return [];
    const authors = new Set(raw.trim().split("\n").filter(Boolean));
    return [...authors].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  async getRemoteList(): Promise<GitRemoteInfo[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map((r) => ({
      name: r.name,
      fetchUrl: r.refs.fetch,
      pushUrl: r.refs.push,
    }));
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
  }

  async removeRemote(name: string): Promise<void> {
    await this.git.removeRemote(name);
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    await this.git.remote(["rename", oldName, newName]);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    await this.git.remote(["set-url", name, url]);
  }

  async getUncommittedSummary(): Promise<{ staged: number; unstaged: number; untracked: number }> {
    const raw = await this.git.raw(["status", "--porcelain"]);
    if (!raw.trim()) return { staged: 0, unstaged: 0, untracked: 0 };

    let staged = 0;
    let unstaged = 0;
    let untracked = 0;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      const x = line[0]; // index status
      const y = line[1]; // worktree status

      if (x === "?" && y === "?") {
        untracked++;
      } else {
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") unstaged++;
      }
    }

    return { staged, unstaged, untracked };
  }

  async getUncommittedDiff(): Promise<{ stagedFiles: DiffFile[]; unstagedFiles: DiffFile[]; untrackedFiles: string[] }> {
    let stagedFiles: DiffFile[] = [];
    let unstagedFiles: DiffFile[] = [];
    const untrackedFiles: string[] = [];

    // Staged files (index vs HEAD)
    try {
      const raw = await this.git.raw(["-c", "core.quotePath=false", "diff", "--numstat", "-M", "--cached"]);
      if (raw.trim()) stagedFiles = this.parseDiffStat(raw);
    } catch {
      // HEAD may not exist (initial commit)
    }

    // Unstaged files (worktree vs index)
    try {
      const raw = await this.git.raw(["-c", "core.quotePath=false", "diff", "--numstat", "-M"]);
      if (raw.trim()) unstagedFiles = this.parseDiffStat(raw);
    } catch {
      // No unstaged changes
    }

    // Untracked files
    try {
      const raw = await this.git.raw(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"]);
      if (raw.trim()) {
        for (const line of raw.trim().split("\n")) {
          if (line) untrackedFiles.push(line);
        }
      }
    } catch {
      // No untracked files
    }

    return { stagedFiles, unstagedFiles, untrackedFiles };
  }

  private parseDiffStat(raw: string): DiffFile[] {
    if (!raw.trim()) return [];
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split("\t");
        const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
        const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
        const filePath = parts[2];

        // Detect renames: "old => new" or "{dir/old => dir/new}"
        const renameMatch = filePath.match(/^(.+?)\{(.+?) => (.+?)\}(.*)$/) ||
          filePath.match(/^(.+?) => (.+?)$/);

        let path: string;
        let oldPath: string | undefined;
        let status: DiffFile["status"];

        if (renameMatch) {
          if (renameMatch.length === 5) {
            // {dir/old => dir/new} pattern
            oldPath = renameMatch[1] + renameMatch[2] + renameMatch[4];
            path = renameMatch[1] + renameMatch[3] + renameMatch[4];
          } else {
            oldPath = renameMatch[1];
            path = renameMatch[2];
          }
          status = "renamed";
        } else {
          path = filePath;
          if (additions > 0 && deletions === 0) {
            status = "added";
          } else if (additions === 0 && deletions > 0) {
            status = "deleted";
          } else {
            status = "modified";
          }
        }

        return { path, oldPath, status, additions, deletions };
      });
  }

  // --- baretree integration ---

  private static btAvailableCache: boolean | null = null;
  private btRepoCache: boolean | null = null;

  async isBtAvailable(): Promise<boolean> {
    if (GitService.btAvailableCache !== null) return GitService.btAvailableCache;
    try {
      await execFileAsync("which", ["bt"]);
      GitService.btAvailableCache = true;
    } catch {
      GitService.btAvailableCache = false;
    }
    return GitService.btAvailableCache;
  }

  async isBtRepo(): Promise<boolean> {
    if (this.btRepoCache !== null) return this.btRepoCache;
    if (!await this.isBtAvailable()) {
      this.btRepoCache = false;
      return false;
    }
    try {
      await execFileAsync("bt", ["status"], { cwd: this.repoPath });
      this.btRepoCache = true;
    } catch {
      this.btRepoCache = false;
    }
    return this.btRepoCache;
  }

  async btAddWorktree(branchName: string, baseRef?: string): Promise<string> {
    const args = ["add", "-b", branchName];
    if (baseRef) args.push("--base", baseRef);
    const { stdout } = await execFileAsync("bt", args, { cwd: this.repoPath });
    return stdout.trim();
  }

  async btAddWorktreeForExistingBranch(branchName: string): Promise<string> {
    const { stdout } = await execFileAsync("bt", ["add", branchName], { cwd: this.repoPath });
    return stdout.trim();
  }

  async btRenameWorktree(oldName: string, newName: string): Promise<string> {
    const { stdout } = await execFileAsync("bt", ["rename", oldName, newName], { cwd: this.repoPath });
    return stdout.trim();
  }

  async btRemoveWorktree(branch: string, withBranch: boolean, force: boolean): Promise<string> {
    const args = ["rm", branch];
    if (withBranch) args.push("--with-branch");
    if (force) args.push("--force");
    const { stdout } = await execFileAsync("bt", args, { cwd: this.repoPath });
    return stdout.trim();
  }

  async btListWorktrees(): Promise<BaretreeWorktreeEntry[]> {
    if (!await this.isBtRepo()) return [];
    try {
      const { stdout } = await execFileAsync("bt", ["list", "--json"], { cwd: this.repoPath });
      const entries = JSON.parse(stdout) as Array<{
        Path: string; Head: string; Branch: string; IsMain: boolean; IsBare: boolean;
      }>;
      // Find bare root path to infer branch names for detached worktrees
      const bareEntry = entries.find(e => e.IsBare);
      const bareRoot = bareEntry ? bareEntry.Path : "";
      return entries
        .filter(e => !e.IsBare)
        .map(e => {
          let branch = e.Branch;
          // For detached worktrees, infer branch name from path relative to bare root
          if (branch === "detached" && bareRoot) {
            const relative = path.relative(bareRoot, e.Path);
            if (relative && !relative.startsWith("..")) {
              branch = relative;
            }
          }
          return {
            path: e.Path,
            head: e.Head,
            branch,
            isMain: e.IsMain,
            isBare: e.IsBare,
          };
        });
    } catch {
      return [];
    }
  }

  async btGetDefaultBranch(): Promise<string | null> {
    if (!await this.isBtRepo()) return null;
    try {
      const { stdout } = await execFileAsync("bt", ["config", "default-branch"], { cwd: this.repoPath });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async btConfigExport(): Promise<string> {
    if (!await this.isBtRepo()) return "";
    try {
      const { stdout } = await execFileAsync("bt", ["config", "export"], { cwd: this.repoPath });
      return stdout;
    } catch {
      return "";
    }
  }

  btParseConfigExport(toml: string): { postCreate: PostCreateAction[]; syncToRoot: SyncToRootEntry[] } {
    const postCreate: PostCreateAction[] = [];
    const syncToRoot: SyncToRootEntry[] = [];
    if (!toml) return { postCreate, syncToRoot };

    const lines = toml.split("\n");
    let currentSection: "postcreate" | "synctoroot" | null = null;
    let currentEntry: Record<string, string> = {};

    const flushEntry = () => {
      if (currentSection === "postcreate" && currentEntry.source && currentEntry.type) {
        postCreate.push({
          type: currentEntry.type as PostCreateActionType,
          source: currentEntry.source,
          managed: currentEntry.managed !== "false",
        });
      } else if (currentSection === "synctoroot" && currentEntry.source !== undefined) {
        syncToRoot.push({
          source: currentEntry.source,
          target: currentEntry.target || currentEntry.source,
        });
      }
      currentEntry = {};
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "[[postcreate]]") {
        flushEntry();
        currentSection = "postcreate";
      } else if (trimmed === "[[synctoroot]]") {
        flushEntry();
        currentSection = "synctoroot";
      } else if (trimmed.startsWith("[")) {
        flushEntry();
        currentSection = null;
      } else if (currentSection && trimmed.includes("=")) {
        const eqIdx = trimmed.indexOf("=");
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Remove surrounding quotes
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        currentEntry[key] = value;
      }
    }
    flushEntry();

    return { postCreate, syncToRoot };
  }

  async btListPostCreateActions(): Promise<PostCreateAction[]> {
    const toml = await this.btConfigExport();
    return this.btParseConfigExport(toml).postCreate;
  }

  async btListSyncToRoot(): Promise<SyncToRootEntry[]> {
    const toml = await this.btConfigExport();
    return this.btParseConfigExport(toml).syncToRoot;
  }

  async btAddPostCreateAction(actionType: PostCreateActionType, source: string, managed: boolean): Promise<string> {
    const args = ["post-create", "add", actionType, source];
    if (!managed && actionType !== "command") args.push("--no-managed");
    const { stdout } = await execFileAsync("bt", args, { cwd: this.repoPath });
    return stdout.trim();
  }

  async btRemovePostCreateAction(source: string): Promise<string> {
    const { stdout } = await execFileAsync("bt", ["post-create", "remove", source], { cwd: this.repoPath });
    return stdout.trim();
  }

  async btAddSyncToRoot(source: string, target?: string): Promise<string> {
    const args = ["sync-to-root", "add", source];
    if (target && target !== source) args.push(target);
    const { stdout } = await execFileAsync("bt", args, { cwd: this.repoPath });
    return stdout.trim();
  }

  async btRemoveSyncToRoot(source: string): Promise<string> {
    const { stdout } = await execFileAsync("bt", ["sync-to-root", "remove", source], { cwd: this.repoPath });
    return stdout.trim();
  }

  async removeWorktree(wtPath: string, force: boolean): Promise<void> {
    const args = ["worktree", "remove", wtPath];
    if (force) args.push("--force");
    await this.git.raw(args);
  }
}
