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
2. Choose **Sign in with ChatGPT**; the system browser opens the ChatGPT sign-in page.
3. Finish there, then return to the harness. The page updates itself.
4. Open the composer's model menu and pick a ChatGPT model.
5. Send a message.

## What is stored, and where

- The OAuth grant (access token, rotating refresh token, retained ID token, issued `client_id`, verified subject and email) lives in the harness credential store under the record key `chatgpt-provider/default`, never in configuration and never in browser storage.
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
| `sendHostId` | `true` | Send `ext_agent_host_id` on authorization requests |
| `browserCommand` | empty | Launcher command instead of the platform default |
| `defaultInput` | `[text, image]` | Modalities claimed for a model that declares none |
| `defaultContextWindow` | `128000` | Context window assumed when the catalog does not size a model |
| `reasoningEfforts` | `[low, medium, high]` | Effort ids offered when a model declares none |
| `models` | empty | Explicit catalog instead of the account's list |
| `modelCacheSeconds` | `600` | Freshness of a fetched model list |
| `requestTimeoutMs` | `180000` | Deadline for one Responses request, including the streamed body |
| `signInTimeoutMs` | `300000` | How long a started sign-in waits for the browser |
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

- **One account per harness profile.** This version stores a single ChatGPT registration; a second account replaces it.
- **The ChatGPT plan route rejects fields an ordinary API accepts.** `temperature`, `max_output_tokens`, `top_p`, `metadata`, and `previous_response_id` are never sent, and `stop` sequences fail with `UNSUPPORTED_OPTION`.
- **Reasoning is not replayed.** With `store: false`, earlier reasoning blocks are omitted from later requests; text and tool calls are preserved.
- **Eligibility is OpenAI's.** An account, workspace, or policy without ChatGPT plan usage fails with `ACCOUNT_SIGN_IN_REQUIRED` or `AUTH`, and the error names the provider code.
- **Usage is shared.** The ChatGPT five-hour limit is shared across every app using the plan, and limits are managed in ChatGPT Settings → Usage.
- **Sign-out revokes best effort.** If the revocation endpoint cannot be reached, credentials are cleared locally and the page says remote revocation was not confirmed.

## Tests

Both suites run under plain Node with no harness installation and no network: they start a local stand-in for the authorization server and the Responses API.

```sh
node test/run.mjs           # OAuth, token store/refresh, stream translation, error mapping
node test/routes.test.mjs   # the settings API envelope and configuration normalization
```

## Message contract

- System guidance travels in `instructions`.
- History `system`/`developer` messages become `developer` items.
- Assistant tool calls become `function_call` items and tool results become `function_call_output` items, so tool rounds replay correctly.
- Images are projected through the attachment service into `input_image` data URLs; files contribute the harness's deterministic file handle text.
