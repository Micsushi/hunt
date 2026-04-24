import { useUiStore } from '@/store/ui'
import styles from './LoadingBar.module.css'

export function LoadingBar() {
  const isNavigating = useUiStore(s => s.isNavigating)
  return (
    <div
      className={`${styles.bar} ${isNavigating ? styles.active : ''}`}
      aria-hidden="true"
    />
  )
}
