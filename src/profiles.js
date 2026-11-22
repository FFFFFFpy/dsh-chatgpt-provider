import { createHash } from 'node:crypto'
import { ISSUER, RECORD_KEY, RESOURCE } from './constants.js'
import { ChatGptError, CODES } from './errors.js'

/** Keep the registration after disconnecting or rejecting its credentials. */
export function withoutCredentials(profile, status) {
  const registration = { clientId: profile.clientId, status, scopes: [], savedAt: new Date().toISOString() }
  for (const key of ['subject', 'name', 'email', 'extAgentHostId']) {
    if (typeof profile[key] === 'string') registration[key] = profile[key]
  }
  return registration
}

export function putProfile(state, profile) {
  const index = state.profiles.findIndex(entry => entry.clientId === profile.clientId)
  if (index < 0) state.profiles.push(profile)
  else state.profiles[index] = profile
}

/** One credential record per issuer/resource pair. DSH serializes modifyRecord across processes. */
export class ProfileStore {
  constructor(credentials, issuer, resource) {
    this.credentials = credentials
    this.issuer = issuer
    this.resource = resource
    this.key = issuer === ISSUER && resource === RESOURCE ? RECORD_KEY :
      'chatgpt-provider/local-' + createHash('sha256').update(JSON.stringify([issuer, resource])).digest('hex')
  }

  decode(record) {
    const data = record?.payload
    if (record !== undefined && (record.kind !== 'grant' || !data || typeof data !== 'object')) {
      throw new ChatGptError(CODES.configuration, 'The saved ChatGPT registration could not be read.')
    }
    if (data?.version === 2) {
      if (data.issuer !== this.issuer || data.resource !== this.resource ||
          !Array.isArray(data.profiles) || !Array.isArray(data.welcomedSubjects)) {
        throw new ChatGptError(CODES.configuration, 'The saved ChatGPT registration does not match this deployment.')
      }
      return structuredClone(data)
    }
    const state = { version: 2, issuer: this.issuer, resource: this.resource, activeId: null, profiles: [], welcomedSubjects: [] }
    if (record === undefined) return state
    if (data.version !== 1 || typeof data.clientId !== 'string' || !data.clientId) {
      throw new ChatGptError(CODES.configuration, 'The saved ChatGPT registration has an unknown format.')
    }
    // Version 1 never recorded the issuer or resource. Its tokens cannot be reused safely.
    state.profiles.push(withoutCredentials(data, 'reauth_required'))
    state.activeId = data.clientId
    return state
  }

  async read() {
    const record = await this.credentials.readRecord(this.key)
    if (record?.payload?.version === 1) return this.edit(() => false)
    return this.decode(record)
  }

  async edit(mutate) {
    const record = await this.credentials.modifyRecord(this.key, async current => {
      const state = this.decode(current)
      const changed = await mutate(state)
      if (!changed && current?.payload?.version !== 1) return undefined
      return { kind: 'grant', payload: state }
    })
    return this.decode(record)
  }
}
