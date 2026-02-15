import { Router } from "express";
import { db, policyQueries } from "@og/db";

const policies = policyQueries(db);

export const policiesRouter = Router();

// GET /api/policies
policiesRouter.get("/", async (_req, res, next) => {
  try {
    const data = await policies.findAll();
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// POST /api/policies
policiesRouter.post("/", async (req, res, next) => {
  try {
    const { name, description, scannerIds, action, sensitivityThreshold } = req.body;
    if (!name || !scannerIds || !action) {
      res.status(400).json({ success: false, error: "name, scannerIds, and action are required" });
      return;
    }

    const policy = await policies.create({
      name,
      description: description || null,
      scannerIds,
      action,
      sensitivityThreshold,
    });

    res.status(201).json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
});

// PUT /api/policies/:id
policiesRouter.put("/:id", async (req, res, next) => {
  try {
    const policy = await policies.update(req.params.id as string, req.body);
    if (!policy) {
      res.status(404).json({ success: false, error: "Policy not found" });
      return;
    }
    res.json({ success: true, data: policy });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/policies/:id
policiesRouter.delete("/:id", async (req, res, next) => {
  try {
    await policies.delete(req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
