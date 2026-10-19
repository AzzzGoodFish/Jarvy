# Secrets

[Index](../index.md) · [Storage](storage.md) · [Connection](connection.md)

The owner's tokens, passwords and keys (A52). Values go in once, through Settings, and are never shown again.

## Master key and sealing

- `infra/vault/master-key.ts` finds or makes the master key: 32 random bytes, base64, in `<config>/jarvy/<installation>.key`, mode 0600, outside the data directory. `<config>` is `$XDG_CONFIG_HOME`, `~/.config`, or `%APPDATA%` on Windows. A key written by another process meanwhile is used rather than replaced.
- `infra/vault/cipher.ts` (`Cipher`, `Store.cipher`) loads the key the first time it is needed and logs where a new one was made. `seal(plain, context)` gives `enc:v1:` and base64 of IV, ciphertext and tag (AES-256-GCM, the context as associated data); `open` gives the plain text or null; `fingerprint` is the first 8 hex digits of an HMAC-SHA256 under the key.
- Contexts: `secret:<id>`, `credential:<connection id>`, `tls:root-key`, `tls:server-key`.

## What is sealed

| Data | Where | Unreadable under this key |
| --- | --- | --- |
| secret values | `secrets.value` | the secret is marked "Can't decrypt" in Settings; replacing the value fixes it |
| model credentials | `provider_credentials.credential_json` (v21 sealed existing rows) | reading fails with `credential_unreadable`; entering the key or signing in again replaces it |
| TLS private keys | `tls/root-key.sealed`, `tls/server-key.sealed` | a new root and server certificate are made, and devices must trust the new root |

## Schema (v21)

- `secrets`: id, owner, name (unique per owner among values), kind `value` or `ssh_key`, the Bot an SSH key belongs to (one each), description (one line, up to 200 characters), sealed value (up to 16 KB plain), fingerprint, created and updated times.
- `secret_grants`: secret, Bot, scope `always` or `once` (with its run), who granted it and when. Deleted with the secret, and with the Bot.
- `secret_uses`: secret (NULL once deleted), its name, Bot, time, how (`command`, `ssh_sign`), environment, History id, tool call, and what ran with placeholders.

## Asking for one

- `secrets.request {chatId, name, purpose}` posts a question card (A36) whose spec carries `secret: {name, purpose, exists, needsValue}`, and waits the same way; the Bot's activity is `asking`. When the Bot may already use a readable secret by that name, it returns at once.
- The card (`src/web/secrets/SecretRequestCard.tsx`) asks for a value when there is none or it doesn't open (`needsValue`), and offers to replace a saved one otherwise. The owner picks "Keep allowing" (until revoked in Settings) or "This time only", or declines. The value field is masked unless shown; the card warns when the page isn't a secure context and when a value is shorter than 8 characters.
- Allowing goes to `POST /api/secrets/requests/:chatId/:messageId {value?, scope}`, never to the message: the secret is created (its description is the purpose) or its value replaced, granted to the Bot that asked, and only then the card is settled with the chosen scope. Declining dismisses the card. A card whose call stopped waiting (a new message, a stop, a restart) can't be answered and saves nothing.
- "This time only" is a grant tied to the Bot's run in progress (`secret_grants.run_id`); it counts only while that run is open and is removed once it has ended.

## Using a secret

- `secrets.list` (chat gateway) gives the Bot the names, placeholders and descriptions of the secrets granted to it until revoked; never values.
- In a `bash` command the model writes `{{secret:NAME}}`. Before the command runs (`infra/pi/secret-placeholders.ts`), each becomes `${JARVY_SECRET_NAME}`: kept as is inside double quotes, wrapped in double quotes when unquoted, and closed out of single quotes (`'…'"${…}"'…'`, and the same for `$'…'`). In an unquoted heredoc it expands as written; in a quoted one (`<<'EOF'`) it would stay literal, so the call fails. Placeholders in comments are left alone.
- The values go into that command's environment only (`ExecOptions.secrets`), on the owner's computer and in a sandbox alike; the command text keeps the variables. Programs the command starts see the expanded value in their arguments, so the prompt prefers handing it over through the environment (`GH_TOKEN={{secret:…}} gh …`).
- A name the Bot has no grant for, or whose value doesn't open, fails the call before anything runs, naming `secrets.list` and `secrets.request`.
- Each command that uses secrets writes one `secret_uses` row per secret: Bot, time, environment, tool call and the command as written (with placeholders, up to 4,000 characters).
- `write` and `edit` content is never filled in.

## Masking

`Masker` (`shared/secret-mask.ts`) replaces every value the owner keeps (4 characters or longer) with its placeholder, and also its JSON-escaped, URL-encoded and XML-escaped forms and the base64 of it at all three byte alignments, standard and URL-safe (fragments of 8 characters or more). The service rebuilds it after any change to a secret. It is applied:

- to every tool result before Pi keeps it or the model sees it (Pi's `tool_result` hook), nested codemode calls included;
- to command output as it streams (`StreamMask` holds back the last few characters so a value split between chunks is still caught), so the live view and Pi's full-output file are masked too, and to the output a finished tool shows live;
- to every batch and notice the Bot receives, so a value a person pasted into the chat reaches the Bot masked; the person's own message is stored as written;
- to the arguments of the Bot's Jarvy tools, so its messages, notices and titles never carry a value.

What the model itself writes is kept as written. Images can't be masked, and a value a Bot transforms on purpose isn't caught; the use log is the answer to that.

## API and Settings

- `GET /api/secrets` lists secrets without values, with grants, use count and last use, and where the master key is. `POST` adds one; `PUT /:id` changes the description and/or replaces the value; `DELETE /:id` deletes it; `PUT /:id/grants/:botId {granted}` grants or revokes; `GET /:id/uses` lists the last 100 uses.
- Errors are coded (`secret_name_invalid`, `secret_name_taken`, `secret_value_missing`, `secret_value_too_long`, `secret_description_invalid`, `secret_missing`) and worded in the interface.
- Settings → Secrets (`src/web/secrets/`) lists secrets with their description and how many Bots can use them; opening one shows its fingerprint, update time and use count, a switch per Bot, a form to change the description or replace the value, recent uses, and Delete with an in-place confirmation. The master key section shows the key file's location and asks to back it up with Jarvy.
