export interface GraphLane {
  column: number;
  colorIndex: number;
  type: "pass" | "node" | "merge-in" | "branch-out" | "start" | "end";
  fromColumn?: number;
  toColumn?: number;
  dashed?: boolean;
  isMergeCommit?: boolean;
}

interface CommitLike {
  hash: string;
  parentHashes: string[];
  filteredParentHashes?: string[];
}

interface ActiveLane {
  hash: string;
  colorIndex: number;
  column: number;
  dashed?: boolean;
}

export function renderGraph(commits: CommitLike[]): GraphLane[][] {
  const result: GraphLane[][] = [];
  const activeLanes: ActiveLane[] = [];
  let nextColor = 0;

  // Track which columns are in use; freed columns can be reused
  const usedColumns = new Set<number>();
  let maxColumn = 0;

  function allocateColumn(): number {
    for (let c = 0; c <= maxColumn; c++) {
      if (!usedColumns.has(c)) {
        usedColumns.add(c);
        if (c >= maxColumn) maxColumn = c + 1;
        return c;
      }
    }
    const c = maxColumn;
    usedColumns.add(c);
    maxColumn = c + 1;
    return c;
  }

  function freeColumn(c: number): void {
    usedColumns.delete(c);
  }

  // Build a set of all commit hashes for quick lookup
  const commitHashSet = new Set(commits.map((c) => c.hash));

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];

    // Find ALL lanes that target this commit (multiple children may point here)
    const matchingIndices: number[] = [];
    for (let j = 0; j < activeLanes.length; j++) {
      if (activeLanes[j].hash === commit.hash) {
        matchingIndices.push(j);
      }
    }

    // Primary lane: use the first matching lane, or create a new one
    let commitLaneIdx: number;
    let isNewLane = false;
    if (matchingIndices.length > 0) {
      commitLaneIdx = matchingIndices[0];
    } else {
      const col = allocateColumn();
      commitLaneIdx = activeLanes.length;
      activeLanes.push({
        hash: commit.hash,
        colorIndex: nextColor++,
        column: col,
      });
      matchingIndices.push(commitLaneIdx);
      isNewLane = true;
    }

    const commitColumn = activeLanes[commitLaneIdx].column;
    const hasFilteredParents = commit.filteredParentHashes && commit.filteredParentHashes.length > 0;
    const parents = hasFilteredParents ? commit.filteredParentHashes! : commit.parentHashes;

    // --- Build rowLanes for all active lanes ---
    const rowLanes: GraphLane[] = [];

    // Set of secondary lane indices that will merge into the primary node
    const secondarySet = new Set(matchingIndices.slice(1));

    for (let j = 0; j < activeLanes.length; j++) {
      if (j === commitLaneIdx) {
        // Primary lane — draw the node
        const nodeType = parents.length === 0 ? "end" : isNewLane ? "start" : "node";
        rowLanes.push({
          column: activeLanes[j].column,
          colorIndex: activeLanes[j].colorIndex,
          type: nodeType,
          isMergeCommit: commit.parentHashes.length > 1,
        });
      } else if (secondarySet.has(j)) {
        // Secondary lane merging into the same commit — draw merge-in line
        rowLanes.push({
          column: activeLanes[j].column,
          colorIndex: activeLanes[j].colorIndex,
          type: "merge-in",
          fromColumn: activeLanes[j].column,
          toColumn: commitColumn,
        });
      } else {
        // Unrelated lane — pass through
        rowLanes.push({
          column: activeLanes[j].column,
          colorIndex: activeLanes[j].colorIndex,
          type: "pass",
          dashed: activeLanes[j].dashed,
        });
      }
    }

    // Remove secondary lanes (iterate in reverse to keep indices stable)
    for (let s = matchingIndices.length - 1; s >= 1; s--) {
      const idx = matchingIndices[s];
      freeColumn(activeLanes[idx].column);
      activeLanes.splice(idx, 1);
      if (idx < commitLaneIdx) {
        commitLaneIdx--;
      }
    }

    // Handle parents
    if (parents.length === 0) {
      // Root commit — remove this lane and free its column
      freeColumn(activeLanes[commitLaneIdx].column);
      activeLanes.splice(commitLaneIdx, 1);
    } else {
      // First parent continues in the same lane (same column)
      activeLanes[commitLaneIdx].hash = parents[0];
      activeLanes[commitLaneIdx].dashed = hasFilteredParents || false;

      // Mark the node lane as dashed if using filtered parents (indirect connection)
      if (hasFilteredParents) {
        const nodeLane = rowLanes.find(
          (l) => l.column === commitColumn && (l.type === "node" || l.type === "start"),
        );
        if (nodeLane) {
          nodeLane.dashed = true;
        }
      }

      // Additional parents (merge commits)
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p];
        const existingIdx = activeLanes.findIndex(
          (l) => l.hash === parentHash,
        );

        if (existingIdx !== -1) {
          // Parent already has a lane — draw merge line
          rowLanes.push({
            column: commitColumn,
            colorIndex: activeLanes[existingIdx].colorIndex,
            type: "merge-in",
            fromColumn: activeLanes[existingIdx].column,
            dashed: hasFilteredParents,
          });
        } else {
          // Create new lane for this parent
          const newColor = nextColor++;
          const newCol = allocateColumn();
          activeLanes.push({
            hash: parentHash,
            colorIndex: newColor,
            column: newCol,
            dashed: hasFilteredParents,
          });

          rowLanes.push({
            column: commitColumn,
            colorIndex: newColor,
            type: "branch-out",
            toColumn: newCol,
            dashed: hasFilteredParents,
          });
        }
      }
    }

    // Clean up lanes whose target hash will never appear as a future commit
    for (let j = activeLanes.length - 1; j >= 0; j--) {
      // Never remove the commit's main lane (first parent continues there)
      if (parents.length > 0 && j === commitLaneIdx) continue;

      const lane = activeLanes[j];

      // Keep if hash will appear as a future commit or is needed as a parent
      const neededInFuture = commits.slice(i + 1).some(
        (c) => c.hash === lane.hash || c.parentHashes.includes(lane.hash),
      );
      if (neededInFuture) continue;

      // Keep if hash is beyond our loaded commit range (pagination boundary)
      if (!commitHashSet.has(lane.hash)) continue;

      // Safe to remove — mark as ending in rowLanes and free column
      if (j < rowLanes.length && rowLanes[j].type === "pass") {
        rowLanes[j].type = "end";
      }
      freeColumn(lane.column);
      activeLanes.splice(j, 1);
      if (j < commitLaneIdx) {
        commitLaneIdx--;
      }
    }

    result.push(rowLanes);
  }

  return result;
}
