/** A user-selected form may be on a custom HTTPS port or a local development server. */
export function supportsCurrentPage(value, workspaceOrigin = 'http://127.0.0.1:47831') {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname) && /^\d+(?:\.\d+){3}$/.test(url.hostname);
    return url.protocol === 'http:' && loopback && url.port !== '47831' && url.port !== new URL(workspaceOrigin).port;
  } catch {
    return false;
  }
}
