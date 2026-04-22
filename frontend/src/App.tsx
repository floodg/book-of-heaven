import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { AuthPage } from './components/AuthPage'
import { ProtectedLayout } from './routes/ProtectedLayout'
import { ChatPage } from './routes/ChatPage'
import { ProjectsPage } from './routes/ProjectsPage'
import { ProjectDetailPage } from './routes/ProjectDetailPage'
import { PdfViewerPage } from './routes/PdfViewerPage'
import './App.css'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // getSession() only reads localStorage and does NOT verify the token with
    // the server, so after a `supabase db reset` (or any situation where the
    // user row is gone server-side) we can be "logged in" with a dead JWT.
    // Validate the token via getUser() and clear the session if it's stale so
    // the user lands on AuthPage cleanly instead of hitting 401s on every
    // request.
    let cancelled = false
    ;(async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const existing = sessionData.session
      if (!existing) {
        if (!cancelled) {
          setSession(null)
          setLoading(false)
        }
        return
      }

      const { data: userData, error: userErr } = await supabase.auth.getUser()
      if (cancelled) return
      if (userErr || !userData?.user) {
        await supabase.auth.signOut().catch(() => {})
        setSession(null)
      } else {
        setSession(existing)
      }
      setLoading(false)
    })()

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-spinner" aria-label="Loading" />
      </div>
    )
  }

  if (!session) {
    return <AuthPage />
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* Full-screen PDF viewer — kept outside ProtectedLayout so it can
            take over the whole viewport without the chat sidebar. The page
            still requires auth (App.tsx bails out above when session is
            null), but it doesn't need WorkspaceContext / thread data. */}
        <Route path="pdf/:volume" element={<PdfViewerPage />} />

        <Route
          element={<ProtectedLayout user={session.user} session={session} />}
        >
          <Route index element={<ChatPage />} />
          <Route path="c/:threadId" element={<ChatPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
