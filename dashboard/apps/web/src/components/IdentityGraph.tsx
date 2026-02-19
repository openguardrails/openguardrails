import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import Dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { AgentProfile, AgentPermission } from "../lib/api";

// ---- Helpers ----

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function dominantAccess(perms: AgentPermission[]): string | null {
  const counts: Record<string, number> = {};
  for (const p of perms) {
    const a = p.accessPattern || "unknown";
    counts[a] = (counts[a] || 0) + p.callCount;
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}

const CATEGORY_LABELS: Record<string, string> = {
  github: "GitHub", slack: "Slack", gmail: "Gmail", filesystem: "Filesystem",
  shell: "Shell", jira: "Jira", notion: "Notion", docker: "Docker",
  postgres: "PostgreSQL", redis: "Redis", aws: "AWS", exec: "Exec",
};
function fmtCategory(cat: string): string {
  return CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
}

const CATEGORY_ICONS: Record<string, string> = {
  github: "\uD83D\uDC19", slack: "\uD83D\uDCAC", gmail: "\u2709\uFE0F", filesystem: "\uD83D\uDCC1",
  shell: "\uD83D\uDDA5\uFE0F", exec: "\u26A1", jira: "\uD83D\uDCCB", notion: "\uD83D\uDDD2\uFE0F",
  docker: "\uD83D\uDC33", postgres: "\uD83D\uDDC4\uFE0F", redis: "\uD83D\uDD34", aws: "\u2601\uFE0F",
};

function riskLabel(access: string | null): { label: string; cls: string } | null {
  if (access === "admin") return { label: "High", cls: "ig-risk--high" };
  if (access === "write") return { label: "Medium", cls: "ig-risk--medium" };
  if (access === "read") return { label: "Low", cls: "ig-risk--low" };
  return null;
}

// ---- Node dimensions ----

const NODE_SIZES: Record<string, { w: number; h: number }> = {
  agent: { w: 220, h: 110 },
  owner: { w: 170, h: 100 },
  system: { w: 190, h: 100 },
  tool: { w: 155, h: 52 },
};

// ---- Custom Nodes ----

function AgentNode({ data }: NodeProps) {
  const risk = riskLabel(data.dominantAccess as string | null);
  return (
    <div className="ig-node ig-node--agent">
      <Handle type="target" position={Position.Left} className="ig-handle" />
      <div className="ig-tag ig-tag--agent">Agent</div>
      <div className="ig-node__row">
        <div className="ig-node__icon ig-node__icon--agent">{data.emoji as string}</div>
        <div className="ig-node__body">
          <div className="ig-node__name">{data.label as string}</div>
          <div className="ig-node__sub mono">{truncate(data.sublabel as string || "", 26)}</div>
        </div>
      </div>
      {risk && (
        <div className="ig-node__footer">
          <span className={`ig-risk ${risk.cls}`}>{risk.label}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="ig-handle" />
    </div>
  );
}

function OwnerNode({ data }: NodeProps) {
  return (
    <div className="ig-node ig-node--owner">
      <div className="ig-tag ig-tag--owner">Owner</div>
      <div className="ig-node__row">
        <div className="ig-node__icon ig-node__icon--owner">{"\uD83D\uDC64"}</div>
        <div className="ig-node__body">
          <div className="ig-node__name">{data.label as string}</div>
          {data.sublabel && <div className="ig-node__sub">{data.sublabel as string}</div>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="ig-handle" />
    </div>
  );
}

function SystemNode({ data }: NodeProps) {
  const access = data.access as string | null;
  const risk = riskLabel(access);
  const icon = CATEGORY_ICONS[data.categoryKey as string] || "\uD83D\uDD27";
  return (
    <div className="ig-node ig-node--system">
      <Handle type="target" position={Position.Left} className="ig-handle" />
      <div className="ig-tag ig-tag--system">NHI Used</div>
      <div className="ig-node__row">
        <div className="ig-node__icon ig-node__icon--system">{icon}</div>
        <div className="ig-node__body">
          <div className="ig-node__name">{data.label as string}</div>
          <div className="ig-node__sub">{data.sublabel as string}</div>
        </div>
      </div>
      {risk && (
        <div className="ig-node__footer">
          <span className={`ig-risk ${risk.cls}`}>{risk.label}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="ig-handle" />
    </div>
  );
}

function ToolNode({ data }: NodeProps) {
  const isOverflow = (data.overflow as boolean) ?? false;
  return (
    <div className={`ig-node ig-node--tool${isOverflow ? " ig-node--overflow" : ""}`}>
      <Handle type="target" position={Position.Left} className="ig-handle" />
      <div className="ig-tag ig-tag--tool">Permission</div>
      <div className="ig-node__row">
        <div className="ig-node__icon ig-node__icon--tool">{isOverflow ? "\u2026" : "\u2699\uFE0F"}</div>
        <span className="ig-node__tool-name mono">{data.label as string}</span>
      </div>
    </div>
  );
}

const nodeTypes = { agent: AgentNode, owner: OwnerNode, system: SystemNode, tool: ToolNode };

// ---- Dagre layout ----

function layoutGraph(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 70, marginx: 30, marginy: 30 });

  for (const node of nodes) {
    const size = NODE_SIZES[node.type ?? "tool"] ?? { w: 155, h: 52 };
    g.setNode(node.id, { width: size.w, height: size.h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    const size = NODE_SIZES[node.type ?? "tool"] ?? { w: 155, h: 52 };
    return { ...node, position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 } };
  });

  return { nodes: layoutedNodes, edges };
}

// ---- Build graph ----

function buildGraph(profile: AgentProfile, permissions: AgentPermission[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const overallAccess = dominantAccess(permissions);

  // Agent
  nodes.push({
    id: "agent",
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      label: profile.name,
      sublabel: `${profile.provider} | ${profile.model}`,
      emoji: profile.emoji || "\uD83E\uDD16",
      dominantAccess: overallAccess,
    },
  });

  // Owner
  if (profile.ownerName) {
    nodes.push({
      id: "owner",
      type: "owner",
      position: { x: 0, y: 0 },
      data: { label: profile.ownerName, sublabel: profile.channels?.[0] || undefined },
    });
    edges.push({
      id: "e-owner-agent",
      source: "owner",
      target: "agent",
      type: "default",
      style: { stroke: "var(--border, #334155)" },
    });
  }

  // Group by category
  const systemMap = new Map<string, AgentPermission[]>();
  for (const perm of permissions) {
    const cat = perm.category || "uncategorized";
    if (!systemMap.has(cat)) systemMap.set(cat, []);
    systemMap.get(cat)!.push(perm);
  }

  const maxTools = 6;
  let si = 0;
  for (const [category, perms] of systemMap) {
    const sysId = `sys-${si}`;
    const dominant = dominantAccess(perms);
    const totalSysCalls = perms.reduce((s, p) => s + p.callCount, 0);

    nodes.push({
      id: sysId,
      type: "system",
      position: { x: 0, y: 0 },
      data: {
        label: fmtCategory(category),
        sublabel: `${perms.length} tool${perms.length !== 1 ? "s" : ""} \u00B7 ${totalSysCalls} calls`,
        access: dominant,
        categoryKey: category,
      },
    });
    edges.push({
      id: `e-agent-${sysId}`,
      source: "agent",
      target: sysId,
      type: "default",
      style: { stroke: "var(--border, #334155)" },
    });

    const visible = perms.slice(0, maxTools);
    const overflow = perms.length - maxTools;

    visible.forEach((perm, ti) => {
      const toolId = `tool-${si}-${ti}`;
      nodes.push({
        id: toolId,
        type: "tool",
        position: { x: 0, y: 0 },
        data: { label: truncate(perm.toolName, 20), access: perm.accessPattern },
      });
      edges.push({
        id: `e-${sysId}-${toolId}`,
        source: sysId,
        target: toolId,
        type: "default",
        style: { stroke: "var(--border, #334155)" },
      });
    });

    if (overflow > 0) {
      const ovId = `tool-${si}-ov`;
      nodes.push({
        id: ovId,
        type: "tool",
        position: { x: 0, y: 0 },
        data: { label: `+${overflow} more`, overflow: true },
      });
      edges.push({
        id: `e-${sysId}-${ovId}`,
        source: sysId,
        target: ovId,
        type: "default",
        style: { stroke: "var(--border, #334155)", strokeDasharray: "4 3" },
      });
    }

    si++;
  }

  return layoutGraph(nodes, edges);
}

// ---- Inner component ----

function IdentityGraphInner({ profile, permissions }: { profile: AgentProfile; permissions: AgentPermission[] }) {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(
    () => buildGraph(profile, permissions),
    [profile, permissions],
  );

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.12 }), 50);
  }, [fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.25}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnDrag
      zoomOnScroll
      className="ig-flow"
    />
  );
}

// ---- Public component ----

export function IdentityGraph({ profile, permissions }: { profile: AgentProfile; permissions: AgentPermission[] }) {
  if (permissions.length === 0) {
    return (
      <div className="ig-wrap ig-wrap--empty">
        <div className="profile-summary__empty">
          No identity connections to display. Permissions data is needed to build the graph.
        </div>
      </div>
    );
  }

  return (
    <div className="ig-wrap">
      <ReactFlowProvider>
        <IdentityGraphInner profile={profile} permissions={permissions} />
      </ReactFlowProvider>
    </div>
  );
}
