# ChatGPT provider

Use your ChatGPT plan as a model provider. The bundle implements OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) open-source flow and exposes it as the `chatgpt` provider route, so a session can run on models your ChatGPT account already pays for.

## Sign in to an account or workspace

Settings → **ChatGPT** opens the flow with **Continue with ChatGPT**. The Host binds an IPv4 loopback listener on `127.0.0.1:1455` (configurable), opens the system browser at the ChatGPT authorization endpoint with a fresh `state`, `nonce`, and PKCE verifier, and waits for the callback.

The first sign-in registers this installation as a user-defined agent: the authorization request carries `client_id=dynamic_agent_client`, the app name, and a stable `ext_agent_host_id`. The callback returns the issued `client_id`, which is saved **before** the one-time code is exchanged, so a failed exchange never registers a second app. Later sign-ins reuse the registration. The browser receives a login hint when available. The Host checks the verified subject before replacing the saved connection.

Back in the page, the card shows the verified account, whether the grant includes the `chatgpt.tokens.use.direct` permission that enables plan usage, the access token's expiry, and the models the account advertises.

## What the page can do

- **Sign in** — start the browser flow; the page polls its own status while the browser is open, and offers the authorization link when a browser cannot be launched.
- **Cancel** — withdraw a running attempt.
- **Refresh models** — re-read the account's `GET /v1/models` listing.
- **Enable ChatGPT plan usage** opens consent for the saved registration after identity-only sign-in.
- **Renew access** requests a rotation once the issuer's refresh window has opened.
- **Add account or workspace** creates a separate registration. The account picker switches the active connection.
- **Sign out** revokes the renewable session and clears its local tokens. The registration stays available for reconnection.

## Using the models

After plan authorization, the composer's model menu lists the account's visible models under **ChatGPT**. When a ChatGPT model is selected, the composer identifies the plan and links to usage settings. Requests stream through `POST /v1/responses`.

The wire is the documented plan-usage shape: `store: false`, `stream: true`, system guidance in `instructions`, functions in the `dsh` tool namespace, images as `input_image` data URLs, and no `temperature`, `max_output_tokens`, `previous_response_id`, or `metadata`. The provider's stream events become harness text, reasoning, and tool-call chunks, so tool rounds, reasoning summaries, and token usage all reach the session.

## Credentials

The credential store binds each registration to its issuer and resource. Official registrations live under `chatgpt-provider/default`. Local stand-ins have separate records. The Host saves a rotation with a new ID token as pending and verifies it before enabling its access token. It can resume verification after a restart. The stable host ID lives under `chatgpt-provider/host`. The settings page receives public connection and model metadata.

## When it fails

| Symptom | Meaning |
|---|---|
| `ACCOUNT_SIGN_IN_REQUIRED` | No grant, or the grant can no longer be refreshed. Sign in again. |
| `QUOTA` | ChatGPT plan usage is limited or exhausted; see ChatGPT Settings → Usage. |
| `AUTH` | Check the selected account, granted permissions and workspace policy. |
| `RATE_LIMIT` | The provider rate-limited the request. Retry later. |
| `SERVER` | The usage service or identity verifier is temporarily unavailable. Retry later. |
| `UNSUPPORTED_OPTION` | The request carried `stop` sequences, which this route does not accept. |
| `CONTEXT_WINDOW_EXCEEDED` | The request exceeded the model's window; start a new session or compact. |

## Limits

Reasoning blocks from earlier turns are not replayed because `store: false` keeps no server-side state. Streamed requests have a fixed timeout and are not retried by the adapter; the harness's own retry policy applies at step boundaries.
