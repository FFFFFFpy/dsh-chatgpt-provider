# ChatGPT provider

Use your ChatGPT plan as a model provider. The bundle implements OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) open-source flow and exposes it as the `chatgpt` provider route, so a session can run on models your ChatGPT account already pays for.

## Sign in once per harness profile

Settings → **ChatGPT** has one primary action, **Sign in with ChatGPT**. The Host binds an IPv4 loopback listener on `127.0.0.1:1455` (configurable), opens the system browser at the ChatGPT authorization endpoint with a fresh `state`, `nonce`, and PKCE verifier, and waits for the callback.

The first sign-in registers this installation as a user-defined agent: the authorization request carries `client_id=dynamic_agent_client`, the app name, and a stable `ext_agent_host_id`. The callback returns the issued `client_id`, which is saved **before** the one-time code is exchanged, so a failed exchange never registers a second app. Later sign-ins reuse that registration and send the retained ID token as `id_token_hint`.

Back in the page, the card shows the verified account, whether the grant includes the `chatgpt.tokens.use.direct` permission that enables plan usage, the access token's expiry, and the models the account advertises.

## What the page can do

- **Sign in** — start the browser flow; the page polls its own status while the browser is open, and offers the authorization link when a browser cannot be launched.
- **Cancel** — withdraw a running attempt.
- **Refresh models** — re-read the account's `GET /v1/models` listing.
- **Renew access** — force a refresh of the access token.
- **Sign out** — revoke the renewable session at the issuer's revocation endpoint, then delete the local record.

## Using the models

After sign-in, the composer's model menu lists the account's models under **ChatGPT**. Selecting one makes it the default for new sessions. Requests stream through `POST /v1/responses`.

The wire is the documented plan-usage shape: `store: false`, `stream: true`, system guidance in `instructions`, tools as function tools, images as `input_image` data URLs, and no `temperature`, `max_output_tokens`, `previous_response_id`, or `metadata`. The provider's stream events become harness text, reasoning, and tool-call chunks, so tool rounds, reasoning summaries, and token usage all reach the session.

## Credentials

Tokens never enter configuration. The grant lives in the harness credential store as the record `chatgpt-provider/default`, written through `modifyRecord` so a rotating refresh token is durable before it is used. The host identifier is a separate record, `chatgpt-provider/host`. Configuration surfaces and this page only ever see account, plan, and model metadata.

## When it fails

| Symptom | Meaning |
|---|---|
| `ACCOUNT_SIGN_IN_REQUIRED` | No grant, or the grant can no longer be refreshed. Sign in again. |
| `QUOTA` | ChatGPT plan usage is limited or exhausted; see ChatGPT Settings → Usage. |
| `AUTH` | The account, workspace, or policy is not eligible for plan usage on this route. |
| `UNSUPPORTED_OPTION` | The request carried `stop` sequences, which this route does not accept. |
| `CONTEXT_WINDOW_EXCEEDED` | The request exceeded the model's window; start a new session or compact. |

## Limits

One ChatGPT account per harness profile. Reasoning blocks from earlier turns are not replayed because `store: false` keeps no server-side state. Streamed requests have a fixed timeout and are not retried by the adapter; the harness's own retry policy applies at step boundaries.
