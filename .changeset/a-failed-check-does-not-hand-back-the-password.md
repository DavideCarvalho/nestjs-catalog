---
"@dudousxd/nestjs-catalog-pipeline": patch
---

A failed connection check no longer returns the credential

`POST pipeline/connections/:id/check` asks for `catalog:read`, and a probe that
fails throws with the address in its message — `${url} answered 401.` for an
HTTP source, the driver's own text for a SQL one. A connection URL is the
credential, so the softest scope in the system was reading the strongest secret
in it, through an error string rather than through the config the redaction was
built to guard.

The process log still gets the message whole. The response is redacted:
password, query string and fragment go, scheme, host, path and username stay —
because which host refused, and as whom, is the entire value of a failed check.
