import styles from '../stub.module.css'

// eslint-disable-next-line react-refresh/only-export-components
export const fletcherPlugin = {
  path: '/fletcher',
  navLabel: 'Fletcher',
  tooltip: 'C2: Resume tailoring',
}

export function FletcherPage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.title}>Fletcher <span className={styles.badge}>C2</span></h1>
        <p className={styles.sub}>Resume tailoring — coming soon</p>
      </section>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>What this page will do</h2>
        <ul className={styles.list}>
          <li>Upload or edit your base resume (<code>.tex</code> or <code>.pdf</code>)</li>
          <li>Edit your candidate profile (experience, skills, bullet library)</li>
          <li>Trigger the tailoring pipeline for any job ID</li>
          <li>View the generated PDF and keyword match results</li>
          <li>Review and approve the AI-rewritten summary paragraph</li>
        </ul>
        <p className={styles.hint}>
          For now, use the CLI: <code>fletch run generate-job &lt;job_id&gt;</code>
          or view resume history on the individual Job Detail page.
        </p>
      </div>
    </div>
  )
}
