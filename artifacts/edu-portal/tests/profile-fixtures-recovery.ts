// Exact-ID opt-in, not a discovery mechanism. Never infer ownership from email.
export function profileCleanupArguments(args: string[]) {
  let deleteRows = false;
  let run: string | undefined;
  const ids: string[] = [];
  const usage = "Usage: cleanup:profile-fixtures [--delete] [--recover-run UUID --id user_ID ...]";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--delete" && !deleteRows) deleteRows = true;
    else if (arg === "--recover-run" && run === undefined) {
      run = args[++i];
      if (!run || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run)) {
        throw new Error(usage);
      }
    } else if (arg === "--id") {
      const id = args[++i];
      if (!id || !/^user_[a-zA-Z0-9]+$/.test(id) || ids.includes(id) || ids.length >= 100) {
        throw new Error(usage);
      }
      ids.push(id);
    } else throw new Error(usage);
  }
  if ((run !== undefined) !== (ids.length > 0)) throw new Error(usage);
  return { deleteRows, recovery: run === undefined ? undefined : { run, ids } };
}