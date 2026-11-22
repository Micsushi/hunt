// A file picker action describes how to select a file, not which document belongs there.
export function uploadLabelKind(value) {
  const label = String(value ?? '').normalize('NFKC').replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/\s*[:：]\s*$/, '').trim();
  if (/^(?:(?:upload|attach|add)\s+)?(?:your\s+)?(?:r[eé]sum[eé]|cv|curriculum vitae)(?:(?:\s*\/\s*|\s+or\s+)(?:r[eé]sum[eé]|cv))?(?:\s*\((?:required|optional)\))?$/i.test(label)) return 'resume';
  if (!label || /^(?:file(?:-input)?|(?:attach|replace|choose|select|upload|browse)(?:\s+(?:a |your )?files?)?|drop or select (?:your )?files?|choose a file or drop it here)$/i.test(label)) return 'action';
  return 'other';
}
