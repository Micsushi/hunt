import { useParams } from 'react-router-dom'
import { ResumeReviewWorkspace } from './review/ResumeReviewWorkspace'
import styles from './Fletcher.module.css'

export function FletcherReviewPage() {
  const { reviewId } = useParams()
  if (!reviewId) {
    return <div className={styles.llmErrorBanner}>Review id missing.</div>
  }
  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heroTitle}>Resume workspace</h1>
          <div className={styles.heroMeta}>Diff, edit, compile, and export tailored resumes</div>
        </div>
        <a className={styles.btn} href="/fletcher">
          Back to Fletcher
        </a>
      </div>
      <ResumeReviewWorkspace reviewId={reviewId} />
    </div>
  )
}
