export interface RefInfo {
  name: string;
  type: "head" | "branch" | "remote" | "tag";
}

export interface GroupedRef {
  local: RefInfo;
  remotes: RefInfo[];
}

export type ResolvedRef = GroupedRef | RefInfo;

export function isGroupedRef(ref: ResolvedRef): ref is GroupedRef {
  return "local" in ref;
}

export function classifyRef(ref: string, remoteNames: string[]): RefInfo | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  // HEAD -> branch
  if (trimmed.startsWith("HEAD -> ")) {
    return {
      name: trimmed.replace("HEAD -> ", ""),
      type: "head",
    };
  }

  // HEAD
  if (trimmed === "HEAD") {
    return { name: "HEAD", type: "head" };
  }

  // tag: name
  if (trimmed.startsWith("tag: ")) {
    return {
      name: trimmed.replace("tag: ", ""),
      type: "tag",
    };
  }

  // Remote branch: starts with a known remote name followed by /
  for (const remote of remoteNames) {
    if (trimmed.startsWith(remote + "/")) {
      return { name: trimmed, type: "remote" };
    }
  }

  // local branch (may contain / like feat/auth)
  return { name: trimmed, type: "branch" };
}

const REF_ICONS: Record<RefInfo["type"], string> = {
  head: `<span class="codicon codicon-git-branch" style="font-size:12px"></span>`,
  branch: `<span class="codicon codicon-git-branch" style="font-size:12px"></span>`,
  remote: `<span class="codicon codicon-cloud" style="font-size:12px"></span>`,
  tag: `<span class="codicon codicon-tag" style="font-size:12px"></span>`,
};

export function getRefIcon(type: RefInfo["type"]): string {
  return REF_ICONS[type];
}

export function getLocalBranchName(ref: RefInfo, remoteNames: string[]): string | null {
  if (ref.type === "tag") return null;
  if (ref.type === "head" || ref.type === "branch") return ref.name;
  if (ref.type === "remote") {
    for (const remote of remoteNames) {
      if (ref.name.startsWith(remote + "/")) {
        return ref.name.substring(remote.length + 1);
      }
    }
  }
  return null;
}

export function groupRefs(rawRefs: string[], remoteNames: string[]): ResolvedRef[] {
  const classified = rawRefs
    .map((r) => classifyRef(r, remoteNames))
    .filter((r): r is RefInfo => r !== null);

  // Separate locals (head/branch) and remotes
  const locals: RefInfo[] = [];
  const remotes: RefInfo[] = [];
  const others: RefInfo[] = []; // tags, bare HEAD

  for (const ref of classified) {
    if (ref.type === "head" && ref.name !== "HEAD") {
      locals.push(ref);
    } else if (ref.type === "branch") {
      locals.push(ref);
    } else if (ref.type === "remote") {
      remotes.push(ref);
    } else {
      others.push(ref);
    }
  }

  const pairedRemoteNames = new Set<string>();
  const result: ResolvedRef[] = [];

  // Group locals with matching remotes
  for (const local of locals) {
    const matched = remotes.filter((r) => {
      // remote name like "origin/main" -> local part is "main"
      const slashIndex = r.name.indexOf("/");
      if (slashIndex === -1) return false;
      const localPart = r.name.substring(slashIndex + 1);
      return localPart === local.name;
    });

    if (matched.length > 0) {
      for (const m of matched) pairedRemoteNames.add(m.name);
      result.push({ local, remotes: matched });
    } else {
      result.push(local);
    }
  }

  // Add unpaired remotes
  for (const remote of remotes) {
    if (!pairedRemoteNames.has(remote.name)) {
      result.push(remote);
    }
  }

  // Add others (tags, bare HEAD)
  result.push(...others);

  return result;
}

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");

  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());

  return `${y}-${mo}-${d} ${h}:${mi}`;
}
