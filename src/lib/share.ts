import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { assertSignature, isBytes } from './safe'
import { parsePending, type PendingTx } from './storage'

/** A single owner approval, small enough to paste into a chat message. */
export type SignatureShare = {
  /** SafeTx hash the signature is over. */
  id: Hex
  owner: Address
  signature: Hex
}

/** Everything a link can carry: a Safe to open and/or transactions to import. */
export type ShareLink = {
  safe?: Address
  chainId?: number
  txs?: PendingTx[]
  sig?: SignatureShare
  /** The link named a Safe/chain that its transactions do not belong to. */
  mismatch?: boolean
  /** How many transactions were ignored because they belong to another Safe/network. */
  skipped?: number
}

/** Percent-free base64url of a UTF-8 string. */
function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const base64 = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Check an imported transaction or list; an import never marks anything executed. */
export function parseShared(value: unknown): PendingTx[] {
  return (Array.isArray(value) ? value : [value]).map((item) => ({ ...parsePending(item), executedTxHash: undefined }))
}

/** Encode pending transactions into a URL-safe fragment value. */
export function encodeShare(items: PendingTx[]): string {
  return toBase64Url(JSON.stringify(items))
}

export function decodeShare(encoded: string): PendingTx[] {
  return parseShared(JSON.parse(fromBase64Url(encoded)))
}

function assertSignatureShare(value: unknown): SignatureShare {
  const share = value as SignatureShare
  if (
    !share ||
    typeof share !== 'object' ||
    !isBytes(share.id, 32) ||
    typeof share.owner !== 'string' ||
    !isAddress(share.owner) ||
    !isBytes(share.signature, 65)
  ) {
    throw new Error('Unrecognised signature')
  }
  return {
    id: share.id as Hex,
    owner: getAddress(share.owner),
    signature: assertSignature(share.signature),
  }
}

/** Encode a single signature as a compact, paste-friendly code. */
export function encodeSignatureShare(share: SignatureShare): string {
  return toBase64Url(JSON.stringify(share))
}

export function decodeSignatureShare(code: string): SignatureShare {
  return assertSignatureShare(JSON.parse(fromBase64Url(code)))
}

/**
 * Accept anything a signer might send: the bare code, a full URL containing
 * `#sig=…`, or raw JSON.
 */
export function parseSignatureShare(input: string): SignatureShare {
  const trimmed = input.trim()
  const fromUrl = trimmed.match(/[#&]sig=([^&\s]+)/)
  if (fromUrl) return decodeSignatureShare(fromUrl[1])
  if (trimmed.startsWith('{')) return assertSignatureShare(JSON.parse(trimmed))
  return decodeSignatureShare(trimmed)
}

function baseUrl(): string {
  return `${location.origin}${location.pathname}${location.search}`
}

/** A link that opens a Safe by address. */
export function buildSafeUrl(address: Address, chainId: number): string {
  const params = new URLSearchParams()
  params.set('safe', getAddress(address))
  params.set('chain', String(chainId))
  return `${baseUrl()}#${params.toString()}`
}

/** A link that opens a Safe and carries transactions/signatures to import. */
export function buildShareUrl(items: PendingTx[]): string {
  if (items.length === 0) return baseUrl()
  const params = new URLSearchParams()
  params.set('safe', items[0].safe)
  params.set('chain', String(items[0].chainId))
  params.set('txs', encodeShare(items))
  return `${baseUrl()}#${params.toString()}`
}

/** A link that opens a Safe and carries a single signature to import. */
export function buildSignatureUrl(share: SignatureShare): string {
  return `${baseUrl()}#sig=${encodeSignatureShare(share)}`
}

/** Parse the current URL fragment into a {@link ShareLink} (never throws). */
export function readShareLink(): ShareLink {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  if (!raw) return {}
  const params = new URLSearchParams(raw)
  const link: ShareLink = {}

  const safe = params.get('safe')
  if (safe && isAddress(safe)) link.safe = getAddress(safe)

  const chain = params.get('chain')
  if (chain && /^\d+$/.test(chain)) link.chainId = Number(chain)

  const txs = params.get('txs')
  if (txs) {
    try {
      link.txs = decodeShare(txs)
    } catch {
      /* ignore malformed payloads */
    }
  }

  const sig = params.get('sig')
  if (sig) {
    try {
      link.sig = decodeSignatureShare(sig)
    } catch {
      /* ignore malformed payloads */
    }
  }

  // Every entry must belong to the Safe and network the link advertises. The
  // advertisement is the link's own `safe`/`chain` when present, otherwise the first
  // entry — a payload with no decoration still names one Safe by starting with it.
  // Checking only the first entry would let a payload that *starts* consistent append
  // transactions for another Safe, all of which the banner would then misdescribe.
  const first = link.txs?.[0]
  const advertisedSafe = link.safe ?? first?.safe
  const advertisedChain = link.chainId ?? first?.chainId
  // `!== undefined` rather than truthiness: a nonsensical `chain=0` must not be able
  // to switch the check off.
  if (link.txs && link.txs.length > 0 && advertisedSafe !== undefined && advertisedChain !== undefined) {
    const kept = link.txs.filter(
      (tx) => tx.safe.toLowerCase() === advertisedSafe.toLowerCase() && tx.chainId === advertisedChain,
    )
    if (kept.length !== link.txs.length) {
      link.mismatch = true
      link.skipped = link.txs.length - kept.length
      link.txs = kept
    }
  }

  if (!link.safe && advertisedSafe) link.safe = advertisedSafe
  if (!link.chainId && advertisedChain) link.chainId = advertisedChain
  return link
}

/** Drop the link fragment from the address bar (keeps history clean). */
export function clearShareFromLocation(): void {
  try {
    history.replaceState(null, '', baseUrl())
  } catch {
    /* ignore */
  }
}
