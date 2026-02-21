import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanAgents, getAgent, getAgentProfile } from "../services/discovery.js";
import { db, agentQueries } from "@og/db";

const agents = agentQueries(db);

export const discoveryRouter = Router();

// GET /api/discovery/agents — list all discovered agents
discoveryRouter.get("/agents", (_req, res, next) => {
  try {
    const agents = scanAgents();
    res.json({ success: true, data: agents });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id — single agent profile
discoveryRouter.get("/agents/:id", (req, res, next) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }
    res.json({ success: true, data: agent });
  } catch (err) {
    next(err);
  }
});

// GET /api/discovery/agents/:id/avatar — serve agent avatar image
discoveryRouter.get("/agents/:id/avatar", (req, res, next) => {
  try {
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
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
        res.setHeader("Content-Type", mimeTypes[ext]);
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

// GET /api/discovery/agents/:id/profile — enriched profile for detail page
discoveryRouter.get("/agents/:id/profile", async (req, res, next) => {
  try {
    const profile = getAgentProfile(req.params.id);
    if (!profile) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }
    // Look up registered agent to get the UUID used in observations.
    // The openclaw-security plugin stores the OpenClaw agent ID (e.g. "main")
    // in metadata.openclawId during registration. Match on that first,
    // then fall back to name match.
    let registeredAgentId: string | null = null;
    try {
      const allRegistered = await agents.findAll();
      const discoveryId = req.params.id;
      const match = allRegistered.find((a: { metadata: unknown }) => {
        const meta = a.metadata as Record<string, unknown> | null;
        return meta?.openclawId === discoveryId;
      }) ?? allRegistered.find((a: { name: string }) => a.name === profile.name);
      registeredAgentId = match?.id ?? null;
    } catch {
      // DB lookup failed — continue without it
    }
    res.json({ success: true, data: { ...profile, registeredAgentId } });
  } catch (err) {
    next(err);
  }
});

// POST /api/discovery/scan — trigger fresh scan
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
    const agent = getAgent(req.params.id);
    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }

    // Build a prompt from agent data
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

    // Try to call the gateway for LLM summary
    const gatewayPort = process.env.GATEWAY_PORT || "8900";
    const gatewayUrl = `http://localhost:${gatewayPort}`;

    // Try Anthropic-style call first
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
      const response = await fetch(`${gatewayUrl}/v1/messages`, {
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
        const text = data.content?.find((c: { type: string }) => c.type === "text")?.text;
        if (text) {
          res.json({ success: true, data: { summary: text } });
          return;
        }
      }
    } catch {
      // Gateway not available, fall through
    }

    // Fallback: generate a static summary from the data
    const skillList = agent.skills.map((s) => s.name).join(", ");
    const systemList = agent.connectedSystems.join(", ");
    const summary = `${agent.name} is an AI agent running on ${agent.provider}/${agent.model}. ` +
      (skillList ? `It has ${agent.skills.length} skill(s): ${skillList}. ` : "It has no registered skills. ") +
      (systemList ? `Connected systems: ${systemList}. ` : "") +
      `It has ${agent.sessionCount} recorded session(s)` +
      (agent.lastActive ? `, last active ${new Date(agent.lastActive).toLocaleDateString()}.` : ".");

    res.json({ success: true, data: { summary } });
  } catch (err) {
    next(err);
  }
});
