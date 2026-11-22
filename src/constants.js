/**
 * Stable identifiers shared by both halves of the ChatGPT provider bundle.
 *
 * The provider route id is part of the user's durable configuration (sessions,
 * model defaults, settings rows), so it never changes once shipped.
 */

/** Provider route a request selects with `GenerateOptions.provider`. */
export const PROVIDER = 'chatgpt'

/** Credential record containing the registrations for the official deployment. */
export const RECORD_KEY = 'chatgpt-provider/default'

/** Identity scopes plus the ChatGPT-plan permission the flow requests. */
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

/** The permission that decides whether plan usage is enabled. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

/** OAuth resource audience, also the default API root. */
export const RESOURCE = 'https://api.openai.com/v1'

/** Loopback callback path; only the port may vary between attempts. */
export const CALLBACK_PATH = '/auth/callback'

/** Exact issuer of the Sign in with ChatGPT flow. */
export const ISSUER = 'https://auth.openai.com'

/** Client id used only for first-time dynamic registration. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'

/** Browser-facing JSON API prefix served through `ctx.connection.fetch`. */
export const API_PREFIX = '/api/chatgpt-provider'
