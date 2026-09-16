/** Diary volume range present in the Book of Heaven corpus (PDFs 1–36). */
export const VOLUME_MIN = 1
export const VOLUME_MAX = 36

export const VOLUME_OPTIONS: number[] = Array.from(
  { length: VOLUME_MAX - VOLUME_MIN + 1 },
  (_, i) => VOLUME_MIN + i,
)

export function parseVolumeFilter(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isInteger(n) || n < VOLUME_MIN || n > VOLUME_MAX) return null
  return n
}
