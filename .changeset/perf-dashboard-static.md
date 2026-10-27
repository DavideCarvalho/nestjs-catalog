---
"@dudousxd/nestjs-catalog-dashboard": patch
---

Serve the console with less disk work: the rewritten `index.html` is kept between requests and
rendered again only when the file's mtime or size changes (so a rebuilt bundle is still picked up
without a restart), and assets are streamed from disk instead of read whole into memory on every
request.
