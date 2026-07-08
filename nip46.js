/**
 * nip46.js — NIP-46 remote signing (nsec bunker). EXPERIMENTAL.
 * No build step. Crypto (ephemeral key + NIP-44 encryption) comes from
 * pinned nostr-tools CDN URLs, loaded lazily.
 *
 * Part of https://github.com/nostr-client — one repo, one thing.
 * License: AGPL-3.0-or-later
 *
 * Usage:
 *   import { bunkerSigner } from 'https://nostr-client.github.io/nip46/nip46.js'
 *
 *   const signer = await bunkerSigner('bunker://<pubkey>?relay=wss://…&secret=…')
 *   const pubkey = await signer.getPublicKey()      // the USER's pubkey (hex)
 *   const signed = await signer.signEvent({ kind: 1, content: 'hi', tags: [] })
 *   signer.close()
 *
 * The returned signer is NIP-07-shaped, so it plugs straight into the
 * nostr-client contract (window.nostrSigner + 'nostr:login').
 */

import { Pool } from 'https://nostr-client.github.io/pool/pool.js'

const TOOLS = 'https://esm.sh/nostr-tools@2.10.4'
const KIND = 24133
const HEX64 = /^[0-9a-f]{64}$/

/** Parse a bunker://<remote-signer-pubkey>?relay=…&relay=…&secret=… URI. */
export function parseBunkerUri(uri) {
  const m = /^bunker:\/\/([0-9a-f]{64})(\?.*)?$/i.exec(String(uri).trim())
  if (!m) throw new Error('not a bunker:// URI')
  const params = new URLSearchParams(m[2] ?? '')
  const relays = params.getAll('relay')
  if (!relays.length) throw new Error('bunker URI has no relay= parameter')
  return { remotePubkey: m[1].toLowerCase(), relays, secret: params.get('secret') ?? '' }
}

/**
 * Connect to a remote signer. Returns a NIP-07-shaped signer:
 * { type: 'nip46', getPublicKey(), signEvent(evt), close() }.
 * onAuthUrl is called if the bunker requires a browser auth step
 * (default: window.open).
 */
export async function bunkerSigner(uri, { onAuthUrl, timeout = 30_000 } = {}) {
  const { remotePubkey, relays, secret } = parseBunkerUri(uri)
  const [{ generateSecretKey, getPublicKey, finalizeEvent }, nip44] = await Promise.all([
    import(`${TOOLS}/pure`),
    import(`${TOOLS}/nip44`),
  ])

  const clientSecret = generateSecretKey()
  const clientPubkey = getPublicKey(clientSecret)
  const conversationKey = nip44.v2.utils.getConversationKey(clientSecret, remotePubkey)
  const pool = new Pool(relays)
  const pending = new Map() // request id -> { resolve, reject, timer }
  let requestCounter = 0

  const openAuth = onAuthUrl ?? ((url) => {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
  })

  const sub = pool.subscribe(
    [{ kinds: [KIND], '#p': [clientPubkey], authors: [remotePubkey] }],
    {
      onEvent: (event) => {
        let response
        try { response = JSON.parse(nip44.v2.decrypt(event.content, conversationKey)) } catch { return }
        const waiter = pending.get(response.id)
        if (!waiter) return
        if (response.result === 'auth_url') { openAuth(response.error); return } // keep waiting
        pending.delete(response.id)
        clearTimeout(waiter.timer)
        if (response.error) waiter.reject(new Error('bunker: ' + response.error))
        else waiter.resolve(response.result)
      },
    }
  )

  function request(method, params) {
    const id = 'nc' + (requestCounter++) + Math.random().toString(36).slice(2, 8)
    const content = nip44.v2.encrypt(JSON.stringify({ id, method, params }), conversationKey)
    const event = finalizeEvent({
      kind: KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', remotePubkey]],
      content,
    }, clientSecret)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`bunker: ${method} timed out after ${timeout / 1000}s`))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      pool.publish(event).then((results) => {
        if (!results.some((r) => r.ok)) {
          const waiter = pending.get(id)
          if (waiter) { pending.delete(id); clearTimeout(waiter.timer); reject(new Error('bunker: no relay accepted the request')) }
        }
      })
    })
  }

  // handshake
  const ack = await request('connect', [remotePubkey, secret])
  if (ack !== 'ack' && ack !== secret) console.warn('[nip46] unexpected connect response:', ack)

  let userPubkey = null

  return {
    type: 'nip46',
    remotePubkey,
    async getPublicKey() {
      if (!userPubkey) {
        userPubkey = await request('get_public_key', [])
        if (!HEX64.test(userPubkey ?? '')) throw new Error('bunker returned an invalid pubkey')
      }
      return userPubkey
    },
    async signEvent(evt) {
      const template = { created_at: Math.floor(Date.now() / 1000), tags: [], content: '', ...evt }
      const signed = JSON.parse(await request('sign_event', [JSON.stringify(template)]))
      if (!HEX64.test(signed?.id ?? '')) throw new Error('bunker returned an invalid event')
      return signed
    },
    close() {
      sub.close()
      pool.close()
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('bunker: closed')) }
      pending.clear()
    },
  }
}

/**
 * Convenience for composed pages: connect and announce through the standard
 * contract (window.nostrSigner + 'nostr:login'), same as <nostr-login> does.
 */
export async function loginWithBunker(uri, opts) {
  const signer = await bunkerSigner(uri, opts)
  const pubkey = await signer.getPublicKey()
  window.nostrSigner = signer
  window.nostrPubkey = pubkey
  window.dispatchEvent(new CustomEvent('nostr:login', { detail: { pubkey, signer } }))
  return signer
}
