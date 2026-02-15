import { Router } from "express";
import { db, agentQueries } from "@og/db";
import { MAX_AGENTS } from "@og/shared";

const agents = agentQueries(db);

export const agentsRouter = Router();

// GET /api/agents
agentsRouter.get("/", async (_req, res, next) => {
  try {
    const data = await agents.findAll();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents
agentsRouter.post("/", async (req, res, next) => {
  try {
    const { name, description, provider, metadata } = req.body;
    if (!name) {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }

    const currentCount = await agents.countAll();
    if (currentCount >= MAX_AGENTS) {
      res.status(403).json({
        success: false,
        error: `Agent limit reached (${MAX_AGENTS}).`,
      });
      return;
    }

    const agent = await agents.create({
      name,
      description: description || null,
      provider: provider || "custom",
      metadata: metadata || {},
    });

    res.status(201).json({ success: true, data: agent });
  } catch (err) {
    next(err);
  }
});

// PUT /api/agents/:id
agentsRouter.put("/:id", async (req, res, next) => {
  try {
    const { name, description, provider, status, metadata } = req.body;
    const agent = await agents.update(req.params.id as string, {
      ...(name && { name }),
      ...(description !== undefined && { description }),
      ...(provider && { provider }),
      ...(status && { status }),
      ...(metadata && { metadata }),
    });

    if (!agent) {
      res.status(404).json({ success: false, error: "Agent not found" });
      return;
    }

    res.json({ success: true, data: agent });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/agents/:id
agentsRouter.delete("/:id", async (req, res, next) => {
  try {
    await agents.delete(req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents/:id/heartbeat
agentsRouter.post("/:id/heartbeat", async (req, res, next) => {
  try {
    await agents.heartbeat(req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
