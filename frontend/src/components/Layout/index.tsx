import { Link, NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { LoadingBar } from '@/components/LoadingBar'
import { fetchSystemStatus } from '@/api/control'
import styles from './Layout.module.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'

type DotState = 'ok' | 'warn' | 'error' | 'unknown'

function StatusDot({ state }: { state: DotState }) {
  return (
    <span
      className={`${styles.dot} ${styles[`dot${state.charAt(0).toUpperCase()}${state.slice(1)}`]}`}
      aria-hidden="true"
    />
  )
}

function getComponentState(status: 'ok' | 'error' | 'unreachable' | string): DotState {
  if (status === 'ok') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'unreachable') return 'error'
  return 'warn'
}

interface NavItem {
  to: string
  label: string
  exact?: boolean
  tooltip?: string
  dotKey?: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', exact: true },
  { to: '/jobs', label: 'Jobs' },
  { to: '/fletcher', label: 'Fletcher', dotKey: 'c2' },
  { to: '/executioner', label: 'Applications' },
  { to: '/settings', label: 'Settings' },
  { to: '/ops', label: 'Hunter', dotKey: 'c1' },
  { to: '/logs', label: 'Logs' },
]

interface Props {
  children: ReactNode
  username?: string | null
  onLogout: () => Promise<void>
  loggingOut: boolean
}

export function Layout({ children, username, onLogout, loggingOut }: Props) {
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const submitting = useRef(false)
  const mounted = useRef(false)
  const brand = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    mounted.current = true
    if (document.activeElement === document.body) brand.current?.focus()
    return () => {
      mounted.current = false
    }
  }, [])

  const { data: sysStatus } = useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  })

  function dotForKey(key: string): DotState {
    if (!sysStatus) return 'unknown'
    const c = sysStatus.components[key as keyof typeof sysStatus.components]
    if (!c) return 'unknown'
    return getComponentState(c.status)
  }

  async function handleLogout() {
    if (submitting.current || loggingOut) return
    submitting.current = true
    setLogoutError(null)
    try {
      await onLogout()
    } catch (error) {
      if (mounted.current)
        setLogoutError(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      submitting.current = false
    }
  }

  return (
    <>
      <LoadingBar />
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link ref={brand} className={styles.brand} to="/" aria-label="Hunt overview">
            <span className={styles.brandIconFrame}>
              <img className={styles.brandIcon} src="/favicon.svg" alt="" aria-hidden="true" />
            </span>
            <span>Hunt</span>
          </Link>
          <nav className={styles.nav} aria-label="Main navigation">
            <div className={styles.navGroup}>
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.exact}
                  className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
                  title={item.tooltip}
                >
                  {item.label}
                  {item.dotKey && <StatusDot state={dotForKey(item.dotKey)} />}
                </NavLink>
              ))}
            </div>
            <div className={styles.navSecondary}>
              {username && <span className={styles.username}>{username}</span>}
              <button
                className={styles.logoutBtn}
                style={{ whiteSpace: 'nowrap' }}
                onClick={handleLogout}
                aria-disabled={loggingOut}
              >
                {loggingOut ? 'Signing out…' : logoutError ? 'Retry sign out' : 'Sign out'}
              </button>
            </div>
          </nav>
        </header>
        {logoutError && <p role="alert">Sign out failed: {logoutError}</p>}
        <main className={styles.main}>{children}</main>
      </div>
    </>
  )
}
