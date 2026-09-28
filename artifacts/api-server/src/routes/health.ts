import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

let firstHealthcheckReport: (() => void) | undefined;

export function reportAfterFirstHealthcheck(report: () => void): void {
  firstHealthcheckReport = report;
}

router.get("/healthz", (_req, res) => {
  res.once("finish", () => {
    const report = firstHealthcheckReport;
    firstHealthcheckReport = undefined;
    report?.();
  });
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
