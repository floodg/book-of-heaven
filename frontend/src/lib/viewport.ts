/** Shared compact-screen breakpoint for sidebar + chat composer.
 *  Portrait phones match on width; landscape phones match on short height
 *  so Search options stay collapsed in both orientations. */
export const MOBILE_MAX_WIDTH_PX = 640
export const MOBILE_MAX_HEIGHT_PX = 500

/** Keep in sync with ChatWindow.css `@media` for the composer hide/show. */
export const MOBILE_MEDIA_QUERY =
  `(max-width: ${MOBILE_MAX_WIDTH_PX}px), (max-height: ${MOBILE_MAX_HEIGHT_PX}px)`

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
}
