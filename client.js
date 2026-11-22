/**
 * Browser half of the ChatGPT provider bundle: a Settings page that signs this
 * host in with ChatGPT, shows which account is connected, whether ChatGPT plan
 * usage was granted, and which models the account offers.
 *
 * The page talks to the Host through the bundle's own JSON API under
 * `/api/chatgpt-provider`, served by the harness's authenticated browser
 * channel. It renders with the host theme tokens and the host locale service,
 * like any other settings section.
 */
window.__ModuleLoader__.load({
  id: '@local/chatgpt-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'settings.chatgpt'
    const API = '/api/chatgpt-provider'
    const USAGE_URL = 'https://chatgpt.com/settings/usage'
    const buttonMark = require.asset('plugins/@local/chatgpt-provider/assets/chatgpt-button-white-21.cb2b409af23c.svg')

    /** English copy. */
    const en = {
      nav: 'ChatGPT',
      title: 'ChatGPT',
      lead: 'Sign in with ChatGPT to use your ChatGPT plan as a model provider in DeepSeek Harness, without an API key.',
      loading: 'Loading the ChatGPT connection…',
      signedOutTitle: 'No ChatGPT account connected',
      signedOutBody: 'Signing in registers this installation as an app in your ChatGPT account. Eligible accounts can then use their ChatGPT plan for model requests from this harness.',
      signIn: 'Continue with ChatGPT',
      account: 'Account or workspace',
      profile: 'Connection {number}',
      addAccount: 'Add account or workspace',
      enablePlan: 'Enable ChatGPT plan usage',
      usingPlan: 'Using ChatGPT plan',
      welcome: 'Your ChatGPT plan is connected',
      welcomeBody: 'Eligible requests in DeepSeek Harness use your ChatGPT plan. You can manage this usage in ChatGPT settings.',
      gotIt: 'Got it',
      starting: 'Opening your browser…',
      waitingTitle: 'Finish signing in your browser',
      waitingBody: 'Your browser was opened at the ChatGPT sign-in page. Complete it there; this page updates by itself.',
      waitingBodyManual: 'Open the sign-in page below, complete it there, then return to this tab.',
      openSignInPage: 'Open the sign-in page',
      cancel: 'Cancel',
      signedInAs: 'Signed in',
      planReady: 'ChatGPT plan usage enabled',
      planMissing: 'ChatGPT plan usage not granted',
      planMissingBody: 'Allow plan usage on the ChatGPT consent screen to use models here.',
      refreshModels: 'Refresh models',
      refreshing: 'Refreshing…',
      refreshToken: 'Renew access',
      signOut: 'Sign out',
      signingOut: 'Signing out…',
      modelsTitle: 'Available models',
      modelCount: '{count} models',
      noModels: 'No models were reported. Refresh after the account is ready.',
      modelsHint: 'Pick one of these in the composer\'s model menu to use it. The provider id is {provider}.',
      expires: 'Access token expires {when}',
      footnote: 'ChatGPT plan usage is shared with your other apps. Usage limits are managed in ChatGPT settings.',
      usageLink: 'Manage usage',
      reauthTitle: 'Sign in again',
      reauthBody: 'The stored ChatGPT connection can no longer be refreshed. Sign in again to keep using ChatGPT models.',
      signOutUnconfirmed: 'Signed out locally; the remote session could not be confirmed. Remove this app in ChatGPT settings if needed.',
      errorTitle: 'Something went wrong',
      retry: 'Retry',
      providerUnknown: 'unknown',
    }

    /** Simplified Chinese copy. */
    const zh = {
      nav: 'ChatGPT',
      title: 'ChatGPT',
      lead: '使用 ChatGPT 账号登录，即可把 ChatGPT 套餐当作 DeepSeek Harness 的模型供应商使用，无需 API Key。',
      loading: '正在读取 ChatGPT 连接…',
      signedOutTitle: '尚未连接 ChatGPT 账号',
      signedOutBody: '首次登录时可选择账号和工作区，并决定是否允许 DeepSeek Harness 使用套餐。',
      signIn: '使用 ChatGPT 继续',
      account: '账号或工作区',
      profile: '连接 {number}',
      addAccount: '添加账号或工作区',
      enablePlan: '启用 ChatGPT 套餐',
      usingPlan: '正在使用 ChatGPT 套餐',
      welcome: '已启用 ChatGPT 套餐',
      welcomeBody: 'DeepSeek Harness 中符合条件的请求会使用你的 ChatGPT 套餐。你可以在 ChatGPT 设置中管理这些用量。',
      gotIt: '知道了',
      starting: '正在打开浏览器…',
      waitingTitle: '请在浏览器中完成登录',
      waitingBody: '浏览器已打开 ChatGPT 登录页。在那里完成后，本页会自动更新。',
      waitingBodyManual: '请打开下面的登录页面，完成后回到本页。',
      openSignInPage: '打开登录页面',
      cancel: '取消',
      signedInAs: '已登录',
      planReady: '已开启 ChatGPT 套餐用量',
      planMissing: '未授予 ChatGPT 套餐权限',
      planMissingBody: '在 ChatGPT 授权页允许使用套餐后，即可在这里调用模型。',
      refreshModels: '刷新模型',
      refreshing: '刷新中…',
      refreshToken: '续期访问令牌',
      signOut: '退出登录',
      signingOut: '正在退出…',
      modelsTitle: '可用模型',
      modelCount: '{count} 个模型',
      noModels: '没有获取到模型。账号就绪后可再刷新。',
      modelsHint: '在输入框的模型菜单中选择其中一个即可使用。供应商 ID 为 {provider}。',
      expires: '访问令牌到期时间：{when}',
      footnote: 'ChatGPT 套餐用量与其他应用共享，额度在 ChatGPT 设置中管理。',
      usageLink: '管理用量',
      reauthTitle: '请重新登录',
      reauthBody: '已保存的 ChatGPT 连接无法再续期，请重新登录以继续使用 ChatGPT 模型。',
      signOutUnconfirmed: '已在本地退出，但未能确认远端会话已撤销；如有需要，请在 ChatGPT 设置中移除本应用。',
      errorTitle: '出现错误',
      retry: '重试',
      providerUnknown: '未知',
    }

    /**
     * Fill `{name}` placeholders.
     * @param {string} template - copy with placeholders.
     * @param {Record<string, unknown>} values - replacements.
     * @returns {string} filled copy.
     */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /**
     * Call one Host route.
     * @param {string} path - route suffix.
     * @param {'GET' | 'POST'} [method] - HTTP method.
     * @param {object} [body] - settings action parameters.
     * @returns {Promise<any>} the envelope value; throws with the Host's message.
     */
    async function call(path, method = 'GET', body = {}) {
      let response
      try {
        response = await fetch(API + path, {
          method,
          headers: method === 'POST'
            ? { accept: 'application/json', 'content-type': 'application/json' }
            : { accept: 'application/json' },
          credentials: 'same-origin',
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        })
      } catch {
        throw new Error('Cannot reach the DeepSeek Harness Host.')
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`The Host answered ${response.status}.`)
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
        const message = failure?.message ?? `The Host answered ${response.status}.`
        throw new Error(failure?.requestId ? `${message} (${failure.requestId})` : message)
      }
      return payload.value
    }

    // The settings page and the shell share only the host's public account snapshot.
    const accountEvents = new EventTarget()
    let accountState = null
    const getAccount = () => accountState
    const subscribeAccount = notify => {
      accountEvents.addEventListener('change', notify)
      return () => accountEvents.removeEventListener('change', notify)
    }
    function publishAccount(value) {
      accountState = value
      accountEvents.dispatchEvent(new Event('change'))
    }
    async function readAccount() {
      const previous = accountState
      try {
        const value = await call('/state?models=0')
        if (accountState === previous) publishAccount(value)
      } catch {
        // A later focus or settings action retries the status read.
      }
    }

    function UsageLink({ t }) {
      return h('a', { className: 'cgpt-link', href: USAGE_URL, target: '_blank', rel: 'noopener noreferrer' }, t('usageLink'))
    }

    function PlanWelcome({ t }) {
      const value = useSyncExternalStore(subscribeAccount, getAccount)
      const dialog = useRef(null)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const clientId = value?.status === 'signed-in' && value.welcome ? value.activeId : null
      useEffect(() => {
        void readAccount()
        window.addEventListener('focus', readAccount)
        return () => window.removeEventListener('focus', readAccount)
      }, [])
      useEffect(() => {
        if (value?.status !== 'pending') return
        const timer = setTimeout(readAccount, 1500)
        return () => clearTimeout(timer)
      }, [value])
      useEffect(() => {
        if (!clientId) return
        setError('')
        const element = dialog.current
        element.showModal()
        return () => element.close()
      }, [clientId])
      if (!clientId) return null
      const dismiss = async () => {
        if (saving) return
        setSaving(true)
        try {
          publishAccount(await call('/welcome', 'POST', { clientId }))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }
      return h('dialog', {
        ref: dialog, 'aria-labelledby': 'cgpt-welcome-title',
        onCancel: event => { event.preventDefault(); void dismiss() },
        style: { maxWidth: 'min(400px, 85vw)', borderRadius: 12, padding: 24, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)' },
      },
      h('h2', { id: 'cgpt-welcome-title' }, t('welcome')),
      h('p', null, t('welcomeBody')),
      h(UsageLink, { t }), ' ',
      h('button', { type: 'button', autoFocus: true, disabled: saving, onClick: dismiss }, t('gotIt')),
      error && h('p', { role: 'alert' }, error))
    }

    function ComposerUsage({ directory, t }) {
      const provider = useSyncExternalStore(
        notify => directory.subscribe(notify), () => directory.getSnapshot().current?.provider,
      )
      const value = useSyncExternalStore(subscribeAccount, getAccount)
      useEffect(() => {
        if (provider === 'chatgpt') void readAccount()
      }, [provider])
      if (provider !== 'chatgpt' || !value?.signedIn || !value.plan?.sharing) return null
      return h('span', { style: { fontSize: 12 } }, t('usingPlan'), ' · ', h(UsageLink, { t }))
    }

    /** Settings page styles. */
    const styles = `
      .cgpt-page { display: flex; flex-direction: column; gap: 20px; max-width: 720px; }
      .cgpt-lead { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1.55; }
      .cgpt-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
      .cgpt-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .cgpt-card-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cgpt-body { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
      .cgpt-pills { display: flex; gap: 8px; flex-wrap: wrap; }
      .cgpt-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 10px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
      .cgpt-pill-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
      .cgpt-pill-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
      .cgpt-pill-idle { color: var(--dsw-alias-state-idle-primary); border-color: currentColor; }
      .cgpt-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .cgpt-button { appearance: none; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; }
      .cgpt-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .cgpt-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .cgpt-button:disabled { opacity: 0.55; cursor: default; }
      .cgpt-button-primary { display: inline-flex; align-items: center; gap: 8px; background: #000; color: #fff; border-color: transparent; min-height: 40px; }
      .cgpt-button-primary:hover:not(:disabled) { background: #202020; }
      .cgpt-error { border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 12px; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 1.55; }
      .cgpt-models { display: flex; gap: 6px; flex-wrap: wrap; }
      .cgpt-model { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 2px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .cgpt-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .cgpt-link { color: var(--dsw-alias-brand-primary); text-decoration: none; font-size: 13px; }
      .cgpt-link:hover { text-decoration: underline; }
      .cgpt-footnote { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
      @media (prefers-reduced-motion: reduce) { .cgpt-button { transition: none; } }
    `

    /**
     * One settings page for the ChatGPT provider.
     * @param {{ t: (key: string) => string }} props - injected copy.
     * @returns {import('react').ReactElement} the page.
     */
    function ChatGptSection({ t }) {
      const [state, setState] = useState({ phase: 'loading', value: undefined, error: undefined })
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const mounted = useRef(false)
      const latestRead = useRef(0)

      useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false; latestRead.current++ }
      }, [])

      const load = useCallback(async () => {
        const read = ++latestRead.current
        try {
          const value = await call('/state')
          if (mounted.current && latestRead.current === read) {
            setState({ phase: 'ready', value, error: undefined })
            publishAccount(value)
          }
        } catch (error) {
          if (mounted.current && latestRead.current === read) setState(current => ({ ...current, phase: 'error', error: error.message }))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const pending = state.value?.status === 'pending'
      useEffect(() => {
        if (!pending) return undefined
        const timer = setTimeout(load, 1500)
        return () => clearTimeout(timer)
      }, [pending, state, load])

      const run = async (action, work) => {
        setBusy(action)
        setNotice('')
        try {
          await work()
        } catch (error) {
          if (mounted.current) setNotice(error instanceof Error ? error.message : String(error))
          await load()
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const signIn = (options = {}) => run('sign-in', async () => {
        await call('/signin', 'POST', options)
        await load()
      })
      const cancel = () => run('cancel', async () => {
        await call('/cancel', 'POST')
        await load()
      })
      const signOut = () => run('sign-out', async () => {
        const value = await call('/signout', 'POST')
        await load()
        if (mounted.current && value?.revoked === 'unconfirmed') setNotice(t('signOutUnconfirmed'))
      })
      const refreshModels = () => run('models', async () => {
        await call('/models/refresh', 'POST')
        await load()
      })
      const renew = () => run('renew', async () => {
        await call('/refresh', 'POST')
        await load()
      })

      const value = state.value
      const failure = value?.error ?? value?.modelsError
      const errorMessage = notice || state.error || (failure?.requestId ? `${failure.message} (${failure.requestId})` : failure?.message)
      const status = value?.status ?? state.phase
      const profiles = value?.profiles ?? []
      const pickProfile = clientId => {
        const profile = profiles.find(entry => entry.clientId === clientId)
        if (profile?.status !== 'connected') return signIn({ clientId })
        return run('select', async () => { await call('/profiles/select', 'POST', { clientId }); await load() })
      }

      return h('div', { className: 'cgpt-page' },
        h('style', { key: 'styles' }, styles),
        h('header', { key: 'header' },
          h('h2', { className: 'cgpt-card-title', style: { fontSize: 18, marginBottom: 6 } }, t('title')),
          h('p', { className: 'cgpt-lead' }, t('lead')),
        ),
        h('section', { key: 'card', className: 'cgpt-card', 'aria-busy': status === 'loading' || pending },
          status === 'loading'
            ? h('p', { className: 'cgpt-body', role: 'status' }, t('loading'))
            : null,

          profiles.length > 0 && !pending
            ? h('div', { className: 'cgpt-actions' },
              h('label', null, t('account'), ' ', h('select', {
                value: value.activeId ?? '', disabled: !!busy,
                onChange: event => void pickProfile(event.target.value),
              }, !value.activeId && h('option', { value: '', disabled: true }, '—'),
              profiles.map(profile => h('option', { key: profile.clientId, value: profile.clientId },
                [profile.email ?? profile.name, format(t('profile'), { number: profile.number })].filter(Boolean).join(' · '))))),
              h('button', { type: 'button', className: 'cgpt-button', disabled: !!busy, onClick: () => void signIn({ newProfile: true }) }, t('addAccount')),
            ) : null,

          status === 'signed-out' || status === 'reauth-required'
            ? h('div', { key: 'out', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              h('h3', { className: 'cgpt-card-title' }, status === 'reauth-required' ? t('reauthTitle') : t('signedOutTitle')),
              h('p', { className: 'cgpt-body' }, status === 'reauth-required' ? t('reauthBody') : t('signedOutBody')),
              h('div', { className: 'cgpt-actions' },
                h('button', {
                  type: 'button', className: 'cgpt-button cgpt-button-primary', onClick: () => void signIn(), disabled: busy !== '',
                }, h('img', { src: buttonMark, width: 21, height: 21, alt: '' }), busy === 'sign-in' ? t('starting') : t('signIn')),
              ),
            )
            : null,

          status === 'pending'
            ? h('div', { key: 'pending', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              h('h3', { className: 'cgpt-card-title' }, t('waitingTitle')),
              h('p', { className: 'cgpt-body', role: 'status' }, value?.pendingUrl === undefined ? t('waitingBody') : t('waitingBodyManual')),
              value?.pendingUrl === undefined
                ? null
                : h('a', { className: 'cgpt-link', href: value.pendingUrl, target: '_blank', rel: 'noreferrer noopener' }, t('openSignInPage')),
              h('div', { className: 'cgpt-actions' },
                h('button', { type: 'button', className: 'cgpt-button', onClick: cancel, disabled: busy !== '' }, t('cancel')),
              ),
            )
            : null,

          status === 'signed-in'
            ? h('div', { key: 'in', style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              h('div', { className: 'cgpt-card-head' },
                h('div', null,
                  h('h3', { className: 'cgpt-card-title' }, t('signedInAs')),
                  h('p', { className: 'cgpt-body' }, value?.account?.email ?? value?.account?.name ?? '—'),
                ),
                h('div', { className: 'cgpt-pills' },
                  value?.plan?.sharing === true
                    ? h('span', { className: 'cgpt-pill cgpt-pill-ok' }, t('planReady'))
                    : h('span', { className: 'cgpt-pill cgpt-pill-warn' }, t('planMissing')),
                ),
              ),
              value?.plan?.sharing === true
                ? null
                : h('div', { key: 'plan', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  h('p', { className: 'cgpt-body' }, t('planMissingBody')),
                  h('button', {
                    type: 'button', className: 'cgpt-button', disabled: !!busy,
                    onClick: () => void signIn({ clientId: value.activeId, reconsent: true }),
                  }, t('enablePlan')),
                ),
              h('div', { className: 'cgpt-actions' },
                value.plan?.sharing && h('button', { type: 'button', className: 'cgpt-button', onClick: refreshModels, disabled: busy !== '' },
                  busy === 'models' ? t('refreshing') : t('refreshModels')),
                value.renewable && h('button', { type: 'button', className: 'cgpt-button', onClick: renew, disabled: busy !== '' }, t('refreshToken')),
                h('button', { type: 'button', className: 'cgpt-button', onClick: signOut, disabled: busy !== '' },
                  busy === 'sign-out' ? t('signingOut') : t('signOut')),
              ),
              value.plan?.sharing && h('div', { key: 'models', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                  h('h4', { className: 'cgpt-card-title', style: { fontSize: 13 } }, t('modelsTitle')),
                  h('span', { className: 'cgpt-meta' }, format(t('modelCount'), { count: Array.isArray(value?.models) ? value.models.length : 0 })),
                ),
                Array.isArray(value?.models) && value.models.length > 0
                  ? h('div', { className: 'cgpt-models' }, value.models.slice(0, 24).map(model => h('span', { key: model.id, className: 'cgpt-model', title: model.name }, model.id)))
                  : h('p', { className: 'cgpt-body' }, t('noModels')),
                h('p', { className: 'cgpt-footnote' }, format(t('modelsHint'), { provider: value?.provider ?? t('providerUnknown') })),
              ),
              value?.expiresAt === null || value?.expiresAt === undefined
                ? null
                : h('p', { className: 'cgpt-meta' }, format(t('expires'), { when: new Date(value.expiresAt).toLocaleString() })),
            )
            : null,

          errorMessage === undefined || errorMessage === ''
            ? null
            : h('div', { key: 'error', className: 'cgpt-error', role: 'alert' }, `${t('errorTitle')}: ${errorMessage}`),

          state.phase === 'error'
            ? h('div', { key: 'retry', className: 'cgpt-actions' },
              h('button', { type: 'button', className: 'cgpt-button', onClick: () => void run('reload', load) }, t('retry')),
            )
            : null,
        ),
        h('p', { key: 'foot', className: 'cgpt-footnote' },
          t('footnote'), ' ',
          h(UsageLink, { t }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the ChatGPT settings page.
       * @param {import('@deepseek-ai/cordis').Context} ctx - client context.
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'chatgpt-provider: copy')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'chatgpt',
          order: 35,
          label: () => t('nav'),
        }, props => h(ChatGptSection, { ...props, t })))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'chatgpt-plan-welcome',
        }, () => h(PlanWelcome, { t })))
        ctx.inject(['modelDirectories'], scope => {
          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock', id: 'chatgpt-plan-usage', order: 2,
            inject: sessionId => ({ directory: scope.modelDirectories.directoryFor(sessionId).store }),
          }, props => h(ComposerUsage, { ...props, t })))
        })
      },
    }
  },
})
