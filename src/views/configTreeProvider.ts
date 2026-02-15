import * as vscode from "vscode";
import { RepoManager } from "../services/repoManager";
import type { GitConfigEntry, GitRemoteInfo } from "../types";

type ConfigTreeItem =
  | ConfigGroupItem
  | ConfigSectionGroupItem
  | RemoteGroupItem
  | ConfigEntryItem;

const SECTION_ICONS: Record<string, string> = {
  user: "person",
  core: "gear",
  branch: "git-branch",
  merge: "git-merge",
  pull: "cloud-download",
  push: "cloud-upload",
  diff: "diff",
  color: "symbol-color",
  alias: "terminal",
  http: "globe",
  credential: "key",
  init: "new-file",
  fetch: "cloud-download",
  rebase: "git-compare",
  filter: "filter",
  pack: "package",
  gc: "trash",
  log: "history",
  tag: "tag",
  advice: "info",
  status: "info",
  stash: "archive",
  submodule: "file-submodule",
  lfs: "package",
  url: "link",
  safe: "shield",
};

class ConfigGroupItem extends vscode.TreeItem {
  constructor(
    public readonly groupLabel: string,
    public readonly groupType: "user" | "remotes",
  ) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `config-group:${groupType}`;
    this.contextValue = "configGroup";
    if (groupType === "user") {
      this.iconPath = new vscode.ThemeIcon("person");
    } else {
      this.iconPath = new vscode.ThemeIcon("cloud");
    }
  }
}

class ConfigSectionGroupItem extends vscode.TreeItem {
  constructor(public readonly sectionName: string) {
    super(sectionName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `config-section:${sectionName}`;
    this.contextValue = "configSectionGroup";
    const icon = SECTION_ICONS[sectionName] || "settings-gear";
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class RemoteGroupItem extends vscode.TreeItem {
  constructor(
    public readonly remoteName: string,
    public readonly remote: GitRemoteInfo,
  ) {
    super(remoteName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `config-remote:${remoteName}`;
    this.contextValue = "remoteGroup";
    this.iconPath = new vscode.ThemeIcon("remote");
    this.description = remote.fetchUrl;
    this.tooltip = `Fetch: ${remote.fetchUrl}\nPush: ${remote.pushUrl}`;
  }
}

class ConfigEntryItem extends vscode.TreeItem {
  constructor(public readonly entry: GitConfigEntry) {
    // Show short key (last part after section prefix)
    const parts = entry.key.split(".");
    const shortKey =
      parts.length >= 3 ? parts.slice(2).join(".") : parts.slice(1).join(".");
    super(shortKey, vscode.TreeItemCollapsibleState.None);
    this.id = `config-entry:${entry.scope}:${entry.key}`;

    if (entry.key.startsWith("remote.")) {
      this.contextValue = "remoteConfigEntry";
    } else {
      this.contextValue = "configEntry";
    }

    this.description = `${entry.value}  [${entry.scope}]`;
    this.tooltip = `${entry.key} = ${entry.value}\nScope: ${entry.scope}`;
    this.iconPath = new vscode.ThemeIcon(
      entry.scope === "local" ? "file" : "globe",
    );

    this.command = {
      command: "gitTreegazer.configEditValue",
      title: "Edit Config Value",
      arguments: [entry],
    };
  }
}

export class ConfigTreeProvider
  implements vscode.TreeDataProvider<ConfigTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ConfigTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private configEntries: GitConfigEntry[] = [];
  private remotes: GitRemoteInfo[] = [];
  private disposables: vscode.Disposable[] = [];
  private treeView?: vscode.TreeView<ConfigTreeItem>;

  constructor(private readonly repoManager: RepoManager) {
    this.disposables.push(
      repoManager.onDidChangeActiveRepo(() => this.refresh()),
      repoManager.onDidChangeRepos(() => this.updateDescription()),
    );
  }

  setTreeView(view: vscode.TreeView<ConfigTreeItem>): void {
    this.treeView = view;
  }

  private updateDescription(): void {
    if (!this.treeView) return;
    if (this.repoManager.getRepoCount() > 1) {
      this.treeView.description = this.repoManager.getActiveRepoName();
    } else {
      this.treeView.description = undefined;
    }
  }

  async refresh(): Promise<void> {
    const service = this.repoManager.getActiveService();
    if (service) {
      try {
        this.configEntries = await service.listAllConfig();
        this.remotes = await service.getRemoteList();
      } catch {
        this.configEntries = [];
        this.remotes = [];
      }
    } else {
      this.configEntries = [];
      this.remotes = [];
    }
    this.updateDescription();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConfigTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(
    element?: ConfigTreeItem,
  ): vscode.ProviderResult<ConfigTreeItem[]> {
    if (!element) {
      // Root level: User Info, Remotes, then each config section as its own group
      const items: ConfigTreeItem[] = [];

      const userEntries = this.configEntries.filter((e) =>
        e.key.startsWith("user."),
      );
      if (userEntries.length > 0) {
        items.push(new ConfigGroupItem("User Info", "user"));
      }

      if (this.remotes.length > 0) {
        items.push(new ConfigGroupItem("Remotes", "remotes"));
      }

      // Collect unique section names for other config
      const otherEntries = this.configEntries.filter(
        (e) => !e.key.startsWith("user.") && !e.key.startsWith("remote."),
      );
      const sections = new Set<string>();
      for (const e of otherEntries) {
        sections.add(e.key.split(".")[0]);
      }
      // "branch" section goes last
      for (const section of [...sections].sort()) {
        if (section !== "branch") {
          items.push(new ConfigSectionGroupItem(section));
        }
      }
      if (sections.has("branch")) {
        items.push(new ConfigSectionGroupItem("branch"));
      }

      return items;
    }

    if (element instanceof ConfigGroupItem) {
      if (element.groupType === "user") {
        return this.configEntries
          .filter((e) => e.key.startsWith("user."))
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((e) => new ConfigEntryItem(e));
      }

      if (element.groupType === "remotes") {
        return this.remotes
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => new RemoteGroupItem(r.name, r));
      }
    }

    if (element instanceof ConfigSectionGroupItem) {
      const prefix = `${element.sectionName}.`;
      const entries = this.configEntries
        .filter((e) => e.key.startsWith(prefix) && !e.key.startsWith("remote."));

      if (element.sectionName === "branch") {
        // Sort: main/master first, then branches with upstream, then rest alphabetically
        const branchName = (e: GitConfigEntry) => {
          const parts = e.key.split(".");
          return parts.length >= 3 ? parts[1] : "";
        };
        const hasUpstream = (name: string) =>
          entries.some((e) => e.key === `branch.${name}.remote`);
        const isPrimary = (name: string) =>
          name === "main" || name === "master";

        entries.sort((a, b) => {
          const aName = branchName(a);
          const bName = branchName(b);
          const aPrimary = isPrimary(aName);
          const bPrimary = isPrimary(bName);
          if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
          const aUp = hasUpstream(aName);
          const bUp = hasUpstream(bName);
          if (aUp !== bUp) return aUp ? -1 : 1;
          if (aName !== bName) return aName.localeCompare(bName);
          return a.key.localeCompare(b.key);
        });
      } else {
        entries.sort((a, b) => a.key.localeCompare(b.key));
      }

      return entries.map((e) => new ConfigEntryItem(e));
    }

    if (element instanceof RemoteGroupItem) {
      const prefix = `remote.${element.remoteName}.`;
      return this.configEntries
        .filter((e) => e.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => new ConfigEntryItem(e));
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
