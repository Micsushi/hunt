import { create } from 'zustand'

interface Toast {
  id: number
  message: string
  kind: 'ok' | 'error'
}

interface UiStore {
  // Toast notifications
  toasts: Toast[]
  showToast: (message: string, kind?: 'ok' | 'error') => void
  dismissToast: (id: number) => void

  // Jobs table selection
  selectedIds: Set<number>
  toggleSelect: (id: number) => void
  selectAll: (ids: number[]) => void
  clearSelection: () => void

  // Loading state
  isNavigating: boolean
  setNavigating: (v: boolean) => void
}

let toastCounter = 0

export const useUiStore = create<UiStore>((set, get) => ({
  toasts: [],
  showToast: (message, kind = 'ok') => {
    const id = ++toastCounter
    set(s => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), 3500)
  },
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  selectedIds: new Set(),
  toggleSelect: (id) =>
    set(s => {
      const next = new Set(s.selectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedIds: next }
    }),
  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelection: () => set({ selectedIds: new Set() }),

  isNavigating: false,
  setNavigating: (v) => set({ isNavigating: v }),
}))
