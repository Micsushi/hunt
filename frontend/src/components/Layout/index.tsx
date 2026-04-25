import { NavLink, useNavigate } from 'react-router-dom'
import { LoadingBar } from '@/components/LoadingBar'
import { useUiStore } from '@/store/ui'
import { logout } from '@/api/auth'
import styles from './Layout.module.css'
import type { ReactNode } from 'react'

interface NavItem {
  to: string
  label: string
  exact?: boolean
  tooltip?: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/',          label: 'Overview',      exact: true, tooltip: 'Dashboard: queue stats and quick lists' },
  { to: '/jobs',      label: 'Jobs',          tooltip: 'Browse, search, and filter all job listings' },
  { to: '/logs',      label: 'Logs',          tooltip: 'LinkedIn auth status, queue health, runtime events, audit log' },
  { to: '/ops',       label: 'Ops',           tooltip: 'Operator tools, health, C1 controls, settings' },
  { to: '/fletcher',  label: 'Fletcher',      tooltip: 'C2: Resume tailoring' },
  { to: '/executioner', label: 'Executioner', tooltip: 'C3: Chrome extension bridge' },
  { to: '/coordinator', label: 'Coordinator', tooltip: 'C4: Runs and approvals' },
]

interface Props {
  children: ReactNode
  username?: string | null
}

export function Layout({ children, username }: Props) {
  const navigate = useNavigate()
  const showToast = useUiStore(s => s.showToast)

  async function handleLogout() {
    try {
      await logout()
    } finally {
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
            <span className={styles.brand} title="Hunt : job discovery and apply automation">Hunt</span>
            {NAV_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}
                title={item.tooltip}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
          <div className={styles.navSecondary}>
            {username && <span className={styles.username} title="Logged in as">{username}</span>}
            <a
              href="/health"
              target="_blank"
              rel="noreferrer"
              className={`${styles.navLink} ${styles.secondary}`}
              title="Raw JSON health endpoint — for scripts and monitoring"
            >
              Health JSON
            </a>
            <a
              href="/metrics"
              target="_blank"
              rel="noreferrer"
              className={`${styles.navLink} ${styles.secondary}`}
              title="Prometheus metrics endpoint"
            >
              Metrics
            </a>
            {username && (
              <button
                className={styles.logoutBtn}
                onClick={handleLogout}
                title="Sign out"
              >
                Sign out
              </button>
            )}
          </div>
        </nav>
        <main className={styles.main}>
          {children}
        </main>
      </div>
    </>
  )
}
