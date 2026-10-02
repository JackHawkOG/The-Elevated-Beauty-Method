import { Storage } from "@google-cloud/storage";
import type { SweepFailure } from "./membership-sweep-health";

export interface SweepHealthStore {
  read(): Promise<SweepFailure | null>;
  update(change: (current: SweepFailure | null) => SweepFailure | null): Promise<SweepFailure | null>;
}

// This is an internal operational blob, never a member upload or a public asset.
// It has no serving route, ACL grant, member identifiers or payment information.
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
  retryOptions: { totalTimeout: 5, maxRetries: 2 },
});

export function decodeSweepHealth(text: string): SweepFailure | null {
  const value: unknown = JSON.parse(text);
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sweep health record");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "consecutiveFailures,firstFailedAt,lastFailedAt" ||
      !Number.isSafeInteger(row.consecutiveFailures) || (row.consecutiveFailures as number) < 1 ||
      typeof row.firstFailedAt !== "string" || typeof row.lastFailedAt !== "string" ||
      !Number.isFinite(Date.parse(row.firstFailedAt)) || !Number.isFinite(Date.parse(row.lastFailedAt)) ||
      Date.parse(row.lastFailedAt) < Date.parse(row.firstFailedAt)) {
    throw new Error("Invalid sweep health record");
  }
  return {
    consecutiveFailures: row.consecutiveFailures as number,
    firstFailedAt: row.firstFailedAt,
    lastFailedAt: row.lastFailedAt,
  };
}

export type HealthSnapshot = { generation: string | number; failure: SweepFailure | null };
export interface HealthBlob {
  read(): Promise<HealthSnapshot>;
  write(failure: SweepFailure | null, generation: string | number): Promise<void>;
}
const hasCode = (err: unknown, code: number) =>
  typeof err === "object" && err !== null && "code" in err && Number(err.code) === code;

// Exposed for isolated tests of conflict retries; production uses only GCS.
export class DurableSweepHealthStore implements SweepHealthStore {
  constructor(private readonly blob: HealthBlob) {}
  async read(): Promise<SweepFailure | null> {
    return (await this.blob.read()).failure;
  }
  async update(change: (current: SweepFailure | null) => SweepFailure | null): Promise<SweepFailure | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.blob.read();
      const next = change(snapshot.failure);
      // Validate and project the outgoing record as well as incoming records.
      const failure = decodeSweepHealth(JSON.stringify(next));
      try {
        await this.blob.write(failure, snapshot.generation);
        return failure;
      } catch (err) {
        if (!hasCode(err, 412)) throw err;
      }
    }
    throw new Error("Sweep health update conflicted repeatedly");
  }
}

function healthFile() {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  const match = dir?.match(/^\/([^/]+)\/(.+?)\/?$/);
  if (!match) throw new Error("Private operational health storage is not configured");
  // Never share development failures with the deployed staff warning.
  const environment = process.env.NODE_ENV === "production" ? "production" : "development";
  return storage.bucket(match[1]).file(`${match[2]}/operational-health/${environment}/membership-sweep.json`);
}

export const independentSweepHealthStore = new DurableSweepHealthStore({
  async read() {
    const file = healthFile();
    for (let attempt = 0; attempt < 5; attempt++) {
      let generation: string;
      try {
        const [metadata] = await file.getMetadata();
        if (!metadata.generation) throw new Error("Missing sweep health generation");
        generation = String(metadata.generation);
      } catch (err) {
        if (hasCode(err, 404)) return { generation: 0, failure: null };
        throw err;
      }
      try {
        // Pin the bytes to the generation read above. Never pair new bytes
        // with an old generation when another server updates the record.
        const [bytes] = await file.bucket.file(file.name, { generation }).download();
        return { generation, failure: decodeSweepHealth(bytes.toString("utf8")) };
      } catch (err) {
        if (!hasCode(err, 404)) throw err;
      }
    }
    throw new Error("Sweep health changed repeatedly during read");
  },
  async write(failure, generation) {
    await healthFile().save(JSON.stringify(failure), {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: generation },
      metadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  },
});