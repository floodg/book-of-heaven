/** Shared narrow-screen breakpoint for sidebar + chat composer. */
export const MOBILE_MAX_WIDTH_PX = 640

export function isMobileViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH_PX}px)`).matches
  )
}
