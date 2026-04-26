import styles from './FieldGrid.module.css'
import type { ReactNode } from 'react'

interface Field {
  label: string
  value: ReactNode
  tooltip?: string
  mono?: boolean
  span?: boolean
}

interface Props {
  fields: Field[]
}

export function FieldGrid({ fields }: Props) {
  return (
    <div className={styles.grid}>
      {fields.map((f, i) => (
        <div key={i} className={`${styles.field} ${f.span ? styles.span : ''}`} title={f.tooltip}>
          <div className={styles.label}>{f.label}</div>
          <div className={`${styles.value} ${f.mono ? 'mono' : ''}`}>
            {f.value ?? <span className="muted">-</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
