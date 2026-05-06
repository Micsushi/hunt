export const RESUME_DONE_NOTIFICATION_KEY = 'resume_done_windows_notification_enabled'

export function settingEnabled(value: string | null | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true'
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (!browserNotificationsSupported()) return 'denied'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

export function notifyResumeDone({
  enabled,
  title,
  body,
}: {
  enabled: boolean
  title: string
  body: string
}): boolean {
  if (!enabled || !browserNotificationsSupported() || Notification.permission !== 'granted') {
    return false
  }
  new Notification(title, {
    body,
    tag: 'hunt-resume-generation',
  })
  return true
}
