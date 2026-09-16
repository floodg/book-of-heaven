// Parsing utilities for inline Scripture citations emitted when Francis Hogan
// cites Bible passages in narrated transcripts.
//
// The narrated workspace prompt instructs the LLM to emit:
//   [Scripture: John 14:20-21]
//   [Scripture: 1 Corinthians 13:11]
//   [Scripture: Psalm 23]
//
// resolveScriptureLink() turns a parsed reference into a BibleHub deep link:
//   https://biblehub.com/john/14-20.htm
//   https://biblehub.com/1_corinthians/13-11.htm
//   https://biblehub.com/psalms/23.htm

export interface ParsedScripture {
  /** Full matched token, e.g. `[Scripture: John 14:20-21]`. */
  raw: string
  /** Canonical display name, e.g. `1 Corinthians`. */
  book: string
  chapter: number
  /** Starting verse when present; null for chapter-only references. */
  verse: number | null
  /** End verse for ranges like 14:20-21; null when not a range. */
  verseEnd: number | null
  /** Short label for the pill, e.g. `John 14:20-21`. */
  label: string
}

export const SCRIPTURE_PATTERN = /\[Scripture:\s*([^\]\n]+?)\s*\]/gi

type BookDef = {
  slug: string
  display: string
  /** Lowercase aliases including abbreviations. Longest match wins. */
  aliases: string[]
}

