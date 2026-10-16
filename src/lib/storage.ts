import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { computeSafeTxHash, deserializeTx, isBytes, serializeTx } from './safe'

/** Serialized (JSON-safe) form of a Safe transaction. */
export type StoredTx = {
  to: string
  value: string
  data: string
  operation: number
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  nonce: string
}

export type PendingTx = {
  /** SafeTx hash — unique per (safe, nonce, tx). */
  id: Hex
  chainId: number
  safe: Address
  createdAt: number
  tx: StoredTx
  /** owner (lowercase) → 65-byte signature. */
  signatures: Record<string, Hex>
  executedTxHash?: Hex
}

export type TrackedSafe = {
  address: Address
  chainId: number
  addedAt: number
  label?: string
}

const PENDING_KEY = 'nvnmchain-multisig:pending:v1'
const SAFES_KEY = 'nvnmchain-multisig:safes:v1'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore quota / privacy mode */
  }
}

const isAddr = (v: unknown) => typeof v === 'string' && isAddress(v)
const isUint256 = (v: unknown) => typeof v === 'string' && /^\d{1,78}$/.test(v) && BigInt(v) < 1n << 256n

/** Check an untrusted queue entry; its `id` must be the SafeTx hash of its own transaction. */
export function parsePending(value: unknown): PendingTx {
  const item = (value ?? {}) as Partial<PendingTx>
  const raw = (item.tx ?? {}) as Partial<StoredTx>
  if (
    !Number.isSafeInteger(item.chainId) ||
    ![item.safe, raw.to, raw.gasToken, raw.refundReceiver].every(isAddr) ||
    ![raw.value, raw.safeTxGas, raw.baseGas, raw.gasPrice, raw.nonce].every(isUint256) ||
    !isBytes(raw.data) ||
    (raw.operation !== 0 && raw.operation !== 1)
  ) {
    throw new Error('Unrecognised transaction payload.')
  }
  const { chainId, safe, createdAt, executedTxHash } = item as PendingTx
  const tx = deserializeTx(raw as StoredTx)
  const id = computeSafeTxHash(BigInt(chainId), safe, tx)
  if (String(item.id).toLowerCase() !== id) throw new Error('A transaction does not match its SafeTx hash.')
  const signatures: Record<string, Hex> = {}
  for (const [owner, signature] of Object.entries(item.signatures ?? {})) {
    if (isAddr(owner) && isBytes(signature, 65)) signatures[owner.toLowerCase()] = signature
  }
  return {
    id,
    chainId,
    safe: getAddress(safe),
    createdAt: Number(createdAt) || Date.now(),
    tx: serializeTx(tx),
    signatures,
    executedTxHash: isBytes(executedTxHash, 32) ? executedTxHash : undefined,
  }
}

export function loadPending(): PendingTx[] {
  const stored = read<unknown>(PENDING_KEY, [])
  const list: PendingTx[] = []
  for (const item of Array.isArray(stored) ? stored : []) {
    try {
      list.push(parsePending(item))
    } catch {
      /* drop entries that fail the check */
    }
  }
  return list.sort((a, b) => b.createdAt - a.createdAt)
}

export function savePending(list: PendingTx[]): void {
  write(PENDING_KEY, list)
}

export function upsertPending(item: PendingTx): PendingTx[] {
  const list = loadPending().filter((p) => p.id !== item.id)
  list.unshift(item)
  savePending(list)
  return list
}

export function mergeSignature(id: Hex, owner: Address, signature: Hex): PendingTx[] {
  const list = loadPending().map((p) =>
    p.id === id ? { ...p, signatures: { ...p.signatures, [owner.toLowerCase()]: signature } } : p,
  )
  savePending(list)
  return list
}

export function removePending(id: Hex): PendingTx[] {
  const list = loadPending().filter((p) => p.id !== id)
  savePending(list)
  return list
}

export function markExecuted(id: Hex, txHash: Hex): PendingTx[] {
  const list = loadPending().map((p) => (p.id === id ? { ...p, executedTxHash: txHash } : p))
  savePending(list)
  return list
}

export function loadTrackedSafes(): TrackedSafe[] {
  return read<TrackedSafe[]>(SAFES_KEY, []).sort((a, b) => b.addedAt - a.addedAt)
}

export function trackSafe(entry: TrackedSafe): TrackedSafe[] {
  const list = loadTrackedSafes().filter(
    (s) => !(s.address.toLowerCase() === entry.address.toLowerCase() && s.chainId === entry.chainId),
  )
  list.unshift(entry)
  write(SAFES_KEY, list)
  return list
}

export function untrackSafe(address: Address, chainId: number): TrackedSafe[] {
  const list = loadTrackedSafes().filter(
    (s) => !(s.address.toLowerCase() === address.toLowerCase() && s.chainId === chainId),
  )
  write(SAFES_KEY, list)
  return list
}
