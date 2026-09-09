import { Router } from "express";
import { pool } from "../../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  try {
    const dbResult = await pool.query("SELECT NOW()");
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        serverTime: dbResult.rows[0].now,
      },
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      timestamp: new Date().toISOString(),
      database: {
        connected: false,
      },
    });
  }
});
