---
"@dudousxd/nestjs-catalog-react": patch
---

Say which library is actually drawing, not which one was asked for

Found on a real board the moment the card picker shipped: a saved query named
`visx`, nobody had registered it, and the card drew the built-in bars — correctly
— while the control read "follows query (visx)".

The fallback is right and it is silent, so the label has to be the thing that
says so. It now reads "follows query (visx — not installed, drawing built-in)".

A control that reports an intention the card is not honouring is worse than one
that reports nothing: it is the exact failure the picker was built from a
registry to avoid, arriving through the default option instead.
