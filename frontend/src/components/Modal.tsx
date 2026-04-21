import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** When true, the confirm button uses the destructive red styling. */
  danger?: boolean
}

export interface AlertOptions {
  title: string
  message: ReactNode
  okLabel?: string
}

export interface ModalApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  alert: (opts: AlertOptions) => Promise<void>
}

const ModalContext = createContext<ModalApi | null>(null)

export function useModal(): ModalApi {
  const ctx = useContext(ModalContext)
  if (!ctx) {
    throw new Error('useModal must be used inside <ModalProvider>')
  }
  return ctx
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state shapes
// ─────────────────────────────────────────────────────────────────────────────

type ModalState =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'alert'; opts: AlertOptions; resolve: () => void }
  | null

// Render a multi-paragraph string (separated by blank lines) as paragraph
// elements, so messages composed with `\n\n` still look right in the modal.
function renderMessage(message: ReactNode): ReactNode {
  if (typeof message !== 'string') return message
  const paragraphs = message.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length === 0) return null
  return paragraphs.map((p, i) => (
    <p key={i} className="modal-message-paragraph">
      {p.split('\n').map((line, j, arr) => (
        <span key={j}>
          {line}
          {j < arr.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function ModalProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ModalState>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState({ kind: 'confirm', opts, resolve })
      }),
    [],
  )

  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) => {
        setState({ kind: 'alert', opts, resolve })
      }),
    [],
  )

  const handleResolve = useCallback(
    (ok: boolean) => {
      setState((current) => {
        if (!current) return null
        if (current.kind === 'confirm') current.resolve(ok)
        else current.resolve()
        return null
      })
    },
    [],
  )

  return (
    <ModalContext.Provider value={{ confirm, alert }}>
      {children}
      {state
        ? createPortal(
            <ModalOverlay
              state={state}
              onCancel={() => handleResolve(false)}
              onConfirm={() => handleResolve(true)}
            />,
            document.body,
          )
        : null}
    </ModalContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayProps {
  state: NonNullable<ModalState>
  onCancel: () => void
  onConfirm: () => void
}

function ModalOverlay({ state, onCancel, onConfirm }: OverlayProps) {
  const primaryBtnRef = useRef<HTMLButtonElement | null>(null)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const isConfirm = state.kind === 'confirm'
  const opts = state.opts
  const danger = isConfirm && Boolean((opts as ConfirmOptions).danger)

  // Focus management on mount:
  //   - destructive confirms focus the cancel button (safety: Enter on focus
  //     defaults to "no, don't do the scary thing")
  //   - everything else focuses the primary button
  useEffect(() => {
    const target = danger ? cancelBtnRef.current : primaryBtnRef.current
    target?.focus()
  }, [danger])

  // Keyboard handling: Esc cancels; Enter fires the primary action *unless* the
  // focus is currently on the cancel button (let the native button click handle
  // that case so Enter on Cancel cancels, as users expect).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Enter') {
        if (document.activeElement === cancelBtnRef.current) return
        e.preventDefault()
        onConfirm()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, onConfirm])

  // Minimal focus trap: cycle Tab between the two buttons so focus can't
  // escape into the dim background UI while the modal is open.
  useEffect(() => {
    const node = dialogRef.current
    if (!node) return
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'))
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [])

  const renderedMessage = renderMessage(opts.message)

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        // Click on backdrop (not inside the dialog) cancels. mousedown is used
        // instead of click so accidental drags from inside the dialog don't
        // register as a backdrop dismiss.
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className="modal-dialog"
        role={isConfirm ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby="modal-message"
      >
        <h2 id="modal-title" className="modal-title">
          {opts.title}
        </h2>
        <div id="modal-message" className="modal-message">
          {renderedMessage}
        </div>
        <div className="modal-actions">
          {isConfirm ? (
            <>
              <button
                ref={cancelBtnRef}
                type="button"
                className="modal-btn modal-btn-secondary"
                onClick={onCancel}
              >
                {(opts as ConfirmOptions).cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={primaryBtnRef}
                type="button"
                className={
                  danger
                    ? 'modal-btn modal-btn-danger'
                    : 'modal-btn modal-btn-primary'
                }
                onClick={onConfirm}
              >
                {(opts as ConfirmOptions).confirmLabel ?? 'OK'}
              </button>
            </>
          ) : (
            <button
              ref={primaryBtnRef}
              type="button"
              className="modal-btn modal-btn-primary"
              onClick={onConfirm}
            >
              {(opts as AlertOptions).okLabel ?? 'OK'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
