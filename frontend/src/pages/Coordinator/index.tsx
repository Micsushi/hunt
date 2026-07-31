import styles from '@/pages/Control/Control.module.css'

export function CoordinatorPage() {
  return (
    <div className={styles.page}>
      <div className={styles.panel}>
        <h1 className={styles.heroTitle}>C4 Coordinator</h1>
        <p className={styles.meta}>C4 is on hold and has no active runtime or controls.</p>
      </div>
    </div>
  )
}
