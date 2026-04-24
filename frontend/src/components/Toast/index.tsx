import { useUiStore } from '@/store/ui'
import styles from './Toast.module.css'

export function ToastStack() {
  const { toasts, dismissToast } = useUiStore()
  return (
    <div className={styles.stack} aria-live="polite">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.kind === 'error' ? styles.error : ''}`}
          role="alert"
          onClick={() => dismissToast(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
