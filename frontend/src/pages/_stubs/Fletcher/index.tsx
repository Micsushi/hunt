import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fetchC2Status, triggerC2Generate } from '@/api/control'
import { useUiStore } from '@/store/ui'
import styles from '@/pages/Control/Control.module.css'

// eslint-disable-next-line react-refresh/only-export-components
export const fletcherPlugin = {
  path: '/fletcher',
  navLabel: 'Fletcher',
  tooltip: 'C2: Resume tailoring',
}

export function FletcherPage() {
  const [jobId, setJobId] = useState('')
  const [lastResult, setLastResult] = useState<unknown>(null)
  const showToast = useUiStore(s => s.showToast)
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['c2-status'],
    queryFn: fetchC2Status,
    refetchInterval: 30_000,
  })
  const generate = useMutation({
    mutationFn: (id: number) => triggerC2Generate(id),
    onSuccess: res => {
      setLastResult(res)
      showToast('Generation requested')
      qc.invalidateQueries({ queryKey: ['c2-status'] })
    },
    onError: e => showToast(e instanceof Error ? e.message : 'Generation failed', 'error'),
  })

  function submit() {
    const id = Number(jobId)
    if (!Number.isInteger(id) || id < 1) {
      showToast('Job ID required', 'error')
      return
    }
    generate.mutate(id)
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <h1 className={styles.heroTitle}>Fletcher</h1>
          <div className={styles.heroMeta}>C2 resume generation</div>
        </div>
      </section>

      <div className={styles.twoCol}>
        <div className={`${styles.panel} ${styles.panelStrong}`}>
          <h2 className={styles.panelTitle}>Generate for job</h2>
          <div className={styles.formGrid}>
            <label className={styles.field}>Job ID
              <input className={styles.input} value={jobId} onChange={e => setJobId(e.target.value)} inputMode="numeric" />
            </label>
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={generate.isPending} onClick={submit}>
              Generate
            </button>
          </div>
          {lastResult ? <pre className={styles.pre}>{JSON.stringify(lastResult, null, 2)}</pre> : null}
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Service status</h2>
          {isLoading ? <p className={styles.meta}>Loading...</p> : null}
          {error ? <p className={styles.meta}>Unavailable</p> : null}
          {data ? <pre className={styles.pre}>{JSON.stringify(data, null, 2)}</pre> : null}
        </div>
      </div>
    </div>
  )
}
