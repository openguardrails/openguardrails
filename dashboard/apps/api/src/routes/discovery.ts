import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanAgents, getAgentProfile } from "../services/discovery.js";
import type { DiscoveredAgent, AgentProfile } from "../services/discovery.js";
import { db, agentQueries } from "@og/db";

const agentsDb = agentQueries(db);

export const discoveryRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

type StoredMeta = {
  openclawId?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;
  model?: string;
  provider?: string;
  ownerName?: string;
  skills?: { name: string; description?: string }[];
  plugins?: { name: string; enabled: boolean }[];
  hooks?: { name: string; enabled: boolean }[];
  connectedSystems?: string[];
  channels?: string[];
  sessionCount?: number;
  lastActive?: string | null;
  workspaceFiles?: {
    soul?: string;
    identity?: string;
    user?: string;
    agents?: string;
    tools?: string;
    heartbeat?: string;
  };
  bootstrapExists?: boolean;
  cronJobs?: unknown[];
};

function registeredToDiscovered(a: {
  id: string;
  name: string;
  provider: string;
  status: string;
  lastSeenAt: string | null;
  metadata: unknown;
}): DiscoveredAgent {
  const m = (a.metadata ?? {}) as StoredMeta;
  return {
    id: m.openclawId ?? a.id,
    name: a.name,
    emoji: m.emoji ?? "🤖",
    creature: m.creature ?? "",
    vibe: m.vibe ?? "",
    model: m.model ?? "",
    provider: m.provider ?? a.provider,
    workspacePath: "",
    ownerName: m.ownerName ?? "",
    avatarUrl: null,
    skills: m.skills ?? [],
    connectedSystems: m.connectedSystems ?? [],
    channels: m.channels ?? [],
    plugins: m.plugins ?? [],
    hooks: m.hooks ?? [],
    sessionCount: m.sessionCount ?? 0,
    lastActive: m.lastActive ?? a.lastSeenAt,
  };
}

