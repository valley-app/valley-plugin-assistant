/**
 * Pure gitignore-style path matching for the Guard file policy. Shared by the
 * renderer (UX) and main (enforcement) so an allowed/blocked decision can never
 * diverge between the two.
 *
 * NOTE: this is *not* the prefix-based exclusion matcher in
 * `src/main/modules/search/linkIndex.ts` (which lowercases + matches directory prefixes for
 * the search index). This one supports real globs (`**`, `*`, `?`) for the guard's
 * `allowedToVisit` / `allowedToWrite` / `blocked` lists. Matching is
 * case-insensitive so a block can't be bypassed by case on a case-insensitive
 * filesystem (macOS).
 */

/** Lowercase, normalize separators, strip leading `./`/`/` and trailing `/`, collapse `//`. */
function normalize(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function hasGlob(p: string): boolean {
  return /[*?]/.test(p)
}

const GLOB_CACHE = new Map<string, RegExp>()

function globToRegExp(pattern: string): RegExp {
  const cached = GLOB_CACHE.get(pattern)
  if (cached) return cached
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — any number of path segments (including zero). When followed by a
        // separator, the separator is optional so `a/**` matches `a` and `a/b/c`.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        // single `*` — anything within one path segment.
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  const compiled = new RegExp(`^${re}$`)
  GLOB_CACHE.set(pattern, compiled)
  return compiled
}

/**
 * Does `relPath` match `pattern`? Glob patterns (`**`/`*`/`?`) use regex; a
 * glob-free pattern matches the path exactly *or* as a directory prefix
 * (`pattern` or `pattern/...`), so a bare folder like `.git` blocks its subtree.
 */
export function matchPath(pattern: string, relPath: string): boolean {
  const p = normalize(pattern)
  const r = normalize(relPath)
  if (!p) return false
  if (!hasGlob(p)) return r === p || r.startsWith(`${p}/`)
  return globToRegExp(p).test(r)
}

/** True if `relPath` matches any pattern in the list. */
export function matchAny(patterns: readonly string[], relPath: string): boolean {
  return patterns.some((p) => matchPath(p, relPath))
}

/** Reject `..` traversal segments (defence in depth; main also calls `resolveInVault`). */
export function hasTraversal(relPath: string): boolean {
  return normalize(relPath)
    .split('/')
    .some((seg) => seg === '..')
}
