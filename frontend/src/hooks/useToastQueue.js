// Live-feedback toast queue hook.
//   - new toasts enter at the bottom (newest last in the array) and the stack
//     grows upward; the oldest sits at the top and fades out first (FIFO)
//   - at most MAX_VISIBLE_TOASTS are shown; a 4th marks the oldest as "leaving"
//   - each toast auto-dismisses after TTL_MS (fade-out via the "leaving" flag)
//   - identical messages are throttled to once per DEDUPE_MS (anti-spam: e.g.
//     a persistent gaze warning re-appears at most every 5s, not every frame)

import { useCallback, useEffect, useRef, useState } from "react";
import { overflowKeys, MAX_VISIBLE_TOASTS } from "../utils/toastQueue";

const TTL_MS = 3500; // how long a toast stays before fading out
const EXIT_MS = 320; // fade-out animation duration before removal
// Throttle identical warnings: the same message re-appears at most once per
// this window (예: 시선 이탈이 계속돼도 5초 간격으로만 다시 뜬다).
const DEDUPE_MS = 5000;

export function useToastQueue() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const lastEmitRef = useRef(new Map()); // message -> performance.now()
  const timersRef = useRef(new Map()); // key -> { ttl, exit }

  const clearTimers = useCallback((key) => {
    const timers = timersRef.current.get(key);
    if (timers) {
      if (timers.ttl) clearTimeout(timers.ttl);
      if (timers.exit) clearTimeout(timers.exit);
      timersRef.current.delete(key);
    }
  }, []);

  const remove = useCallback(
    (key) => {
      setToasts((prev) => prev.filter((toast) => toast.key !== key));
      clearTimers(key);
    },
    [clearTimers],
  );

  const markLeaving = useCallback(
    (key) => {
      setToasts((prev) =>
        prev.map((toast) => (toast.key === key ? { ...toast, leaving: true } : toast)),
      );
      const exit = setTimeout(() => remove(key), EXIT_MS);
      const timers = timersRef.current.get(key) || {};
      timers.exit = exit;
      timersRef.current.set(key, timers);
    },
    [remove],
  );

  const push = useCallback(
    (message, level = "info") => {
      if (!message) return;
      const now = typeof performance !== "undefined" ? performance.now() : 0;
      const last = lastEmitRef.current.get(message);
      if (last != null && now - last < DEDUPE_MS) return; // dedupe / anti-spam
      lastEmitRef.current.set(message, now);

      const key = `toast-${idRef.current}`;
      idRef.current += 1;
      setToasts((prev) => [...prev, { key, message, level, leaving: false }]);

      const ttl = setTimeout(() => markLeaving(key), TTL_MS);
      timersRef.current.set(key, { ttl });
    },
    [markLeaving],
  );

  // Enforce the visible cap declaratively: whenever too many are active, fade
  // out the oldest. Runs after render so push() stays free of state-derived logic.
  useEffect(() => {
    const overflow = overflowKeys(toasts, MAX_VISIBLE_TOASTS);
    overflow.forEach((key) => markLeaving(key));
  }, [toasts, markLeaving]);

  const clear = useCallback(() => {
    timersRef.current.forEach((timers) => {
      if (timers.ttl) clearTimeout(timers.ttl);
      if (timers.exit) clearTimeout(timers.exit);
    });
    timersRef.current.clear();
    lastEmitRef.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => () => clear(), [clear]);

  return { toasts, push, clear };
}
