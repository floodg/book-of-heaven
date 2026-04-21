import { useState, type FormEvent } from 'react'
import type { AuthError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import './AuthPage.css'

type Mode = 'signin' | 'signup'

// Translate Supabase auth errors into short, human-readable strings.
// The error text Supabase returns is stable enough to match on keywords, but
// we fall through to the raw message if nothing matches so we never hide a
// real failure behind a generic string.
function friendlyAuthError(error: AuthError | null | undefined): string {
  const msg = typeof error?.message === 'string' ? error.message : ''
  const lower = msg.toLowerCase()
  if (lower.includes('invalid login credentials')) {
    return 'Email or password is incorrect. If your account was recently reset, you may need to sign up again.'
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email before signing in — check your inbox for the confirmation link.'
  }
  if (lower.includes('user already registered')) {
    return 'An account with that email already exists. Try signing in instead.'
  }
  if (lower.includes('password should be at least')) {
    return 'Password must be at least 6 characters.'
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Too many attempts. Please wait a few minutes and try again.'
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Could not reach the auth server. Check your connection and try again.'
  }
  return msg || 'Authentication failed. Please try again.'
}

export function AuthPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (loading) return
    setError(null)
    setInfo(null)
    setLoading(true)
    try {
      if (mode === 'signin') {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (signInError) {
          setError(friendlyAuthError(signInError))
          return
        }
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        })
        if (signUpError) {
          setError(friendlyAuthError(signUpError))
          return
        }
        if (!data.session) {
          setInfo('Account created. Check your email to confirm it before signing in.')
          setMode('signin')
        }
      }
    } catch (err) {
      console.error('Auth request threw', err)
      setError('Something went wrong reaching the auth server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleReset = async () => {
    const trimmed = email.trim()
    if (!trimmed) {
      setError('Enter your email above first, then click Forgot password.')
      return
    }
    setLoading(true)
    setError(null)
    setInfo(null)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: window.location.origin,
      })
      if (resetError) {
        setError(friendlyAuthError(resetError))
      } else {
        setInfo('Password reset link sent. Check your email.')
      }
    } catch (err) {
      console.error('Password reset threw', err)
      setError('Something went wrong reaching the auth server. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const toggleMode = () => {
    setMode((m) => (m === 'signin' ? 'signup' : 'signin'))
    setError(null)
    setInfo(null)
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">Book of Heaven</h1>
        <p className="auth-subtitle">Search the writings of Luisa Piccarreta</p>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <label className="auth-label" htmlFor="auth-email">
            Email address
          </label>
          <input
            id="auth-email"
            type="email"
            className="auth-input"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (error) setError(null)
            }}
            autoComplete="email"
            autoFocus
            required
          />

          <label className="auth-label" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            type="password"
            className="auth-input"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError(null)
            }}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={6}
            required
          />

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          {info && !error && <div className="auth-info">{info}</div>}

          <button type="submit" className="auth-submit" disabled={loading}>
            {loading
              ? mode === 'signin'
                ? 'Signing in…'
                : 'Creating account…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <div className="auth-links">
          {mode === 'signin' && (
            <button
              type="button"
              className="auth-link"
              onClick={handleReset}
              disabled={loading}
            >
              Forgot your password?
            </button>
          )}
          <button
            type="button"
            className="auth-link"
            onClick={toggleMode}
            disabled={loading}
          >
            {mode === 'signin'
              ? "Don't have an account? Sign up"
              : 'Already have an account? Sign in'}
          </button>
        </div>

        <p className="auth-footer">
          A contemplative search tool. Not affiliated with the official cause of canonization.
        </p>
      </div>
    </div>
  )
}
