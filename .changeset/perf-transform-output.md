---
"@dudousxd/nestjs-catalog": patch
---

Fix batch transforms corrupting non-ASCII output: stdout was decoded one chunk at a time, so a
multi-byte UTF-8 character split across two pipe reads came back as replacement characters. It is
now decoded as one stream, as the streaming path already did. The streaming path also stops
rescanning a long output line from its start for every 64 KiB chunk of it, which was quadratic in
the line's length.
