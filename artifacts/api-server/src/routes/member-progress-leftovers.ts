const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CATEGORY = new RegExp(`^browser-progress-(${UUID})$`, "i");
const EMAIL = new RegExp(`^progress-([01])-(${UUID})@example\\.com$`, "i");
export const MIN_AGE_MS = 60 * 60 * 1000;

export type Candidate = {
  kind: "category" | "clerk" | "member";
  id: string;
  run: string;
  createdAt: Date;
  marker: string;
  name?: string;
};

export function categoryRun(slug: string, name: string): string | undefined {
  const run = CATEGORY.exec(slug)?.[1]?.toLowerCase();
  return run && name === `Browser progress ${run}` ? run : undefined;
}

export function identityRun(email: string, name: string): string | undefined {
  const match = EMAIL.exec(email);
  const run = match?.[2]?.toLowerCase();
  return run && name === `Progress ${match![1] === "0" ? "Elevated" : "Free"} ${run}`
    ? run : undefined;
}

export function staleCandidates(candidates: Candidate[], now: Date, ageMs = MIN_AGE_MS): Candidate[] {
  if (!Number.isFinite(ageMs) || ageMs < MIN_AGE_MS) throw new Error("Minimum age is one hour");
  return candidates.filter(candidate =>
    Number.isFinite(candidate.createdAt.getTime()) &&
    candidate.createdAt.getTime() <= now.getTime() - ageMs &&
    (candidate.kind === "category"
      ? categoryRun(candidate.marker, candidate.name || "") === candidate.run
      : identityRun(candidate.marker, candidate.name || "") === candidate.run));
}

export function eligibleRun(candidates: Candidate[], now: Date, run: string): Candidate[] {
  const selected = candidates.filter(candidate => candidate.run === run);
  if (!selected.length || staleCandidates(selected, now).length !== selected.length) {
    throw new Error("No fully stale run found; refusing to delete recent or unmatched records");
  }
  return selected;
}

export function confirmedRun(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 3 || args[0] !== "--delete" || args[2] !== args[1] ||
      !new RegExp(`^${UUID}$`).test(args[1])) {
    throw new Error("To delete, pass --delete <run-uuid> <same-run-uuid> after inspecting the dry run");
  }
  return args[1];
}