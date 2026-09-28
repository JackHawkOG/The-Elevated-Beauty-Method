const historyChangePrefix = "radiant-audit:history-changed:";

export function historyChangeKey(accountId: string): string {
  return `${historyChangePrefix}${accountId}`;
}

export function announceHistoryChange(accountId: string): void {
  if (!accountId) return;
  try {
    // Storage events reach other tabs, not the writer (which updates its own query).
    // A unique value ensures consecutive deletions each trigger an event.
    localStorage.setItem(historyChangeKey(accountId), crypto.randomUUID());
  } catch {
    // Storage can be unavailable; the writer's own query is still updated.
  }
}