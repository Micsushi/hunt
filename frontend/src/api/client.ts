/** Base fetch wrapper - sends credentials (session cookie) on every request */

import { mockDel, mockGet, mockPatch, mockPost } from '@/mocks/client'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    // Recheck auth on this route so AuthGuard preserves the sign-in return location.
    window.location.reload()
    throw new ApiError(401, 'Not authenticated')
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    let data: unknown
    try {
      const body = await res.json()
      data = body
      if (typeof body.detail === 'string') detail = body.detail
      else if (body.detail) detail = JSON.stringify(body.detail)
      else if (body.error) detail = body.error
    } catch {
      // ignore parse errors
    }
    throw new ApiError(res.status, detail, data)
  }
  // 204 No Content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  // Bound C3 waits without shortening unrelated resume-generation requests.
  const signal = path.startsWith('/api/c3/')
    ? AbortSignal.timeout(init.method === 'POST' ? 90_000 : 15_000)
    : undefined
  try {
    return await handleResponse<T>(await fetch(path, { ...init, signal }))
  } catch (error) {
    if (signal?.aborted) {
      throw new ApiError(
        0,
        path === '/api/c3/handoff/export'
          ? 'The application download timed out. Retry the download; nothing was queued.'
          : init.method === 'POST'
            ? 'Handoff was not confirmed in time. Check Applications before retrying; it may still finish.'
            : 'Application progress did not respond in time. Retry the connection.',
      )
    }
    throw error
  }
}

export async function get<T>(path: string): Promise<T> {
  if (MOCK) return mockGet<T>(path)
  return request<T>(path, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  if (MOCK) return mockPost<T>(path)
  return request<T>(path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  if (MOCK) return mockPatch<T>()
  return request<T>(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
}

export async function del<T>(path: string, body?: unknown): Promise<T> {
  if (MOCK) return mockDel<T>()
  return request<T>(path, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
