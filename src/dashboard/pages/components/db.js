/**
 * DuckDB singleton helper.
 *
 * `getDB(key, factory)` returns a cached DuckDB client for the given key,
 * calling `factory()` only on the first invocation for that key.
 *
 * Observable Framework v1.13.3 performs full page reloads on navigation, so
 * the cache only persists within a single page view (same as calling
 * DuckDBClient.of() directly).  If Observable Framework adds client-side
 * navigation in a future version, this singleton will automatically start
 * surviving cross-page navigations and DuckDB will only be initialised once
 * per session.
 *
 * Usage in a page:
 *
 *   import { getDB } from "./components/db.js";
 *   const db = await getDB("my-page", () => DuckDBClient.of({
 *     my_table: FileAttachment("data/my_table.parquet"),
 *   }));
 */

const _cache = new Map();

export function getDB(key, factory) {
  if (!_cache.has(key)) _cache.set(key, factory());
  return _cache.get(key);
}
