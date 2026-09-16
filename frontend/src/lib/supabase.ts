import { createClient } from '@supabase/supabase-js'

function resolveSupabaseUrl(): string {
  const fromEnv = String(import.meta.env.VITE_SUPABASE_URL ?? '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  return 'http://127.0.0.1:5173'
}

export function getSupabaseUrl(): string {
  return resolveSupabaseUrl()
}

export function supabaseRequestHeaders(): Record<string, string> {
  if (typeof window !== 'undefined' && window.location.hostname.includes('ngrok')) {
    return { 'ngrok-skip-browser-warning': 'true' }
  }
  return {}
}

const supabaseUrl = getSupabaseUrl()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { headers: supabaseRequestHeaders() },
})
