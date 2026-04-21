// Reusable SVG icon components used across the new sidebar, project pages, and
// row menus. Kept as small React components (rather than one big sprite) so
// they can take size / className overrides and inherit currentColor.

import type { SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'xmlns' | 'viewBox'> & {
  size?: number | string
}

function baseProps(size: number | string | undefined, extra: SVGProps<SVGSVGElement>) {
  return {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...extra,
  }
}

export function IconChevron({
  open,
  size,
  ...rest
}: IconProps & { open: boolean }) {
  return (
    <svg
      {...baseProps(size ?? 10, rest)}
      strokeWidth={2.5}
      style={{
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.12s',
        ...(rest.style ?? {}),
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

export function IconFolder({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 14, rest)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function IconMore({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)} fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}

export function IconTrash({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 14, rest)}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function IconPlus({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 14, rest)} strokeWidth={2.5}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function IconPin({ size, ...rest }: IconProps) {
  // Classic push-pin silhouette, scaled to 24x24.
  return (
    <svg {...baseProps(size ?? 14, rest)}>
      <path d="M12 2v7" />
      <path d="M7 9h10l-2 4H9z" />
      <path d="M12 13v8" />
    </svg>
  )
}

export function IconPinOff({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 14, rest)}>
      <line x1="4" y1="4" x2="20" y2="20" />
      <path d="M12 2v5" />
      <path d="M7 9h10l-2 4H9z" />
      <path d="M12 13v8" />
    </svg>
  )
}

export function IconChat({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <path d="M4 4h16v12H7l-3 3z" />
    </svg>
  )
}

export function IconSearch({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function IconSort({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <line x1="4" y1="6" x2="16" y2="6" />
      <line x1="4" y1="12" x2="13" y2="12" />
      <line x1="4" y1="18" x2="10" y2="18" />
      <polyline points="17 14 20 17 17 20" />
      <line x1="20" y1="17" x2="17" y2="17" />
    </svg>
  )
}

export function IconClose({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  )
}

export function IconArrowLeft({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <polyline points="15 6 9 12 15 18" />
    </svg>
  )
}

export function IconArrowRight({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 16, rest)}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

export function IconFolderMove({ size, ...rest }: IconProps) {
  return (
    <svg {...baseProps(size ?? 14, rest)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="12 11 15 14 12 17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  )
}
