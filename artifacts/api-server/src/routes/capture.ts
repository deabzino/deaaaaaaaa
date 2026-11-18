import express, { Router } from "express";
import { captureRegistry, type CaptureRegistry } from "../among-us/registry";

export function createCaptureRouter(registry: CaptureRegistry = captureRegistry) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "16kb" }));

  router.post("/pair", (req, res) => {
    const token = registry.exchange(req.body?.code);
    if (!token) {
      res.status(401).json({ error: "Pairing code is invalid, expired, or already used." });
      return;
    }
    res.json({ token });
  });
  router.post("/events", (req, res) => {
    res.sendStatus(registry.receive(req.get("authorization"), req.body, false, req.get("x-capture-resync") === "1"));
  });
  router.post("/heartbeat", (req, res) => {
    res.sendStatus(registry.receive(req.get("authorization"), undefined, true));
  });
  return router;
}
