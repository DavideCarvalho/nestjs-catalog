---
"@dudousxd/nestjs-catalog-pipeline": minor
---

Serve the workflow routes the console asks for

The controller was ported without its five workflow endpoints, so the Ingestion
› Workflows screen answered `Cannot GET …/pipeline/workflows`. They are back:
`GET`/`POST` `workflows`, `DELETE workflows/:id`, `POST workflows/:id/run` and
`GET workflows/:id/connectors`.

`WorkflowLauncher` is registered and exported alongside them — a route that can
list workflows but not start one is a screen with a button that 404s.
