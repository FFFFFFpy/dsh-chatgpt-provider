# ChatGPT provider

Sign in with ChatGPT and use a ChatGPT plan as a model provider in DeepSeek Harness — no API key, no separate billing path.

The bundle registers one provider route, `chatgpt`, that speaks the [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) open-source flow: a public OAuth client with dynamic registration, PKCE over a loopback callback, a stable `ext_agent_host_id`, and `POST {api}/responses` with `store: false`, `stream: true`, and the OAuth access token as the bearer credential.

## What it adds

| Surface | Where it appears |
|---|---|
| `chatgpt` provider route | Settings → Models directory, the composer's model menu |
| Model catalog | Whatever the signed-in account lists at `GET /v1/models` (`visibility: "list"`) |
| Sign in / sign out | Settings → **ChatGPT** page |
| Streaming inference | Any session whose model is a `chatgpt` route model |

## Use it

1. Open **Settings → ChatGPT**.
2. Choose **Continue with ChatGPT**. In the browser, select the account and workspace and grant plan usage to use models.
3. Return to the harness. If you granted identity access only, choose **Enable ChatGPT plan usage** when you want to use models.
4. Open the composer's model menu and pick a ChatGPT model.
5. Send a message.

## What is stored, and where

- The harness credential store keeps the official registrations in `chatgpt-provider/default`, keyed by the issued client ID for each account and workspace. A loopback deployment uses its own credential record. Older grants lack a recorded issuer and resource. The upgrade retains their registration and prompts for sign-in once.
- The host identifier (`urn:uuid:…`) lives beside it under `chatgpt-provider/host` and is reused across sign-ins.
- The settings page never receives a token; the JSON API sends only account, plan, and model metadata.

## Configuration

Every field is optional. The row is `chatgpt-provider` in the profile's `cordis.patch.yml`.

| Field | Default | Meaning |
|---|---|---|
| `appName` | `DeepSeek Harness` | `agent_name_hint` shown on the consent screen for a first registration |
| `redirectPort` | `1455` | Loopback callback port; `0` lets the OS choose |
| `authBaseURL` | `https://auth.openai.com` | Authorization server; change only for a local stand-in |
| `apiBaseURL` | `https://api.openai.com/v1` | API root and OAuth resource audience |
| `sendHostId` | `true` | The official issuer always receives the host ID. A loopback stand-in can disable it. |
| `browserCommand` | empty | Launcher command instead of the platform default |
| `defaultInput` | `[text, image]` | Modalities claimed for a model that declares none |
| `defaultContextWindow` | `128000` | Context window assumed when the catalog does not size a model |
| `reasoningEfforts` | `[low, medium, high]` | Effort ids offered when a model declares none |
| `models` | empty | Explicit catalog instead of the account's list |
| `modelCacheSeconds` | `600` | Freshness of a fetched model list |
| `requestTimeoutMs` | `180000` | Deadline for one Responses request, including the streamed body |
| `signInTimeoutMs` | `300000` | How long a started sign-in waits for the browser |
| `promptCacheKey` | `true` | Send a session-scoped `prompt_cache_key` so one conversation keeps reaching the same cache population |
| `sessionAffinity` | `both` | Session-affinity request header spelling: `both`, `session_id`, `session-id`, or `none` |
| `trace` | `false` | Log every Responses stream event type at debug level |

```yaml
- id: chatgpt-provider
  name: '@local/chatgpt-provider'
  config:
    redirectPort: 1455
    defaultContextWindow: 272000
    models:
      - id: gpt-6.2-sol
        name: GPT-6.2 Sol
        contextWindow: 272000
        input: [text, image]
        reasoningEfforts: [low, medium, high]
```

## Limits

- **Account selection.** Use **Add account or workspace** for a separate registration. Select a saved connection to use its models. Signing out clears its tokens and retains its client ID for the next sign-in.
- **The ChatGPT plan route rejects fields an ordinary API accepts.** `temperature`, `max_output_tokens`, `top_p`, `metadata`, and `previous_response_id` are never sent, and `stop` sequences fail with `UNSUPPORTED_OPTION`.
- **Reasoning is not replayed.** With `store: false`, earlier reasoning blocks are omitted from later requests; text and tool calls are preserved.
- **Eligibility.** Missing plan permission or denied API admission produces `AUTH`. An expired or revoked renewable session requires sign-in. The settings page can request plan permission for an existing registration.
- **Usage depends on the plan.** Plus shares a five-hour limit across connected apps. This particular limit does not apply to Pro. Manage app usage in ChatGPT Settings → Usage. [Tracking usage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage)
- **Sign-out revokes best effort.** If the revocation endpoint cannot be reached, credentials are cleared locally and the page says remote revocation was not confirmed.

## Tests

After `npm ci`, run the existing suites with Node. The integration suite uses a local stand-in for OAuth and the Responses API.

```sh
node test/run.mjs           # OAuth, token store/refresh, stream translation, error mapping
node test/routes.test.mjs   # the settings API envelope and configuration normalization
```

## Message contract

- System guidance leads `input` as a `developer` message. The top-level `instructions` field is never sent: from GPT-6.2 on it is appended after `input`, outside every eligible cache prefix, and billed as uncached input on every request.
- The route declares `systemPromptUpdate: 'in-history'`, so the harness appends prompt updates after the cached history instead of rewriting the first system node.
- Usage buckets are disjoint: `input_tokens` folds in cached reads and cache writes, so the adapter subtracts both back out and reports `cacheReadTokens` / `cacheWriteTokens` only when the model provides them.
- Every request carries `prompt_cache_key`. With a session it is `dsh:<sessionId>`; a caller without one gets a key derived from the stable head of its prompt. The key does not alter the prompt — it keeps a conversation's requests on one cache population, because without it the plan route balances requests across machines holding different cached prefixes (an identical prefix then reads at 95% on one machine and 0% on another). Set `promptCacheKey: false` on a route that rejects the field.
- The body key alone does not make the route sticky, so each request also sends the conversation id as a `session_id` / `session-id` request header (`sessionAffinity`), and replays any `x-codex-turn-state` the server returns for that conversation. A rejected turn state is forgotten and the request retried once without it.
- History `system`/`developer` messages become `developer` items.
- Tools are declared in the `dsh` namespace. Assistant calls and tool results replay with that namespace and their original call IDs. Tool results can contain both text and images.
- Images are projected through the attachment service into `input_image` data URLs; files contribute the harness's deterministic file handle text.

The sign-in button uses the [official DevKit mark](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/assets/brand/chatgpt-button-white-21.svg).
