import { useEffect, useRef, useState, FormEvent } from 'react'
import styles from './Login.module.css'

interface Props {
  onLogin: (username: string, password: string) => Promise<void>
  loading: boolean
}

export function LoginPage({ onLogin, loading }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting.current || loading) return
    if (!username.trim() || !password) {
      setError('Enter your username and password.')
      return
    }
    submitting.current = true
    setError(null)
    try {
      await onLogin(username, password)
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : 'Login failed. Please try again.')
    } finally {
      submitting.current = false
    }
  }

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>Hunt</h1>
          <p className={styles.sub}>Job discovery and apply automation</p>
        </div>
        <form className={styles.form} onSubmit={handleSubmit} noValidate aria-busy={loading}>
          <label className={styles.fieldLabel}>
            Username
            <input
              className={styles.input}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label className={styles.fieldLabel}>
            Password
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button className={styles.submit} type="submit" aria-disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
