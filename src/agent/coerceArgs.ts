/**
 * Schema-aware coercion of model-supplied tool arguments. Weak/local models pass
 * the right *intent* in the wrong *shape*: an array as a stringified Python list
 * (`"['clear']"`), a boolean as `"true"`, a number as `"3"`, or placeholder
 * strings (`"null"`, `"undefined"`) for omitted optionals — and sometimes the
 * whole arg object double-wrapped under `parameters`/`arguments`/`input`. This
 * pure helper reshapes those against each tool's JSON-schema `parameters` so the
 * tool's `run` receives clean values, instead of erroring on `"['clear']"`.
 *
 * Conservative by design: a value already matching its declared type is left
 * untouched, and an unknown/unschematized property passes through verbatim.
 */

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const PLACEHOLDER_RE = /^(null|undefined|none|nil|n\/a)$/i

function schemaType(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type
}

/** Parse a string the model used for an array: JSON, a Python-ish list, or CSV. */
function toArray(value: string, items: JsonSchema | undefined): unknown[] {
  const trimmed = value.trim()
  if (!trimmed) return []
  // `['a', "b"]` or `["a","b"]` — normalize single quotes to valid JSON.
  if (/^\[.*\]$/s.test(trimmed)) {
    const jsonish = trimmed.replace(/'/g, '"')
    try {
      const parsed = JSON.parse(jsonish)
      if (Array.isArray(parsed)) return parsed.map((el) => coerceScalar(el, items))
    } catch {
      // fall through to CSV
    }
  }
  // Bare comma- or space-separated values: "a, b" / "Bohemian Rhapsody".
  const parts = trimmed.includes(',') ? trimmed.split(',') : [trimmed]
  return parts.map((p) => coerceScalar(p.trim().replace(/^['"]|['"]$/g, ''), items)).filter((p) => p !== '')
}

function toBool(value: string): boolean | null {
  const s = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(s)) return true
  if (['false', 'no', 'off', '0'].includes(s)) return false
  return null
}

/** Coerce one scalar against a leaf schema (used for array items + properties). */
function coerceScalar(value: unknown, schema: JsonSchema | undefined): unknown {
  const type = schemaType(schema)
  if (typeof value === 'string') {
    if (PLACEHOLDER_RE.test(value.trim())) return undefined
    if (type === 'boolean') {
      const b = toBool(value)
      return b === null ? value : b
    }
    if (type === 'number' || type === 'integer') {
      const n = Number(value.trim())
      return value.trim() !== '' && Number.isFinite(n) ? n : value
    }
    if (type === 'array') return toArray(value, schema?.items)
    if (type === 'object') {
      try {
        const parsed = JSON.parse(value)
        return isRecord(parsed) ? parsed : value
      } catch {
        return value
      }
    }
  }
  if (type === 'array' && !Array.isArray(value) && value != null) return [value]
  return value
}

/**
 * Coerce a model-supplied argument object against a tool's parameter schema.
 * Unwraps one layer of `arguments`/`parameters`/`input` if the model nested the
 * real args there, then reshapes each declared property and drops placeholders.
 */
export function coerceArgs(parameters: Record<string, unknown> | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const schema = (parameters ?? {}) as JsonSchema
  const props = schema.properties ?? {}

  // Unwrap an accidental wrapper: `{parameters: {…real args…}}` when none of the
  // wrapper keys are themselves declared properties.
  let source = args
  for (const wrapper of ['arguments', 'parameters', 'input'] as const) {
    const inner = args[wrapper]
    const onlyWrapper = Object.keys(args).length === 1
    if (isRecord(inner) && (onlyWrapper || !(wrapper in props))) {
      source = inner
      break
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const coerced = coerceScalar(value, props[key])
    if (coerced !== undefined) out[key] = coerced
  }
  return out
}
