# nip46

[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) remote
signing (nsec bunker) — **experimental**. No build step. One file:
[`nip46.js`](nip46.js).

Part of [nostr-client](https://github.com/nostr-client) — a modular, composable
nostr client where each repo does one thing.

**Live demo:** https://nostr-client.github.io/nip46/

## Use

```js
import { bunkerSigner, loginWithBunker } from 'https://nostr-client.github.io/nip46/nip46.js'

// NIP-07-shaped signer over an encrypted relay RPC to your bunker
const signer = await bunkerSigner('bunker://<pubkey>?relay=wss://…&secret=…')
await signer.getPublicKey()
await signer.signEvent({ kind: 1, content: 'hi', tags: [] })

// or: connect AND announce via the standard contract in one call —
// window.nostrSigner + 'nostr:login', so every component just works
await loginWithBunker(uri)
```

- ephemeral client key per session; requests are NIP-44 encrypted kind-24133
  events over the bunker's relays (pinned nostr-tools does the crypto)
- `auth_url` challenges open in a new tab (override with `onAuthUrl`)
- works with nsec.app, Amber, nsecBunker-style signers

**Status: experimental** — the RPC follows the spec, but bunker
implementations vary; tested shapes are `connect`/`get_public_key`/
`sign_event` with `ack`/JSON responses. Issues welcome.

## Why a separate repo (not part of login)?

This is exactly the swapability the
[contract](https://nostr-client.github.io/CONTRACT.md) promises: *any* module
that sets `window.nostrSigner` and fires `nostr:login` is a login. The login
button, the bunker, and whatever comes next stay independent and equal.

## License

AGPL-3.0-or-later
