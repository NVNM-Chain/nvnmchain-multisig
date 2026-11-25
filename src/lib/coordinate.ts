import { keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { safeAbi } from './abi'
import { SAFE_ADDRESSES } from './safeArtifacts'
import { SAFE_MASTER_COPY_SLOT, normalizeSignatureV, proxyRuntimeProblem, recoverSigner, safeIdentityProblem, type SafeTxParams } from './safe'
import { loadPending, mergeSignature, savePending, type PendingTx } from './storage'
import type { SignatureShare } from './share'

/**
 * The singleton's runtime code never changes, so its hash is read once per client
 * (a new client is created per network).
 */
const singletonCodeHashes = new WeakMap<PublicClient, Promise<Hex | null>>()

function singletonCodeHash(publicClient: PublicClient): Promise<Hex | null> {
  const cached = singletonCodeHashes.get(publicClient)
  if (cached) return cached
  const read = publicClient
    .getCode({ address: SAFE_ADDRESSES.safeL2 })
    .then((code) => (code && code !== '0x' ? keccak256(code) : null))
    .catch(() => null)
  singletonCodeHashes.set(publicClient, read)
  return read
}

/**
 * Refuse an address that is not a Safe v1.3.0 proxy over the official SafeL2
 * singleton, and return its reported version.
 *
 * Nothing the address *says* is trusted before its runtime code is known to be
 * SafeProxy: a lookalike can put the SafeL2 address in slot 0, answer `VERSION()`
 * with 1.3.0 and fabricate owners and transaction hashes, so a check built on those
 * answers would pass. The code hash is the part it cannot forge — which is why slot
 * 0 is only read once the code matches, and the singleton is only trusted once its
 * own code matches.
 */
export async function assertSafeIdentity(
  publicClient: PublicClient,
  address: Address,
): Promise<{ version: string; masterCopy: Address }> {
  const code = await publicClient.getCode({ address })
  const proxyCodeHash = code ? keccak256(code) : null
  const runtime = proxyRuntimeProblem(proxyCodeHash)
  if (runtime) throw new Error(runtime)

  const [slot0, version, singleton] = await Promise.all([
    publicClient.getStorageAt({ address, slot: SAFE_MASTER_COPY_SLOT }),
    publicClient.readContract({ address, abi: safeAbi, functionName: 'VERSION' }),
    singletonCodeHash(publicClient),
  ])
  const masterCopy = (slot0 && slot0 !== '0x' ? `0x${slot0.slice(-40)}` : null) as Address | null
  const problem = safeIdentityProblem({ proxyCodeHash, masterCopy, version, singletonCodeHash: singleton })
  if (problem) throw new Error(problem)
  return { version, masterCopy: masterCopy as Address }
}

/** The SafeTx hash as the Safe itself computes it. */
export function readSafeTxHash(publicClient: PublicClient, safe: Address, tx: SafeTxParams): Promise<Hex> {
  return publicClient.readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
  })
}

/** Refuse to sign or approve a hash the Safe computes differently, as with a wrong chain id. */
export async function assertSafeTxHash(publicClient: PublicClient, safe: Address, tx: SafeTxParams, hash: Hex) {
  const onchain = await readSafeTxHash(publicClient, safe, tx)
  if (onchain.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`This Safe computes SafeTx hash ${onchain}, not ${hash}; check the network's chain id.`)
  }
}

/**
 * Queue imported transactions. A signature must recover to the owner it names;
 * one already queued only gains signatures.
 */
export async function importPending(imported: PendingTx[]): Promise<PendingTx[]> {
  const byId = new Map(loadPending().map((p) => [p.id, p]))
  for (const item of imported) {
    const signatures: Record<string, Hex> = {}
    for (const [owner, raw] of Object.entries(item.signatures)) {
      const signature = normalizeSignatureV(raw)
      const signer = await recoverSigner(item.id, signature).catch(() => null)
      if (signer?.toLowerCase() === owner) signatures[owner] = signature
    }
    const existing = byId.get(item.id)
    byId.set(
      item.id,
      existing ? { ...existing, signatures: { ...signatures, ...existing.signatures } } : { ...item, signatures },
    )
  }
  const list = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  savePending(list)
  return list
}

export type ImportedSignature = {
  list: PendingTx[]
  owner: Address
  safe: Address
}

/**
 * Add a single out-of-band signature (or on behalf of an owner) to a queued
 * transaction. The signature is verified against the Safe's owner set before
 * it is stored, so a forged or wrong-safe signature is rejected.
 */
export async function importSignatureShare(
  publicClient: PublicClient,
  share: SignatureShare,
): Promise<ImportedSignature> {
  const item = loadPending().find((p) => p.id.toLowerCase() === share.id.toLowerCase())
  if (!item) {
    throw new Error('No queued transaction matches this signature (SafeTx hash not found).')
  }

  if (publicClient.chain?.id !== item.chainId) {
    throw new Error(`This signature is for a transaction on chain ${item.chainId}; switch to that network first.`)
  }

  const owners = await publicClient.readContract({
    address: item.safe,
    abi: safeAbi,
    functionName: 'getOwners',
  })

  const signature = normalizeSignatureV(share.signature)
  const signer = await recoverSigner(item.id, signature)
  if (!owners.some((owner) => owner.toLowerCase() === signer.toLowerCase())) {
    throw new Error(`The signature recovers ${signer}, which is not an owner of this Safe.`)
  }
  if (signer.toLowerCase() !== share.owner.toLowerCase()) {
    throw new Error('The signature does not match the owner it claims to be from.')
  }

  const list = mergeSignature(item.id, signer, signature)
  return { list, owner: signer, safe: item.safe }
}