const BOOKS: BookDef[] = [
  { slug: 'genesis', display: 'Genesis', aliases: ['genesis', 'gen'] },
  { slug: 'exodus', display: 'Exodus', aliases: ['exodus', 'exod', 'ex'] },
  { slug: 'leviticus', display: 'Leviticus', aliases: ['leviticus', 'lev'] },
  { slug: 'numbers', display: 'Numbers', aliases: ['numbers', 'num'] },
  { slug: 'deuteronomy', display: 'Deuteronomy', aliases: ['deuteronomy', 'deut'] },
  { slug: 'joshua', display: 'Joshua', aliases: ['joshua', 'josh'] },
  { slug: 'judges', display: 'Judges', aliases: ['judges', 'judg'] },
  { slug: 'ruth', display: 'Ruth', aliases: ['ruth'] },
  { slug: '1_samuel', display: '1 Samuel', aliases: ['1 samuel', '1 sam', 'first samuel'] },
  { slug: '2_samuel', display: '2 Samuel', aliases: ['2 samuel', '2 sam', 'second samuel'] },
  { slug: '1_kings', display: '1 Kings', aliases: ['1 kings', 'first kings'] },
  { slug: '2_kings', display: '2 Kings', aliases: ['2 kings', 'second kings'] },
  { slug: '1_chronicles', display: '1 Chronicles', aliases: ['1 chronicles', '1 chron', 'first chronicles'] },
  { slug: '2_chronicles', display: '2 Chronicles', aliases: ['2 chronicles', '2 chron', 'second chronicles'] },
  { slug: 'ezra', display: 'Ezra', aliases: ['ezra'] },
  { slug: 'nehemiah', display: 'Nehemiah', aliases: ['nehemiah', 'neh'] },
  { slug: 'esther', display: 'Esther', aliases: ['esther', 'esth'] },
  { slug: 'job', display: 'Job', aliases: ['job'] },
  { slug: 'psalms', display: 'Psalms', aliases: ['psalms', 'psalm', 'ps', 'pss'] },
  { slug: 'proverbs', display: 'Proverbs', aliases: ['proverbs', 'prov', 'pro'] },
  { slug: 'ecclesiastes', display: 'Ecclesiastes', aliases: ['ecclesiastes', 'eccl', 'ecc'] },
  { slug: 'songs', display: 'Song of Solomon', aliases: ['song of solomon', 'song of songs', 'songs', 'sos'] },
  { slug: 'isaiah', display: 'Isaiah', aliases: ['isaiah', 'isa'] },
  { slug: 'jeremiah', display: 'Jeremiah', aliases: ['jeremiah', 'jer', 'jere'] },
  { slug: 'lamentations', display: 'Lamentations', aliases: ['lamentations', 'lam'] },
  { slug: 'ezekiel', display: 'Ezekiel', aliases: ['ezekiel', 'ezek', 'eze'] },
  { slug: 'daniel', display: 'Daniel', aliases: ['daniel', 'dan'] },
  { slug: 'hosea', display: 'Hosea', aliases: ['hosea', 'hos'] },
  { slug: 'joel', display: 'Joel', aliases: ['joel'] },
  { slug: 'amos', display: 'Amos', aliases: ['amos'] },
  { slug: 'obadiah', display: 'Obadiah', aliases: ['obadiah', 'obad'] },
  { slug: 'jonah', display: 'Jonah', aliases: ['jonah'] },
  { slug: 'micah', display: 'Micah', aliases: ['micah', 'mic'] },
  { slug: 'nahum', display: 'Nahum', aliases: ['nahum', 'nah'] },
  { slug: 'habakkuk', display: 'Habakkuk', aliases: ['habakkuk', 'hab'] },
  { slug: 'zephaniah', display: 'Zephaniah', aliases: ['zephaniah', 'zeph'] },
  { slug: 'haggai', display: 'Haggai', aliases: ['haggai', 'hag'] },
  { slug: 'zechariah', display: 'Zechariah', aliases: ['zechariah', 'zech'] },
  { slug: 'malachi', display: 'Malachi', aliases: ['malachi', 'mal'] },
  { slug: 'matthew', display: 'Matthew', aliases: ['matthew', 'matt', 'mt'] },
  { slug: 'mark', display: 'Mark', aliases: ['mark', 'mk'] },
  { slug: 'luke', display: 'Luke', aliases: ['luke', 'lk'] },
  { slug: 'john', display: 'John', aliases: ['john', 'jn'] },
  { slug: 'acts', display: 'Acts', aliases: ['acts', 'act'] },
  { slug: 'romans', display: 'Romans', aliases: ['romans', 'rom'] },
  { slug: '1_corinthians', display: '1 Corinthians', aliases: ['1 corinthians', '1 cor', 'first corinthians'] },
  { slug: '2_corinthians', display: '2 Corinthians', aliases: ['2 corinthians', '2 cor', 'second corinthians'] },
  { slug: 'galatians', display: 'Galatians', aliases: ['galatians', 'gal'] },
  { slug: 'ephesians', display: 'Ephesians', aliases: ['ephesians', 'eph'] },
  { slug: 'philippians', display: 'Philippians', aliases: ['philippians', 'phil'] },
  { slug: 'colossians', display: 'Colossians', aliases: ['colossians', 'col'] },
  { slug: '1_thessalonians', display: '1 Thessalonians', aliases: ['1 thessalonians', '1 thess', 'first thessalonians'] },
  { slug: '2_thessalonians', display: '2 Thessalonians', aliases: ['2 thessalonians', '2 thess', 'second thessalonians'] },
  { slug: '1_timothy', display: '1 Timothy', aliases: ['1 timothy', '1 tim', 'first timothy'] },
  { slug: '2_timothy', display: '2 Timothy', aliases: ['2 timothy', '2 tim', 'second timothy'] },
  { slug: 'titus', display: 'Titus', aliases: ['titus', 'tit'] },
  { slug: 'philemon', display: 'Philemon', aliases: ['philemon', 'phlm'] },
  { slug: 'hebrews', display: 'Hebrews', aliases: ['hebrews', 'heb'] },
  { slug: 'james', display: 'James', aliases: ['james', 'jas'] },
  { slug: '1_peter', display: '1 Peter', aliases: ['1 peter', '1 pet', 'first peter'] },
  { slug: '2_peter', display: '2 Peter', aliases: ['2 peter', '2 pet', 'second peter'] },
  { slug: '1_john', display: '1 John', aliases: ['1 john', 'first john'] },
  { slug: '2_john', display: '2 John', aliases: ['2 john', 'second john'] },
  { slug: '3_john', display: '3 John', aliases: ['3 john', 'third john'] },
  { slug: 'jude', display: 'Jude', aliases: ['jude'] },
  { slug: 'revelation', display: 'Revelation', aliases: ['revelation', 'rev', 'revelations'] },
]

