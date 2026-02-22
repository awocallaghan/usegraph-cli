import { useState, useEffect } from 'react';

// ─── formatDate ───────────────────────────────────────────────────────────────

/**
 * Format a Date as a human-readable string.
 *
 * @example
 *   formatDate(new Date('2024-01-15'))        // "January 15, 2024"
 *   formatDate(new Date('2024-01-15'), 'short') // "Jan 15, 2024"
 */
export function formatDate(
  date: Date,
  style: 'long' | 'short' | 'numeric' = 'long',
  locale = 'en-US',
): string {
  const opts: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : style === 'short'
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}

// ─── formatCurrency ───────────────────────────────────────────────────────────

/**
 * Format an integer amount (in cents/minor units) as a currency string.
 *
 * @example
 *   formatCurrency(9900)          // "$99.00"
 *   formatCurrency(9900, 'EUR')   // "€99.00"
 *   formatCurrency(130000, 'GBP') // "£1,300.00"
 */
export function formatCurrency(
  amountInCents: number,
  currency = 'USD',
  locale = 'en-US',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountInCents / 100);
}

// ─── debounce ─────────────────────────────────────────────────────────────────

/**
 * Returns a debounced version of `fn` that delays invocation by `delay` ms.
 * The timer resets on every call. The debounced function exposes a `.cancel()`
 * method to clear any pending invocation.
 *
 * @example
 *   const save = debounce((value: string) => api.save(value), 500);
 *   input.addEventListener('input', e => save(e.target.value));
 */
export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  fn: T,
  delay: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = function (this: unknown, ...args: Parameters<T>) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delay);
  } as T & { cancel: () => void };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}

// ─── useLocalStorage ──────────────────────────────────────────────────────────

/**
 * React hook that synchronises state with `localStorage`.
 *
 * - Reads the initial value from `localStorage[key]` (JSON-parsed).
 * - Falls back to `defaultValue` when the key is absent or the stored value
 *   cannot be parsed.
 * - Writes back to `localStorage` whenever the value changes.
 * - Listens for `storage` events so multiple tabs stay in sync.
 *
 * @example
 *   const [theme, setTheme] = useLocalStorage('theme', 'light');
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [stored, setStored] = useState<T>(() => {
    try {
      const raw = typeof window !== 'undefined'
        ? window.localStorage.getItem(key)
        : null;
      return raw !== null ? (JSON.parse(raw) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // quota exceeded or private browsing — ignore
    }
  }, [key, stored]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== key) return;
      try {
        const next = event.newValue !== null
          ? (JSON.parse(event.newValue) as T)
          : defaultValue;
        setStored(next);
      } catch {
        // unparseable value from another tab — ignore
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, defaultValue]);

  return [stored, setStored];
}
