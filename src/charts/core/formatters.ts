// ============================================================================
// Formatters — ported from the reference implementation's chart formatters / GeneralFunctions,
// trimmed of finance-only behavior. Signatures kept identical so the ported
// chart option blocks call them unchanged.
// ============================================================================

const ABBREV: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
]

function addThousands(value: string, sep: string): string {
  const [intPart, decPart] = value.split('.')
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  return decPart !== undefined ? `${withSep}.${decPart}` : withSep
}

/**
 * Mirrors the reference implementation's `customNumberFormatter`:
 * (value, noValue, toBeFixed, thousandSeparator, abbreviation, percentage, thousandSeparatorString)
 */
export function customNumberFormatter(
  value: number | string,
  noValue = '-',
  toBeFixed = 2,
  thousandSeparator = false,
  abbreviation = false,
  percentage = false,
  thousandSeparatorString = ','
): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (num === null || num === undefined || Number.isNaN(num)) return noValue

  if (percentage) {
    return `${(num * 100).toFixed(toBeFixed)}%`
  }

  if (abbreviation) {
    const abs = Math.abs(num)
    for (const [size, suffix] of ABBREV) {
      if (abs >= size) {
        return `${(num / size).toFixed(toBeFixed).replace(/\.?0+$/, '')}${suffix}`
      }
    }
  }

  const fixed = num.toFixed(toBeFixed)
  // Drop trailing zeros for cleaner labels, but keep integers clean.
  const trimmed = fixed.replace(/\.?0+$/, '')
  return thousandSeparator ? addThousands(trimmed, thousandSeparatorString) : trimmed
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Format an ISO date(time) by a simple pattern. Supports yyyy/mm/dd and a few
 * readable variants. Falls back to the input when unparseable.
 */
export function formatDateToPattern(
  input: string | number | Date,
  pattern = 'yyyy-mm-dd',
  noValue = '-'
): string {
  if (input === null || input === undefined || input === '') return noValue
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return String(input)

  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')

  switch (pattern) {
    case 'dd mmm':
      return `${dd} ${MONTHS[date.getMonth()]}`
    case 'mmm yyyy':
      return `${MONTHS[date.getMonth()]} ${yyyy}`
    case 'dd.mm.yyyy':
      return `${dd}.${mm}.${yyyy}`
    case 'mm/dd/yyyy':
      return `${mm}/${dd}/${yyyy}`
    case 'dd/mm/yyyy':
      return `${dd}/${mm}/${yyyy}`
    case 'yyyy-mm-dd hh:mm':
      return `${yyyy}-${mm}-${dd} ${hh}:${min}`
    case 'yyyy-mm-dd':
    default:
      return `${yyyy}-${mm}-${dd}`
  }
}
