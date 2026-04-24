import styles from '../stub.module.css'

// eslint-disable-next-line react-refresh/only-export-components
export const executionerPlugin = {
  path: '/executioner',
  navLabel: 'Executioner',
  tooltip: 'C3: Chrome extension settings',
}

export function ExecutionerPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.title}>Executioner <span className={styles.badge}>C3</span></h1>
        <p className={styles.sub}>Chrome extension settings — coming soon</p>
      </section>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>What this page will do</h2>
        <ul className={styles.list}>
          <li>Configure ATS-specific settings (Workday, Greenhouse, Lever, etc.)</li>
          <li>Manage candidate profile fields used to autofill forms</li>
          <li>View apply attempt history and generated answers</li>
          <li>Push apply-context for a job to the extension</li>
          <li>Check extension status and last activity</li>
        </ul>
        <p className={styles.hint}>
          For now, use the Chrome extension options page directly.
          Apply context can be set with: <code>hunter apply-prep &lt;job_id&gt;</code>
        </p>
      </div>
    </div>
  )
}
