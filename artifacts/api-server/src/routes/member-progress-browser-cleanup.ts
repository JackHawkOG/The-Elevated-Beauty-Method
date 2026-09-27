type CleanupStep = { name: string; run: () => Promise<unknown> };

function description(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keep the check's failure first, while still trying every independent cleanup step.
export async function runWithCleanup<T>(
  check: () => Promise<T>,
  cleanup: () => CleanupStep[],
): Promise<T> {
  let result!: T;
  let checkFailed = false;
  let checkError: unknown;
  try {
    result = await check();
  } catch (error) {
    checkFailed = true;
    checkError = error;
  }

  const cleanupErrors: Error[] = [];
  let steps: CleanupStep[] = [];
  try {
    steps = cleanup();
  } catch (error) {
    cleanupErrors.push(new Error(`Prepare cleanup: ${description(error)}`, { cause: error }));
  }
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      cleanupErrors.push(new Error(`${step.name}: ${description(error)}`, { cause: error }));
    }
  }

  if (checkFailed && cleanupErrors.length) {
    throw new AggregateError(
      [checkError, ...cleanupErrors],
      `Browser check failed: ${description(checkError)}; cleanup failed: ${cleanupErrors.map(description).join("; ")}`,
    );
  }
  if (checkFailed) throw checkError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Browser check cleanup failed: ${cleanupErrors.map(description).join("; ")}`);
  }
  return result;
}