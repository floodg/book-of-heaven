import { useCallback, useEffect, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { AuthPage } from './components/AuthPage'
import { ChatWindow } from './components/ChatWindow'
import { HistorySidebar } from './components/HistorySidebar'
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

  return <MainLayout user={session.user} session={session} />
}

interface MainLayoutProps {
  user: User
  session: Session
}

function MainLayout({ user, session }: MainLayoutProps) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId)
  }, [])

  const handleNewThread = useCallback(() => {
    setActiveThreadId(null)
  }, [])

  const handleAssistantResponse = useCallback(
    (threadId: string) => {
      setActiveThreadId((prev) => prev ?? threadId)
      setHistoryRefresh((n) => n + 1)
    },
    [],
  )

  const handleThreadDeleted = useCallback((threadId: string) => {
    setActiveThreadId((prev) => (prev === threadId ? null : prev))
    setHistoryRefresh((n) => n + 1)
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header-title">Book of Heaven</h1>
        <div className="app-header-actions">
          <span className="app-header-user">{user.email}</span>
          <button type="button" className="app-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>
      <main className="app-main">
        <HistorySidebar
          user={user}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onThreadDeleted={handleThreadDeleted}
          refreshToken={historyRefresh}
        />
        <ChatWindow
          user={user}
          session={session}
          threadId={activeThreadId}
          onAssistantResponse={handleAssistantResponse}
        />
      </main>
    </div>
  )
}

export default App
