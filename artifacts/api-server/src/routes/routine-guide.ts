import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type IRouter } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  ClaimRoutineGuideBody,
  ClaimRoutineGuideResponse,
  GetRoutineGuideResponse,
  ListDigitalGuidesResponse,
} from "@workspace/api-zod";
import {
  ROUTINE_GUIDE_CONSENT,
  ROUTINE_GUIDE_PAGE_COUNT,
  ROUTINE_GUIDE_PRIVACY_NOTICE,
  ROUTINE_GUIDE_PROCESSING_MESSAGE,
  ROUTINE_GUIDE_RESPONSE_MESSAGE,
  ROUTINE_GUIDE_TITLE,
  ROUTINE_GUIDE_VERSION,
  routineGuideClaimStore,
  type GuideClaimStore,
} from "../lib/routine-guide-delivery";

const EXPECTED_PDF_SHA256 = "d52221527813a33ad7e6c90e3071b3b4927ae0d95cf6b7eac9c20e99147b4f44";
const FROM = "The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>";
const REPLY_TO = "hello@elevatedbeautymethod.com";
const ATTACHMENT_NAME = "the-elevated-routine.pdf";
const EMAIL_TIMEOUT_MS = 20_000;
const connectors = new ReplitConnectors();

type SenderOutcome = "accepted" | "rejected" | "uncertain" | "preflight_failure";

export interface RoutineGuideDependencies {
  store?: GuideClaimStore;
  attachmentPath?: string;
  publishedInLibrary?: boolean;
  send?: (email: string, idempotencyKey: string) => Promise<SenderOutcome>;
}

function runtimeAttachmentPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "private-assets", ATTACHMENT_NAME),
    path.resolve(moduleDir, "../../private-assets", ATTACHMENT_NAME),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!;
}

function guideInfo(publishedInLibrary = false) {
  return GetRoutineGuideResponse.parse({
    title: ROUTINE_GUIDE_TITLE,
    consentText: ROUTINE_GUIDE_CONSENT,
    privacyNotice: ROUTINE_GUIDE_PRIVACY_NOTICE,
    version: ROUTINE_GUIDE_VERSION,
    pageCount: ROUTINE_GUIDE_PAGE_COUNT,
    available: true,
    publishedInLibrary,
  });
}

