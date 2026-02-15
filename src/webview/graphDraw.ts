import type { GraphLane } from "./graphRenderer";

export const COLORS = [
  "#00d4ff", "#44dd88", "#ff4466", "#e8b05d",
  "#ff8800", "#6688ff", "#ff66aa", "#00eeff", "#ff5555",
  "#5577ff", "#55ddcc", "#ff6600", "#e0c040",
  "#00ccff", "#44bbaa", "#ff77cc", "#88aaff",
];

export function drawGraphRow(
  canvas: HTMLCanvasElement,
  lanes: GraphLane[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const laneWidth = 14;
  const cy = h / 2;
  const nodeRadius = 3.5;

  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 2;

  // Draw lines first, then nodes on top
  for (const lane of lanes) {
    const color = COLORS[lane.colorIndex % COLORS.length];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    const x = lane.column * laneWidth + laneWidth / 2;
    const isDashed = lane.dashed;

    if (isDashed) {
      ctx.save();
      ctx.setLineDash([3, 3]);
    }

    if (lane.type === "pass") {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    } else if (lane.type === "node") {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    } else if (lane.type === "merge-in") {
      const fromX = lane.fromColumn! * laneWidth + laneWidth / 2;
      const targetX = lane.toColumn !== undefined
        ? lane.toColumn * laneWidth + laneWidth / 2
        : x;
      ctx.beginPath();
      ctx.moveTo(fromX, 0);
      ctx.bezierCurveTo(fromX, cy, targetX, cy, targetX, cy);
      ctx.stroke();
    } else if (lane.type === "branch-out") {
      const toX = lane.toColumn! * laneWidth + laneWidth / 2;
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.bezierCurveTo(x, cy, toX, cy, toX, h);
      ctx.stroke();
    } else if (lane.type === "start") {
      ctx.beginPath();
      ctx.moveTo(x, cy);
      ctx.lineTo(x, h);
      ctx.stroke();
    } else if (lane.type === "end") {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cy);
      ctx.stroke();
    }

    if (isDashed) {
      ctx.restore();
    }
  }

  // Draw nodes on top of lines
  for (const lane of lanes) {
    const color = COLORS[lane.colorIndex % COLORS.length];
    ctx.fillStyle = color;
    const x = lane.column * laneWidth + laneWidth / 2;

    if (lane.type === "node" || lane.type === "start" || lane.type === "end") {
      if (lane.isMergeCommit) {
        // Merge commit: double circle (ring with dot)
        const outerRadius = 5;
        const innerRadius = 3;
        const dotRadius = 1.5;
        // Outer filled circle
        ctx.beginPath();
        ctx.arc(x, cy, outerRadius, 0, Math.PI * 2);
        ctx.fill();
        // Inner cutout (background color)
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(x, cy, innerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Center dot
        ctx.beginPath();
        ctx.arc(x, cy, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, cy, nodeRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
