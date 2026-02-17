import { Router } from "express";
import { db, scannerQueries } from "@og/db";

const scanners = scannerQueries(db);

export const scannersRouter = Router();

// GET /api/scanners
scannersRouter.get("/", async (_req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const data = await scanners.getAll(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// PUT /api/scanners
scannersRouter.put("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const updates = req.body as Array<{
      scannerId: string;
      name: string;
      description: string;
      isEnabled: boolean;
    }>;

    if (!Array.isArray(updates)) {
      res.status(400).json({ success: false, error: "Request body must be an array of scanner updates" });
      return;
    }

    for (const update of updates) {
      await scanners.upsert({
        scannerId: update.scannerId,
        name: update.name,
        description: update.description,
        isEnabled: update.isEnabled,
        tenantId,
      });
    }

    const data = await scanners.getAll(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
