---
"@dudousxd/nestjs-catalog": patch
---

Fix a transform's stderr losing non-ASCII characters in error messages: like stdout, it was decoded
one chunk at a time, so a multi-byte character split across two pipe reads became replacement
characters. Both the batch and the streaming path now decode it as one stream.
