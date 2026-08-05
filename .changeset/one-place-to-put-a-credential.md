---
"@dudousxd/nestjs-catalog-react": minor
---

The credential fields leave the console's screens

The connector editor and the workflow source node each offered a "Credential env
var" field beside the address. Two doors for one decision, and the question it
produced was "what is this second field" — a form asking the reader to
understand its implementation.

The credential goes in the connection string. Where that string may **rest** is
the store's decision — `allowInlineCredentials`, and the secret vault behind it
— not a question for a form, and not one whose answer changes per connection.

`secretEnvVar` is untouched on the model and `CredentialField` is still
exported, so a deployment that wants the name-only path can mount it. It is no
longer the console's default story.
