import styles from './Pagination.module.css'

interface Props {
  page: number
  totalRows: number
  limit: number
  onChange: (page: number) => void
}

export function Pagination({ page, totalRows, limit, onChange }: Props) {
  if (totalRows <= limit) return null
  const totalPages = Math.max(1, Math.ceil(totalRows / limit))
  const current = Math.max(1, Math.min(page, totalPages))
  const start = Math.max(1, current - 2)
  const end = Math.min(totalPages, current + 2)
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i)

  return (
    <div className={styles.wrap}>
      <span className={styles.info}>Page {current} of {totalPages} ({totalRows} rows)</span>
      <div className={styles.pills}>
        {current > 1 && (
          <button className={styles.pill} onClick={() => onChange(current - 1)}>Previous</button>
        )}
        {pages.map(p => (
          <button
            key={p}
            className={`${styles.pill} ${p === current ? styles.active : ''}`}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ))}
        {current < totalPages && (
          <button className={styles.pill} onClick={() => onChange(current + 1)}>Next</button>
        )}
      </div>
    </div>
  )
}
