import { useState } from 'react'
import styles from './Pagination.module.css'

interface Props {
  page: number
  total: number
  limit: number
  onChange: (page: number) => void
}

export function Pagination({ page, total, limit, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const current = Math.max(1, Math.min(page, totalPages))
  const [jumpVal, setJumpVal] = useState('')

  const start = Math.max(1, current - 2)
  const end = Math.min(totalPages, current + 2)
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i)

  function goTo(p: number) {
    const clamped = Math.max(1, Math.min(p, totalPages))
    if (clamped !== current) onChange(clamped)
  }

  function handleJumpSubmit(e: React.FormEvent) {
    e.preventDefault()
    const n = parseInt(jumpVal, 10)
    if (!isNaN(n)) goTo(n)
    setJumpVal('')
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.info}>
        Page {current} of {totalPages}
        {total > 0 && <span className={styles.infoCount}> · {total} rows</span>}
      </span>
      <div className={styles.pills}>
        <button
          className={styles.pill}
          onClick={() => goTo(current - 1)}
          disabled={current <= 1}
          aria-label="Previous page"
        >
          ← Prev
        </button>
        {start > 1 && <span className={styles.ellipsis}>…</span>}
        {pages.map((p) => (
          <button
            key={p}
            className={`${styles.pill} ${p === current ? styles.active : ''}`}
            onClick={() => goTo(p)}
            aria-current={p === current ? 'page' : undefined}
          >
            {p}
          </button>
        ))}
        {end < totalPages && <span className={styles.ellipsis}>…</span>}
        <button
          className={styles.pill}
          onClick={() => goTo(current + 1)}
          disabled={current >= totalPages}
          aria-label="Next page"
        >
          Next →
        </button>
      </div>
      {totalPages > 1 && (
        <form className={styles.jumpWrap} onSubmit={handleJumpSubmit}>
          <span>Go to</span>
          <input
            className={styles.jumpInput}
            type="number"
            min={1}
            max={totalPages}
            value={jumpVal}
            onChange={(e) => setJumpVal(e.target.value)}
            placeholder="pg"
            aria-label="Go to page number"
          />
        </form>
      )}
    </div>
  )
}
