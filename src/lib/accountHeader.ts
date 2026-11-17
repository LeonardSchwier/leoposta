// The `x-account` request header scopes every API call to one account (see
// server/lib/state.js `resolveAccount`). A header value is a ByteString, so an
// address with a character above U+00FF (Cyrillic, CJK, Polish ł, an
// internationalised domain) made `new Headers().set(...)` throw and no request
// could be made while that account was active. Such an address travels as
// `u8:` + encodeURIComponent(address); a printable ASCII address is sent as it is.
// This file is the only place that names the header: a test fails when another
// source file does.

/** The value of the `x-account` header for `email`. An address that itself starts
 * with `u8:` is encoded too, so the server never mistakes it for the prefix. */
export function accountHeaderValue(email: string): string {
  return /^[\x20-\x7e]*$/.test(email) && !email.startsWith('u8:') ? email : `u8:${encodeURIComponent(email)}`
}

/** `{ 'x-account': ... }` for `email`, or `{}` when there is no account. */
export function accountHeaders(email?: string | null): Record<string, string> {
  return email ? { 'x-account': accountHeaderValue(email) } : {}
}
