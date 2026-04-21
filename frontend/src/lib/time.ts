// Small collection of date formatters used across the sidebar, projects grid,
// and project detail page. Kept deliberately minimal — dayjs / date-fns would
// be overkill for the handful of cases we have here, and shipping another
// locale-aware library into every bundle slice just to say "14 days ago"
// isn't worth it.

/**
 * Human-friendly relative time. Returns strings like "just now", "5m ago",
 * "3h ago", "2 days ago", "1 month ago", "3 years ago". Always rounds down
 * so "14 days ago" doesn't become "2 weeks" prematurely.
 */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const then = typeof iso === 'string' ? new Date(iso) : iso
  const diffMs = now.getTime() - then.getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now'

  const sec = Math.floor(diffMs / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon} month${mon === 1 ? '' : 's'} ago`
  const yr = Math.floor(mon / 12)
  return `${yr} year${yr === 1 ? '' : 's'} ago`
}

/**
 * Bucket label used in the sidebar's Recents list. Matches the grouping the
 * previous HistorySidebar had: Today, Yesterday, Previous 7 days, Previous 30
 * days, then month + year for older items.
 */
export function recentBucket(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayMs = 24 * 60 * 60 * 1000
  const diffDays = Math.floor(
    (midnight.getTime() - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      dayMs,
  )
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays <= 7) return 'Previous 7 days'
  if (diffDays <= 30) return 'Previous 30 days'
  const sameYear = then.getFullYear() === now.getFullYear()
  return then.toLocaleDateString(undefined, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
