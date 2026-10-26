import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchAuthStatus, login, logout } from '@/api/auth'
import type { AuthStatus } from '@/types/summary'
import { useUiStore } from '@/store/ui'
import { Layout } from '@/components/Layout'
import { ToastStack } from '@/components/Toast'
import { LoginPage } from '@/pages/Login'
import styles from '@/pages/Login/Login.module.css'
import { HomePage } from '@/pages/Home'
import { JobsPage } from '@/pages/Jobs'
import { JobDetailPage } from '@/pages/Jobs/JobDetail'
import { LogsPage } from '@/pages/Logs'
import { OpsPage } from '@/pages/Ops'
import { FletcherPage } from '@/pages/Fletcher'
import { FletcherReviewPage } from '@/pages/Fletcher/ReviewPage'
import { SettingsPage } from '@/pages/Settings'
import { ExecutionerPage } from '@/pages/Executioner'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'
const AUTH_KEY = ['auth-status']

function AuthGuard({
  username,
  onLogout,
  loggingOut,
}: {
  username: string | null
  onLogout: () => Promise<void>
  loggingOut: boolean
}) {
  const location = useLocation()
  if (username === null) return <Navigate to="/login" state={{ from: location }} replace />
  return (
    <Layout username={username} onLogout={onLogout} loggingOut={loggingOut}>
      <Outlet />
    </Layout>
  )
}

export default function App() {
  const location = useLocation()
  const queryClient = useQueryClient()
  const showToast = useUiStore((s) => s.showToast)
  const [action, setAction] = useState<'login' | 'logout' | null>(null)
  const request = useRef<Promise<void> | null>(null)
  const auth = useQuery({
    queryKey: AUTH_KEY,
    queryFn: fetchAuthStatus,
    initialData: MOCK ? { authenticated: true, username: 'dev' } : undefined,
    enabled: !MOCK,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  function changeSession(kind: 'login' | 'logout', perform: () => Promise<AuthStatus>) {
    if (request.current) return request.current
    setAction(kind)
    request.current = (async () => {
      const status = await perform()
      // Cancel old requests before removing session-scoped data and unsaved drafts.
      await queryClient.cancelQueries()
      queryClient.clear()
      useUiStore.getState().setFletcherResumeFile(null)
      useUiStore.getState().clearSelection()
      queryClient.setQueryData(AUTH_KEY, status)
      if (kind === 'logout') showToast('Logged out')
    })().finally(() => {
      request.current = null
      setAction(null)
    })
    return request.current
  }

  if (!auth.data)
    return (
      <main className={styles.shell}>
        <div className={styles.card} aria-busy={auth.isFetching}>
          <h1 className={styles.title}>Hunt</h1>
          {auth.isError ? (
            <p className={styles.error} role="alert">
              Could not check your session. {auth.error.message}
            </p>
          ) : (
            <p role="status">Checking your session…</p>
          )}
          <button
            className={styles.submit}
            aria-disabled={auth.isFetching}
            onClick={() => {
              if (!auth.isFetching) void auth.refetch()
            }}
          >
            Retry
          </button>
        </div>
      </main>
    )

  const username = auth.data.authenticated ? (auth.data.username ?? 'admin') : null
  const from = location.state?.from
  const returnTo =
    from &&
    typeof from.pathname === 'string' &&
    from.pathname.startsWith('/') &&
    !from.pathname.startsWith('//') &&
    !from.pathname.includes('\\') &&
    !/^\/login\/?$/i.test(from.pathname)
      ? {
          pathname: from.pathname,
          search: typeof from.search === 'string' ? from.search : '',
          hash: typeof from.hash === 'string' ? from.hash : '',
        }
      : '/'

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
        <Route
          path="/login"
          element={
            username !== null ? (
              <Navigate to={returnTo} replace />
            ) : (
              <LoginPage
                loading={action === 'login'}
                onLogin={(name, password) =>
                  changeSession('login', async () => ({
                    authenticated: true,
                    username: await login(name, password),
                  }))
                }
              />
            )
          }
        />
        <Route
          element={
            <AuthGuard
              username={username}
              loggingOut={action === 'logout'}
              onLogout={() =>
                changeSession('logout', async () => {
                  await logout()
                  return { authenticated: false, username: null }
                })
              }
            />
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/ops" element={<OpsPage />} />
          <Route path="/fletcher" element={<FletcherPage />} />
          <Route path="/fletcher/reviews/:reviewId" element={<FletcherReviewPage />} />
          <Route path="/executioner" element={<ExecutionerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/coordinator" element={<Navigate to="/" replace />} />
        {/* Legacy redirects for old SSR paths */}
        <Route path="/health-view" element={<Navigate to="/logs" replace />} />
        <Route path="/ops/*" element={<Navigate to="/ops" replace />} />
        <Route path="/summary" element={<Navigate to="/logs" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastStack />
    </>
  )
}