const ALIAS_TO_BOOK = new Map<string, BookDef>()
for (const book of BOOKS) {
  for (const alias of book.aliases) {
    ALIAS_TO_BOOK.set(alias, book)
  }
}

/** Longest-alias-first list for greedy prefix matching on free-form inner text. */
const ALIASES_BY_LENGTH = [...ALIAS_TO_BOOK.keys()].sort((a, b) => b.length - a.length)

function normalizeInner(raw: string): string {
  return raw
    .replace(/^\[|\]$/g, '')
    .replace(/^Scripture:\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function formatLabel(
  book: string,
  chapter: number,
  verse: number | null,
  verseEnd: number | null,
): string {
  if (verse == null) return `${book} ${chapter}`
  if (verseEnd != null && verseEnd !== verse) return `${book} ${chapter}:${verse}-${verseEnd}`
  return `${book} ${chapter}:${verse}`
}

function resolveBookName(namePart: string): BookDef | null {
  const key = namePart.toLowerCase().trim()
  return ALIAS_TO_BOOK.get(key) ?? null
}

function tryMatchBook(inner: string): {
  book: BookDef
  rest: string
} | null {
  const lower = inner.toLowerCase()

  for (const alias of ALIASES_BY_LENGTH) {
    if (!lower.startsWith(alias)) continue
    const next = inner.slice(alias.length)
    if (next.length > 0 && !/^\s/.test(next)) continue
    const book = ALIAS_TO_BOOK.get(alias)
    if (!book) continue
    return { book, rest: next.trim() }
  }

  return null
}

export function parseScripture(raw: string): ParsedScripture | null {
  const inner = normalizeInner(raw)
  if (!inner) return null

  // Optional leading numbered prefix glued to the book name, e.g. "1Corinthians".
  const glued = /^([123])\s*([A-Za-z].*)$/.exec(inner)
  const candidate = glued ? `${glued[1]} ${glued[2]}` : inner

  const matched = tryMatchBook(candidate)
  if (!matched) return null

  const rest = matched.rest
  // Chapter with optional verse or verse range: "14:20-21", "14:20–21", "13:11", "23".
  const refMatch =
    /^(\d+)\s*(?::\s*(\d+))?(?:\s*[-–—]\s*(\d+))?\s*$/.exec(rest) ??
    /^(\d+)\s+(\d+)(?:\s*[-–—]\s*(\d+))?\s*$/.exec(rest)

  if (!refMatch) return null

  const chapter = Number.parseInt(refMatch[1], 10)
  const verse = refMatch[2] != null ? Number.parseInt(refMatch[2], 10) : null
  const verseEnd = refMatch[3] != null ? Number.parseInt(refMatch[3], 10) : null

  if (!Number.isFinite(chapter) || chapter <= 0) return null
  if (verse != null && (!Number.isFinite(verse) || verse <= 0)) return null
  if (verseEnd != null && (!Number.isFinite(verseEnd) || verseEnd <= 0)) return null

  const label = formatLabel(matched.book.display, chapter, verse, verseEnd)

  return {
    raw,
    book: matched.book.display,
    chapter,
    verse,
    verseEnd,
    label,
  }
}

export function resolveScriptureLink(parsed: ParsedScripture): string | null {
  const bookDef = resolveBookName(parsed.book)
  if (!bookDef) return null

  if (parsed.verse != null && parsed.verse > 0) {
    return `https://biblehub.com/${bookDef.slug}/${parsed.chapter}-${parsed.verse}.htm`
  }

  return `https://biblehub.com/${bookDef.slug}/${parsed.chapter}.htm`
}
