// Bound only initialization, never membership writes. Racing a transaction or
// lock query would let an abandoned operation commit or acquire a session lock
// after its caller has released the client.
export const SWEEP_INITIALIZATION_TIMEOUT_MS = 30_000;

export function initializeSweepResource<T>(
  pending: Promise<T>,
  discardLate?: (resource: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Membership review initialization timed out"));
    }, SWEEP_INITIALIZATION_TIMEOUT_MS);
    timer.unref();
    pending.then(
      resource => {
        clearTimeout(timer);
        if (expired) {
          discardLate?.(resource);
        } else {
          resolve(resource);
        }
      },
      error => {
        clearTimeout(timer);
        // This handler also consumes late rejections.
        if (!expired) reject(error);
      },
    );
  });
}