// Pure helpers for the live-feedback toast queue (FIFO, max-N visible).
// Toast: { key, message, level, leaving }. "leaving" toasts are mid fade-out
// and don't count toward the visible cap. Kept free of React/timers so the
// overflow rule can be unit-tested in isolation.

export const MAX_VISIBLE_TOASTS = 3;

// Given the current toasts, return the keys of the OLDEST active (non-leaving)
// toasts that exceed `max` and should start fading out. Empty when within cap.
export function overflowKeys(toasts, max = MAX_VISIBLE_TOASTS) {
  if (!Array.isArray(toasts)) return [];
  const active = toasts.filter((t) => t && !t.leaving);
  if (active.length <= max) return [];
  return active.slice(0, active.length - max).map((t) => t.key);
}
