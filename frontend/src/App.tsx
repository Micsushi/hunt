import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { fetchAuthStatus } from '@/api/auth'
import { Layout } from '@/components/Layout'
import { ToastStack } from '@/components/Toast'
import { LoginPage } from '@/pages/Login'
import { HomePage } from '@/pages/Home'
import { JobsPage } from '@/pages/Jobs'
import { JobDetailPage } from '@/pages/Jobs/JobDetail'
import { LogsPage } from '@/pages/Logs'
import { OpsPage } from '@/pages/Ops'
import { FletcherPage } from '@/pages/Fletcher'
import { ExecutionerPage } from '@/pages/Executioner'
import { CoordinatorPage } from '@/pages/Coordinator'
import { SettingsPage } from '@/pages/Settings'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'

function AuthGuard({ children, username }: { children: React.ReactNode; username: string | null }) {
  const location = useLocation()
  if (username === null) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <Layout username={username}>{children}</Layout>
}

export default function App() {
  const location = useLocation()
  // null = not yet known, '' = not logged in, string = username
  const [username, setUsername] = useState<string | null | undefined>(
    MOCK ? 'dev' : location.pathname === '/login' ? null : undefined,
  )

  useEffect(() => {
    if (MOCK) return
    // skip the check on the login page itself to avoid redirect loops
    if (location.pathname === '/login') return
    fetchAuthStatus()
      .then((s) => setUsername(s.authenticated ? (s.username ?? 'admin') : null))
      .catch(() => setUsername(null))
  }, [location.pathname])

  // Still checking auth
  if (username === undefined) return null

  return (
    <>
      {MOCK && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: '#f59e0b',
            color: '#000',
            textAlign: 'center',
            fontSize: '12px',
            padding: '2px 0',
            fontWeight: 600,
          }}
        >
          MOCK MODE - changes not persisted
        </div>
      )}
      <Routes>
        <Route path="/login" element={username ? <Navigate to="/" replace /> : <LoginPage />} />

        <Route
          path="/"
          element={
            <AuthGuard username={username}>
              <HomePage />
            </AuthGuard>
          }
        />

        <Route
          path="/jobs"
          element={
            <AuthGuard username={username}>
              <JobsPage />
            </AuthGuard>
          }
        />

        <Route
          path="/jobs/:id"
          element={
            <AuthGuard username={username}>
              <JobDetailPage />
            </AuthGuard>
          }
        />

        <Route
          path="/logs"
          element={
            <AuthGuard username={username}>
              <LogsPage />
            </AuthGuard>
          }
        />

        <Route
          path="/ops"
          element={
            <AuthGuard username={username}>
              <OpsPage />
            </AuthGuard>
          }
        />

        <Route
          path="/fletcher"
          element={
            <AuthGuard username={username}>
              <FletcherPage />
            </AuthGuard>
          }
        />

        <Route
          path="/executioner"
          element={
            <AuthGuard username={username}>
              <ExecutionerPage />
            </AuthGuard>
          }
        />

        <Route
          path="/coordinator"
          element={
            <AuthGuard username={username}>
              <CoordinatorPage />
            </AuthGuard>
          }
        />

        {/* Legacy redirects for old SSR paths */}
        <Route path="/health-view" element={<Navigate to="/logs" replace />} />
        <Route path="/ops/*" element={<Navigate to="/ops" replace />} />
        <Route path="/summary" element={<Navigate to="/logs" replace />} />

        <Route
          path="/settings"
          element={
            <AuthGuard username={username}>
              <SettingsPage />
            </AuthGuard>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastStack />
    </>
  )
}
