import { get, post } from './client'
import type { AuthStatus } from '@/types/summary'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'

export function fetchAuthStatus(): Promise<AuthStatus> {
  return get<AuthStatus>('/auth/me')
}

export async function login(username: string, password: string): Promise<void> {
  if (MOCK) return
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
    throw new Error(body.detail || 'Login failed')
  }
}

export function logout(): Promise<void> {
  return post('/auth/logout')
}
