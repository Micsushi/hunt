import styles from './Card.module.css'

interface Props {
  label: string
  value: string | number
  tooltip?: string
  onClick?: () => void
  accent?: boolean
  danger?: boolean
  warning?: boolean
}

export function Card({ label, value, tooltip, onClick, accent, danger, warning }: Props) {
  const cls = [
    styles.card,
    onClick ? styles.clickable : '',
    accent ? styles.accent : '',
    danger ? styles.danger : '',
    warning ? styles.warning : '',
  ]
    .filter(Boolean)
    .join(' ')

  const content = (
    <>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
    </>
  )
  return onClick ? (
    <button className={cls} onClick={onClick} title={tooltip} type="button">
      {content}
    </button>
  ) : (
    <div className={cls} title={tooltip}>
      {content}
    </div>
  )
}
