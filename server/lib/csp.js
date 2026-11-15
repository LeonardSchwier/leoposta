// Content-Security-Policy for the app document and its static assets.
//
// The desktop window loads the app from this server (an External URL for
// Tauri), so the CSP in src-tauri/tauri.conf.json is never applied there:
// Tauri injects it only into tauri:// assets. This header is what actually
// limits script if the mail sanitizer is ever bypassed, in the desktop app
// and in the PWA alike. Mail HTML is inline in the document, so img-src
// allows remote images (shown only after "Load images") and style-src keeps
// 'unsafe-inline' for style attributes; scripts, frames, objects, forms and
// <base> are locked down.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: cid: http: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** Express middleware: the CSP on every non-API response. */
export function appCsp(req, res, next) {
  if (!req.path.startsWith('/api/')) res.setHeader('Content-Security-Policy', APP_CSP)
  next()
}
