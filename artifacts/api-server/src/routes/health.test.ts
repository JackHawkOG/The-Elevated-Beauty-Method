import { afterEach, expect, test } from "vitest";
import express from "express";
import router, { reportAfterFirstHealthcheck } from "./health";

afterEach(() => reportAfterFirstHealthcheck(() => {}));

test("reports the startup result once after health responds without exposing it", async () => {
  const app = express();
  app.use("/api", router);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server");
    const reports: string[] = [];
    reportAfterFirstHealthcheck(() => reports.push("repairedIds: [2]"));
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    }
    expect(reports).toEqual(["repairedIds: [2]"]);
  } finally {
    server.close();
  }
});