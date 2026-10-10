/** Name of the short-lived httpOnly cookie carrying the OIDC state/nonce/PKCE verifier. */
export const OIDC_COOKIE = 'eerp_oidc'
/** Cookie path: set by /start and must be repeated verbatim to delete it in /callback. */
export const OIDC_COOKIE_PATH = '/api/auth/oidc'