function registeredToProfile(a: {
  id: string;
  name: string;
  provider: string;
  status: string;
  lastSeenAt: string | null;
  metadata: unknown;
}): AgentProfile {
  const m = (a.metadata ?? {}) as StoredMeta;
  const wf = m.workspaceFiles ?? {};
  return {
    ...registeredToDiscovered(a),
    workspaceFiles: {
      soul: wf.soul ?? "",
      identity: wf.identity ?? "",
      user: wf.user ?? "",
      agents: wf.agents ?? "",
      tools: wf.tools ?? "",
      heartbeat: wf.heartbeat ?? "",
    },
    bootstrapExists: m.bootstrapExists ?? false,
    cronJobs: (m.cronJobs as AgentProfile["cronJobs"]) ?? [],
    allSkills: (m.skills ?? []).map((s) => ({ ...s, source: "workspace" as const })),
    bundledExtensions: [],
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/discovery/agents — list all agents (DB primary, filesystem fallback)
discoveryRouter.get("/agents", async (_req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const registered = await agentsDb.findAll(tenantId);

    if (registered.length > 0) {
      res.json({ success: true, data: registered.map(registeredToDiscovered) });
      return;
    }

    // Fallback: local filesystem scan (self-hosted, same machine)
    const discovered = scanAgents();
    res.json({ success: true, data: discovered });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id — single agent (DB primary, filesystem fallback)
discoveryRouter.get("/agents/:id", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const id = req.params.id as string;
    const registered = await agentsDb.findAll(tenantId);

    // Match by openclawId (from plugin) or DB id
    const match = registered.find((a: { id: string; metadata: unknown }) => {
      const meta = (a.metadata ?? {}) as StoredMeta;
      return meta.openclawId === id || a.id === id;
    });

    if (match) {
      res.json({ success: true, data: registeredToDiscovered(match) });
      return;
    }

    // Fallback: filesystem
    const { getAgent } = await import("../services/discovery.js");
    const agent = getAgent(id);
    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }
    res.json({ success: true, data: agent });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id/avatar — serve agent avatar image (filesystem only)
discoveryRouter.get("/agents/:id/avatar", (req, res, next) => {
  try {
    const { getAgent } = require("../services/discovery.js") as typeof import("../services/discovery.js");
    const agent = getAgent(req.params.id as string);
    if (!agent || !agent.workspacePath) {
      res.status(404).json({ success: false, error: "No avatar found" });
      return;
    }

    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      svg: "image/svg+xml",
      webp: "image/webp",
    };

    for (const ext of Object.keys(mimeTypes)) {
      const avatarPath = join(agent.workspacePath, `avatar.${ext}`);
      if (existsSync(avatarPath)) {
        const data = readFileSync(avatarPath);
        res.setHeader("Content-Type", mimeTypes[ext]!);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.send(data);
        return;
      }
    }

    res.status(404).json({ success: false, error: "No avatar found" });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id/profile — enriched profile (DB primary, filesystem fallback)
discoveryRouter.get("/agents/:id/profile", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const id = req.params.id as string;
    const registered = await agentsDb.findAll(tenantId);

    const match = registered.find((a: { id: string; metadata: unknown }) => {
      const meta = (a.metadata ?? {}) as StoredMeta;
      return meta.openclawId === id || a.id === id;
    });

    if (match) {
      const profile = registeredToProfile(match);
      res.json({ success: true, data: { ...profile, registeredAgentId: match.id } });
      return;
    }

    // Fallback: filesystem
    const profile = getAgentProfile(id);
    if (!profile) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }
    // Also try to find registeredAgentId from DB by name
    const byName = registered.find((a: { id: string; name: string }) => a.name === profile.name);
    res.json({ success: true, data: { ...profile, registeredAgentId: byName?.id ?? null } });
  } catch (err) {
    next(err);
  }
});

// POST /api/discovery/scan — trigger fresh scan (filesystem only, for local installs)
discoveryRouter.post("/scan", (_req, res, next) => {
  try {
    const agents = scanAgents();
    res.json({ success: true, data: agents });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id/summary — LLM-generated summary
discoveryRouter.get("/agents/:id/summary", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const id = req.params.id as string;
    const registered = await agentsDb.findAll(tenantId);

    const match = registered.find((a: { id: string; metadata: unknown }) => {
      const meta = (a.metadata ?? {}) as StoredMeta;
      return meta.openclawId === id || a.id === id;
    });

    const agent: DiscoveredAgent | null = match
      ? registeredToDiscovered(match)
      : (() => { const { getAgent } = require("../services/discovery.js") as typeof import("../services/discovery.js"); return getAgent(id) ?? null; })();

    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }

    const prompt = `Summarize this AI agent in 2-3 concise paragraphs for a security dashboard:

Name: ${agent.name} ${agent.emoji}
Creature: ${agent.creature}
Vibe: ${agent.vibe}
Model: ${agent.provider}/${agent.model}
Skills: ${agent.skills.map((s) => s.name).join(", ") || "none"}
Connected Systems: ${agent.connectedSystems.join(", ") || "none"}
Channels: ${agent.channels.join(", ") || "none"}
Plugins: ${agent.plugins.map((p) => `${p.name}${p.enabled ? "" : " (disabled)"}`).join(", ") || "none"}
Hooks: ${agent.hooks.map((h) => `${h.name}${h.enabled ? "" : " (disabled)"}`).join(", ") || "none"}
Sessions: ${agent.sessionCount}
Last Active: ${agent.lastActive || "unknown"}

Focus on: what this agent does, its capabilities, connected systems and potential security surface area. Keep it factual and useful for a security team.`;

    const gatewayPort = process.env.GATEWAY_PORT || "8900";
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY || "not-set";
      const response = await fetch(`http://localhost:${gatewayPort}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 500,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const data = await response.json() as { content?: { type: string; text: string }[] };
        const text = data.content?.find((c) => c.type === "text")?.text;
        if (text) {
          res.json({ success: true, data: { summary: text } });
          return;
        }
      }
    } catch {
      // Gateway not available, fall through to static summary
    }

    const skillList = agent.skills.map((s) => s.name).join(", ");
    const systemList = agent.connectedSystems.join(", ");
    const summary =
      `${agent.name} is an AI agent running on ${agent.provider}/${agent.model}. ` +
      (skillList ? `It has ${agent.skills.length} skill(s): ${skillList}. ` : "It has no registered skills. ") +
      (systemList ? `Connected systems: ${systemList}. ` : "") +
      `It has ${agent.sessionCount} recorded session(s)` +
      (agent.lastActive ? `, last active ${new Date(agent.lastActive).toLocaleDateString()}.` : ".");

    res.json({ success: true, data: { summary } });
  } catch (err) {
    next(err);
  }
});