export function createRoutineGuideSender(
  attachmentPath = runtimeAttachmentPath(),
  proxy: typeof connectors.proxy = connectors.proxy.bind(connectors),
): (email: string, idempotencyKey: string) => Promise<SenderOutcome> {
  return async (email, idempotencyKey): Promise<SenderOutcome> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(attachmentPath);
    } catch {
      return "preflight_failure";
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== EXPECTED_PDF_SHA256) {
      return "preflight_failure";
    }

    const payload = {
      from: FROM,
      to: [email],
      reply_to: REPLY_TO,
      subject: "The Elevated Routine",
      text: "Here is The Elevated Routine from The Elevated Beauty Method ™, attached as requested.\n\nYou requested this guide only. You have not been subscribed to marketing emails.\n\nFor questions or requests to remove your guide-request records, reply to this email.",
      attachments: [{
        filename: ATTACHMENT_NAME,
        content: bytes.toString("base64"),
      }],
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = proxy("resend", "/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: payload,
    }).then(async response => {
      await response.text();
      if (response.ok) return "accepted" as const;
      if (response.status >= 500 || response.status === 408) return "uncertain" as const;
      return "rejected" as const;
    });
    const timedOut = new Promise<SenderOutcome>(resolve => {
      timeout = setTimeout(() => resolve("uncertain"), EMAIL_TIMEOUT_MS);
      timeout.unref?.();
    });
    try {
      return await Promise.race([request, timedOut]);
    } catch {
      return "uncertain";
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

export function createRoutineGuideRouter(dependencies: RoutineGuideDependencies = {}): IRouter {
  const router = Router();
  const store = dependencies.store ?? routineGuideClaimStore;
  const attachmentPath = dependencies.attachmentPath ?? runtimeAttachmentPath();
  const send = dependencies.send ?? createRoutineGuideSender(attachmentPath);
  const publishedInLibrary = dependencies.publishedInLibrary ??
    process.env.ROUTINE_GUIDE_LIBRARY_PUBLISHED === "true";

  router.get("/routine-guide", (_req, res): void => {
    res.setHeader("Cache-Control", "no-store");
    res.json(guideInfo(publishedInLibrary));
  });

  router.get("/digital-guides", (_req, res): void => {
    res.setHeader("Cache-Control", "no-store");
    res.json(ListDigitalGuidesResponse.parse(publishedInLibrary ? [guideInfo(true)] : []));
  });

  router.post("/routine-guide/claim", async (req, res): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const raw = req.body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      res.status(400).json({ error: "Please provide a valid email, explicit consent, and request ID." });
      return;
    }
    const candidate = raw as Record<string, unknown>;
    const emailValue = candidate.email;
    if (typeof emailValue === "string" && emailValue.length > 254) {
      res.status(400).json({ error: "Please provide a valid email and explicitly consent to guide-only delivery." });
      return;
    }
    const normalizedEmail = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : emailValue;
    const parsed = ClaimRoutineGuideBody.safeParse({ ...candidate, email: normalizedEmail });
    if (!parsed.success || parsed.data.consent !== true || (parsed.data.website ?? "") !== "") {
      res.status(400).json({ error: "Please provide a valid email and explicitly consent to guide-only delivery." });
      return;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let reservation;
    try {
      reservation = await store.reserve({
        requestId: parsed.data.requestId,
        email: normalizedEmail as string,
        ip,
      });
    } catch {
      req.log.error("Routine guide claim could not be reserved");
      res.status(503).json({ error: "We could not process this guide request. Please try again shortly." });
      return;
    }

    if (reservation.kind === "conflict") {
      res.status(409).json({ error: "This request ID was already used for a different guide request." });
      return;
    }
    if (reservation.kind === "rate_limited") {
      res.status(429).json({ error: "Too many guide requests. Please try again later." });
      return;
    }
    if (reservation.kind === "ambiguous_expired") {
      res.status(503).json({ error: "We could not safely confirm the earlier attempt. Please contact hello@elevatedbeautymethod.com." });
      return;
    }
    if (reservation.kind === "processing") {
      res.status(202).json(ClaimRoutineGuideResponse.parse({
        status: "processing",
        message: ROUTINE_GUIDE_PROCESSING_MESSAGE,
      }));
      return;
    }
    if (reservation.kind === "sent") {
      res.status(200).json(ClaimRoutineGuideResponse.parse({
        status: "sent",
        message: ROUTINE_GUIDE_RESPONSE_MESSAGE,
      }));
      return;
    }

    let outcome: SenderOutcome;
    try {
      outcome = await send(normalizedEmail as string, reservation.providerIdempotencyKey);
    } catch {
      outcome = "uncertain";
    }
    try {
      if (outcome === "accepted") {
        await store.markAccepted(normalizedEmail as string, reservation.providerIdempotencyKey);
        res.status(200).json(ClaimRoutineGuideResponse.parse({
          status: "sent",
          message: ROUTINE_GUIDE_RESPONSE_MESSAGE,
        }));
        return;
      }
      if (outcome === "rejected") {
        await store.markRejected(normalizedEmail as string, reservation.providerIdempotencyKey);
        res.status(503).json({ error: "The email provider did not accept the request. Please try again shortly." });
        return;
      }
      if (outcome === "preflight_failure") {
        await store.markRejected(normalizedEmail as string, reservation.providerIdempotencyKey);
        res.status(503).json({ error: "The private guide attachment is unavailable. Please try again later." });
        return;
      }
      await store.markUncertain(normalizedEmail as string, reservation.providerIdempotencyKey);
      res.status(503).json({ error: "The email provider response was uncertain. Retry safely using the same request ID." });
    } catch {
      req.log.error("Routine guide delivery state could not be recorded");
      res.status(503).json({ error: "We could not confirm this guide request. Please retry safely using the same request ID." });
    }
  });

  return router;
}

export default createRoutineGuideRouter();