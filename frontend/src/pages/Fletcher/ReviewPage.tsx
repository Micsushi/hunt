import { Link, useParams } from 'react-router-dom'
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
        </div>
        <Link className={styles.btn} to="/fletcher">
          Back to Fletcher
        </Link>
      </div>
      <ResumeReviewWorkspace reviewId={reviewId} />
    </div>
  )
}
