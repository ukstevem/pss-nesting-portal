import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { nestingRouter } from "./routes/nesting.js";

export function createServer(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Root
  app.get("/", (_req, res) => {
    res.json({
      service: config.API_TITLE,
      version: config.API_VERSION,
      docs: "/api/v1/nesting/",
    });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Nesting API
  app.use("/api/v1/nesting", nestingRouter);

  return app;
}
