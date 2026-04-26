import { NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { LoadingBar } from '@/components/LoadingBar'
import { useUiStore } from '@/store/ui'
import { logout } from '@/api/auth'
import { fetchSystemStatus } from '@/api/control'
import styles from './Layout.module.css'
import type { ReactNode } from 'react'

type DotState = 'ok' | 'warn' | 'error' | 'unknown'

function StatusDot({ state }: { state: DotState }) {
  return <span className={`${styles.dot} ${styles[`dot${state.charAt(0).toUpperCase()}${state.slice(1)}`]}`} aria-hidden="true" />
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
  { to: '/',             label: 'Overview',    exact: true },
  { to: '/jobs',         label: 'Jobs' },
  { to: '/logs',         label: 'Logs' },
  { to: '/ops',          label: 'Ops',         dotKey: 'c1' },
  { to: '/fletcher',     label: 'Fletcher',    dotKey: 'c2' },
  { to: '/executioner',  label: 'Executioner', dotKey: 'c3' },
  { to: '/coordinator',  label: 'Coordinator', dotKey: 'c4' },
]

interface Props {
  children: ReactNode
  username?: string | null
}

export function Layout({ children, username }: Props) {
  const navigate = useNavigate()
  const showToast = useUiStore(s => s.showToast)

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
    try { await logout() } finally {
      showToast('Logged out')
      navigate('/login')
    }
  }

  return (
    <>
      <LoadingBar />
      <div className={styles.shell}>
        <nav className={styles.nav} aria-label="Main navigation">
          <div className={styles.navGroup}>
            <span className={styles.brand}>Hunt</span>
            {NAV_ITEMS.map(item => (
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
            <button className={styles.logoutBtn} onClick={handleLogout}>Sign out</button>
          </div>
        </nav>
        <main className={styles.main}>{children}</main>
      </div>
    </>
  )
}
