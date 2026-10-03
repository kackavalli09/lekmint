# External wallet identity compatibility

Protocol unit responses were checked against the live mint on 2026-08-26.
The new icon response was checked against the local production build and must
be smoke-tested at its canonical URL after this change is published. Wallet
compatibility was checked against the source revisions below.

## Mint metadata contract

Wallets connect to `https://lekmint.cash/api` and receive:

- `GET /v1/info`: `name: "Lek Mint"` and `icon_url: "https://lekmint.cash/api/v1/icon-352e7e44.png"`
- `GET /v1/keys`: every keyset has `unit: "lek"`
- `GET /v1/keysets`: every keyset has `unit: "lek"`
- Lek Mint token envelopes and issuance responses use `unit: "lek"`

The icon endpoint serves a 256×256 optimized PNG with
`Cache-Control: public, max-age=31536000, immutable`. The compatibility script
at `artifacts/api-server/scripts/cashu-v1-compat.e2e.ts` checks these fields,
fetches the current build's icon, and exercises issuance and swap. Its
content-hashed URL allows the image to be cached immutably without leaving
wallets stuck on stale branding after a future icon change.

After publishing, run the dedicated read-only smoke check. It performs only
`GET` requests and verifies the exact icon URL wallets receive:

```sh
API_BASE=https://lekmint.cash/api \
node artifacts/api-server/scripts/cashu-identity-smoke.mjs
```

Do not point `cashu-v1-compat.e2e.ts` at production. That stateful test creates
synthetic issuance and redemption records and belongs only on development or
isolated test infrastructure.

## Browser wallet: cashu.me

Source revision checked: `cashubtc/cashu.me@be9a3ed8073c48139092405a2d891aed5446c68a`.

- Mint add/details components read NUT-06 `icon_url` and render it.
- Balance display derives custom labels from the keyset unit. Known Bitcoin
  units get special formatting; unknown units are displayed uppercased, so
  `lek` is shown as `LEK`.

Expected result after publishing this change: Lek Mint uses its branded icon
and balances are labeled `LEK`.

## Android wallet: Minibits

Source revision checked: `minibits-cash/minibits_wallet@7d6be05eab7d328a706305f7df5b956f5cbdfc5a`.

- The mint details and NFC screens read and render NUT-06 `icon_url`, so the
  Lek Mint icon is supported.
- Custom unit support is currently restricted by the wallet's `MintUnit`
  allowlist to `btc`, `sat`, `msat`, `usd`, and `eur`. `lek` is not included.
  Several flows also default to `sat`.

Therefore, if Minibits shows a Lek Mint balance as sats (or cannot add/use the
mint) while the HTTP responses above contain `unit: "lek"`, that is a wallet
limitation rather than missing mint metadata.

Upstream report:

> A Cashu mint advertises an active keyset with the custom NUT-02 unit `lek`
> and emits tokens with `unit: "lek"`, but Minibits treats or labels the
> balance as sats. NUT-02 says wallets must respect each keyset's `unit` and
> support multiple keysets. Please preserve unknown unit strings through mint
> discovery, proof storage, balance grouping, token receive/send, and display
> instead of narrowing them to the built-in `MintUnits` allowlist or falling
> back to `sat`. The mint's NUT-06 `icon_url` already renders correctly.

References:

- NUT-02 keyset units: https://cashubtc.github.io/nuts/02/
- NUT-06 mint icon: https://cashubtc.github.io/nuts/06/
- Minibits source: https://github.com/minibits-cash/minibits_wallet
- cashu.me source: https://github.com/cashubtc/cashu.me