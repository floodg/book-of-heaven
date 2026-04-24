import type { Session, User } from '@supabase/supabase-js'
import { Outlet } from 'react-router-dom'
import { ChatJobNotifier } from '../components/ChatJobNotifier'
import { WorkspaceProvider } from '../lib/WorkspaceContext'
import { YoutubeMapProvider } from '../lib/YoutubeMapContext'
import { PdfPagesProvider } from '../lib/PdfPagesContext'
import { Sidebar } from '../components/Sidebar'
import './ProtectedLayout.css'

interface ProtectedLayoutProps {
  user: User
  session: Session
}

/**
 * Wraps every authenticated route with the shared shell: the dark sidebar on
 * the left and whichever page component the route resolves to on the right.
 * WorkspaceProvider sits at this level so every page + the sidebar share the
 * same projects/threads state and stay in sync after mutations.
 *
 * We pass the session down via React Router's `Outlet context` so ChatPage
 * (and anything else that needs to talk to chat-proxy) can get it without
 * us threading props through the route config.
 */
export function ProtectedLayout({ user, session }: ProtectedLayoutProps) {
  return (
    <WorkspaceProvider user={user}>
      <YoutubeMapProvider>
        <PdfPagesProvider>
          <div className="app-shell">
            <div className="app-main">
              <Sidebar user={user} />
              <Outlet context={{ user, session }} />
              <ChatJobNotifier user={user} session={session} />
            </div>
          </div>
        </PdfPagesProvider>
      </YoutubeMapProvider>
    </WorkspaceProvider>
  )
}

export interface ProtectedOutletContext {
  user: User
  session: Session
}
