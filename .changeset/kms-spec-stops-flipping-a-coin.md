---
"@dudousxd/nestjs-catalog-secrets-aws": patch
---

Stop asserting that random ciphertext does not contain two letters

`kms.vault.spec.ts` checked `expect(sealed.ciphertext).not.toContain('pw')` to
show the password was not sitting in what gets stored. `p` and `w` are both in
the base64 alphabet, so the pair turns up in random ciphertext by chance — the
case failed roughly two runs in five.

A test that fails on a coin flip is worse than no test, because it teaches
people that red means nothing. It was also asserting the wrong thing: a
two-character fragment of a secret, against an encoding rather than against the
bytes.

It now decodes the ciphertext and looks for the **whole** secret in the bytes.
Deterministic — 15 consecutive runs, no failures — and it still catches the only
bug the line exists for: mutating `seal` to store the plaintext instead of the
AES output turns it red.
