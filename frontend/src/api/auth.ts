import { get, post } from './client'
import type { AuthStatus } from '@/types/summary'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'

export function fetchAuthStatus(): Promise<AuthStatus> {
  return get<AuthStatus>('/auth/me')
}

export async function login(username: string, password: string): Promise<string> {
  if (MOCK) return username.trim()
  const form = new URLSearchParams()
  form.set('username', username)
  form.set('password', password)
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      typeof body.detail === 'string' ? body.detail : 'Login failed. Please try again.',
    )
  }
  const body = await res.json()
  if (body.status !== 'ok' || typeof body.username !== 'string' || !body.username.trim()) {
    throw new Error('Could not confirm sign-in. Please try again.')
  }
  return body.username
}

export function logout(): Promise<void> {
  return post('/auth/logout')
}
