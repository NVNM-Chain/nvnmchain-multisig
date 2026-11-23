import { useCallback, useEffect, useState } from 'react'
import type { Address, Hex, PublicClient } from 'viem'
import { chainFor, errorMessage, shortAddress } from '../chain'
import { safeAbi } from '../lib/abi'
import {
  computeSafeTxHash,
  deserializeTx,
  executionSucceeded,
  normalizeSignatureV,
  packSignatures,
  preApprovedSignature,
  recoverSigner,
  safeTxTypedData,
  serializeTx,
} from '../lib/safe'
import { buildShareUrl, encodeSignatureShare, parseSignatureShare } from '../lib/share'
import { importSignatureShare } from '../lib/coordinate'
import type { SafeInfo } from '../lib/hooks'
import type { AbiEntry } from '../lib/contracts'
import { markExecuted, mergePending, mergeSignature, removePending, type PendingTx } from '../lib/storage'
import type { Wallet } from '../lib/wallet'
import { Notice, TxLink } from './ui'
import { TransactionReview } from './TransactionReview'

/** On-chain `approveHash` status for every owner of a Safe. */
function useApprovals(publicClient: PublicClient, safe: Address, hash: Hex, owners: Address[]) {
  const [approved, setApproved] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const ownersKey = owners.map((o) => o.toLowerCase()).join(',')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = ownersKey ? ownersKey.split(',') : []
      const entries = await Promise.all(
        list.map(async (owner) => {
          const value = await publicClient.readContract({
            address: safe,
            abi: safeAbi,
            functionName: 'approvedHashes',
            args: [owner as Address, hash],
          })
          return [owner, value === 1n] as const
        }),
      )
      setApproved(Object.fromEntries(entries))
    } catch {
      /* approvals are optional — ignore read failures */
    } finally {
      setLoading(false)
    }
  }, [publicClient, safe, hash, ownersKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { approved, loading, refresh }
}

function QueuedTxCard({
  wallet,
  safe,
  info,
  item,
  abis,
  onChanged,
  onExecuted,
  onError,
}: {
  wallet: Wallet
  safe: Address
  info: SafeInfo
  item: PendingTx
  abis: readonly AbiEntry[]
  onChanged: (list: PendingTx[]) => void
  onExecuted: () => void
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState<'sign' | 'approve' | 'execute' | 'rebase' | null>(null)
  const [shareCopied, setShareCopied] = useState(false)
  const [sigCopied, setSigCopied] = useState(false)
  const [showReview, setShowReview] = useState(false)
  const { approved, refresh: refreshApprovals } = useApprovals(wallet.publicClient, safe, item.id, info.owners)

  const tx = deserializeTx(item.tx)
  const threshold = Number(info.threshold)
  const offchain = Object.keys(item.signatures)
  const onchain = info.owners
    .map((o) => o.toLowerCase())
    .filter((o) => approved[o] && !offchain.includes(o))
  const total = offchain.length + onchain.length
  const executed = Boolean(item.executedTxHash)
  // The Safe increments its nonce in order, so a transaction is either at the
  // current nonce (executable now), behind it (dead — it can never execute) or
  // ahead of it (pre-signable, executable once the Safe catches up).
  const nonceState: 'current' | 'dead' | 'future' =
    tx.nonce === info.nonce ? 'current' : tx.nonce < info.nonce ? 'dead' : 'future'
  const ready = total >= threshold && nonceState === 'current' && !executed
  const me = wallet.account?.toLowerCase()
  const iAmOwner = me ? info.owners.some((o) => o.toLowerCase() === me) : false
  const signed = me ? offchain.includes(me) : false
  const approvedByMe = me ? Boolean(approved[me]) : false
  const mySignature = me ? item.signatures[me] : undefined
  const dataBytes = tx.data === '0x' ? 0 : (tx.data.length - 2) / 2

  const run = async (kind: 'sign' | 'approve' | 'execute' | 'rebase', fn: () => Promise<void>) => {
    setBusy(kind)
    onError(null)
    try {
      await fn()
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  /**
   * `info` can lag behind the chain, and a signature on an already-consumed
   * nonce can never be executed. Read the nonce right before asking the wallet
   * to sign or to spend gas on `approveHash`.
   */
  const assertNotDead = async (action: string) => {
    const nonce = await wallet.publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
    if (nonce <= tx.nonce) return
    onExecuted() // refresh the Safe state so the card flips to "dead nonce"
    throw new Error(
      `${action} cancelled: the Safe nonce is now ${nonce}, but this transaction was built for nonce ` +
        `${tx.nonce}. It can never execute — rebase it to the current nonce and collect signatures again.`,
    )
  }

  const sign = () =>
    run('sign', async () => {
      if (!wallet.walletClient || !wallet.account) return
      await assertNotDead('Signing')
      const hash = computeSafeTxHash(BigInt(wallet.chainId), safe, tx)
      if (hash.toLowerCase() !== item.id.toLowerCase()) throw new Error('Stored transaction does not match this Safe.')
      const typed = safeTxTypedData(wallet.chainId, safe, tx)
      const raw = await wallet.walletClient.signTypedData({
        account: wallet.account,
        domain: typed.domain,
        types: typed.types,
        primaryType: 'SafeTx',
        message: typed.message,
      })
      const signature = normalizeSignatureV(raw)
      const owner = await recoverSigner(hash, signature)
      if (!info.owners.some((o) => o.toLowerCase() === owner.toLowerCase())) {
        throw new Error(`The signature recovered ${owner}, which is not an owner.`)
      }
      onChanged(mergeSignature(item.id, owner, signature))
    })

  const approveOnChain = () =>
    run('approve', async () => {
      if (!wallet.walletClient || !wallet.account) return
      // `approveHash` costs gas and its approval could never be used on a dead nonce.
      await assertNotDead('On-chain approval')
      const hash = await wallet.walletClient.writeContract({
        account: wallet.account,
        chain: chainFor(wallet.networkKey),
        address: safe,
        abi: safeAbi,
        functionName: 'approveHash',
        args: [item.id],
      })
      const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`approveHash reverted — transaction ${hash}.`)
      await refreshApprovals()
    })

  const execute = () =>
    run('execute', async () => {
      if (!wallet.walletClient || !wallet.account) return
      const entries: { owner: Address; signature: Hex }[] = []
      const seen = new Set<string>()
      for (const [owner, signature] of Object.entries(item.signatures)) {
        entries.push({ owner: owner as Address, signature: signature as Hex })
        seen.add(owner)
      }
      for (const owner of info.owners) {
        const key = owner.toLowerCase()
        if (seen.has(key) || !approved[key]) continue
        entries.push({ owner, signature: preApprovedSignature(owner) })
      }
      if (entries.length < threshold) throw new Error('Not enough approvals yet.')
      // Approvals are bound to the nonce inside the digest: confirm it is still current
      // instead of trusting the possibly stale `info` read.
      const nonce = await wallet.publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
      if (nonce !== tx.nonce) {
        onExecuted() // refresh the Safe state so the UI shows the new nonce
        throw new Error(
          `The Safe nonce is now ${nonce}, but this transaction was built for nonce ${tx.nonce}. ` +
            'Its approvals can no longer be executed — rebase it to the current nonce.',
        )
      }
      const packed = packSignatures(entries)
      const hash = await wallet.walletClient.writeContract({
        account: wallet.account,
        chain: chainFor(wallet.networkKey),
        address: safe,
        abi: safeAbi,
        functionName: 'execTransaction',
        args: [
          tx.to,
          tx.value,
          tx.data,
          tx.operation,
          tx.safeTxGas,
          tx.baseGas,
          tx.gasPrice,
          tx.gasToken,
          tx.refundReceiver,
          packed,
        ],
      })
      const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash })
      onExecuted()
      if (!executionSucceeded(safe, receipt.logs)) {
        const what = receipt.status === 'success' ? 'The call made by the Safe failed' : 'Execution reverted'
        throw new Error(`${what} — transaction ${hash}.`)
      }
      onChanged(markExecuted(item.id, hash))
    })

  /**
   * Rebuild a dead transaction with the live nonce, keeping its calls but
   * dropping the approvals that can no longer be used. Local only — no wallet
   * interaction — so any viewer can prepare the replacement.
   */
  const rebase = () =>
    run('rebase', async () => {
      const nonce = await wallet.publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
      if (nonce < tx.nonce) {
        onExecuted()
        throw new Error(
          `The Safe nonce is ${nonce}; this transaction is ahead of it and still valid — nothing to rebase.`,
        )
      }
      if (nonce === tx.nonce) {
        onExecuted()
        throw new Error('The Safe nonce already matches this transaction — nothing to rebase.')
      }
      const next = { ...tx, nonce }
      const hash = computeSafeTxHash(BigInt(wallet.chainId), safe, next)
      // merge (not upsert) so an owner who already rebased — or signed the
      // replacement — keeps their signatures: the new digest is unique, so no
      // signature from the dead one can leak in.
      onChanged(
        mergePending([
          {
            id: hash,
            chainId: wallet.chainId,
            safe,
            createdAt: Date.now(),
            label: item.label,
            tx: serializeTx(next),
            signatures: {},
          },
        ]),
      )
      onExecuted()
    })

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(buildShareUrl([item]))
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1500)
    } catch {
      onError('Clipboard unavailable — copy the URL manually.')
    }
  }

  /** Copy just this signer's approval so it can be sent out-of-band. */
  const copyMySignature = async () => {
    if (!me || !mySignature) return
    try {
      await navigator.clipboard.writeText(encodeSignatureShare({ id: item.id, owner: me as Address, signature: mySignature }))
      setSigCopied(true)
      setTimeout(() => setSigCopied(false), 1500)
    } catch {
      onError('Clipboard unavailable — copy the code manually.')
    }
  }

  return (
    <div className="tx-call">
      <div className="row between">
        <strong>{item.label}</strong>
        {executed ? (
          <span className="badge ok"><span className="dot ok" /> executed</span>
        ) : nonceState === 'dead' ? (
          <span className="badge bad" title="The Safe has moved past this nonce — it can never execute.">
            dead nonce
          </span>
        ) : nonceState === 'future' ? (
          <span className="badge warn" title="Ahead of the Safe nonce — signable now, executable later.">
            nonce ahead · {total}/{threshold}
          </span>
        ) : ready ? (
          <span className="badge info">ready to execute</span>
        ) : (
          <span className="badge warn">
            {total}/{threshold} approvals
          </span>
        )}
      </div>

      <div className="muted small" style={{ marginTop: 6 }}>
        nonce <span className="mono">{tx.nonce.toString()}</span> · to{' '}
        <span className="mono-sm">{shortAddress(tx.to, 5)}</span> · operation{' '}
        {tx.operation === 1 ? 'delegatecall' : 'call'}
        {dataBytes > 0 ? ` · ${dataBytes} bytes calldata` : ''}
      </div>
      <div className="muted small">
        SafeTx <span className="mono-sm">{item.id}</span>
      </div>

      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        {info.owners.map((owner) => {
          const key = owner.toLowerCase()
          const off = offchain.includes(key)
          const on = approved[key]
          const cls = off ? 'ok' : on ? 'info' : ''
          const mark = off ? '✓ ' : on ? '⛓ ' : ''
          return (
            <span className={`badge ${cls}`} key={owner} title={`${owner}${off ? ' · signed off-chain' : on ? ' · approved on-chain' : ''}`}>
              {mark}
              {shortAddress(owner, 3)}
            </span>
          )
        })}
      </div>

      {!executed && nonceState === 'dead' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          The Safe nonce is now <span className="mono">{info.nonce.toString()}</span>; this transaction
          was built for nonce <span className="mono">{tx.nonce.toString()}</span>, so it can never be
          executed and its approvals are dead. Rebase it to reuse the same calls with the current
          nonce — the old signatures do not carry over.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={rebase} disabled={busy !== null}>
              {busy === 'rebase' ? 'Rebasing…' : 'Rebase to the current nonce'}
            </button>
          </div>
        </div>
      )}

      {!executed && nonceState === 'future' && (
        <div className="notice info" style={{ marginTop: 10 }}>
          This transaction is for nonce <span className="mono">{tx.nonce.toString()}</span>, ahead of
          the current nonce <span className="mono">{info.nonce.toString()}</span>. It can be signed
          now and becomes executable once the Safe reaches that nonce.
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        {!executed && nonceState !== 'dead' && iAmOwner && !signed && (
          <button className="btn small primary" onClick={sign} disabled={busy !== null}>
            {busy === 'sign' ? 'Signing…' : 'Sign (off-chain)'}
          </button>
        )}
        {!executed && nonceState !== 'dead' && iAmOwner && !approvedByMe && (
          <button className="btn small" onClick={approveOnChain} disabled={busy !== null}>
            {busy === 'approve' ? 'Approving…' : 'Approve on-chain'}
          </button>
        )}
        {!executed && !iAmOwner && (
          <span className="muted small">Connected account is not an owner.</span>
        )}
        {ready && (
          <button className="btn small primary" onClick={execute} disabled={busy !== null}>
            {busy === 'execute' ? 'Executing…' : 'Execute'}
          </button>
        )}
        {executed && item.executedTxHash && (
          <span className="muted small">
            Confirmed <TxLink hash={item.executedTxHash} />
          </span>
        )}
        <div className="spacer" />
        <button className="btn small ghost" onClick={() => setShowReview((v) => !v)} aria-expanded={showReview}>
          {showReview ? 'Hide details' : 'Review'}
        </button>
        {mySignature && (
          <button className="btn small ghost" onClick={copyMySignature} title="Send just your signature to the coordinator">
            {sigCopied ? 'Signature copied ✓' : 'Copy signature'}
          </button>
        )}
        <button className="btn small ghost" onClick={copyShare}>
          {shareCopied ? 'Link copied ✓' : 'Share link'}
        </button>
        <button
          className="btn small ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify([item], null, 2))
            } catch {
              /* ignore */
            }
          }}
        >
          Copy JSON
        </button>
        <button className="btn small ghost danger" onClick={() => onChanged(removePending(item.id))}>
          Remove
        </button>
      </div>

      {showReview && (
        <TransactionReview
          publicClient={wallet.publicClient}
          safe={safe}
          chainId={wallet.chainId}
          tx={tx}
          abis={abis}
        />
      )}
    </div>
  )
}

export function Queue({
  wallet,
  safe,
  info,
  pending,
  abis,
  onChanged,
  onExecuted,
}: {
  wallet: Wallet
  safe: Address
  info: SafeInfo
  pending: PendingTx[]
  abis: readonly AbiEntry[]
  onChanged: (list: PendingTx[]) => void
  onExecuted: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'import' | 'signature' | null>(null)
  const [importText, setImportText] = useState('')
  const [signatureText, setSignatureText] = useState('')
  const [shareCopied, setShareCopied] = useState(false)

  const mine = pending.filter(
    (p) => p.safe.toLowerCase() === safe.toLowerCase() && p.chainId === wallet.chainId,
  )

  const exportAll = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(mine, null, 2))
      setError(null)
    } catch {
      setError('Clipboard unavailable — copy the text manually.')
    }
  }

  const shareAll = async () => {
    try {
      await navigator.clipboard.writeText(buildShareUrl(mine))
      setShareCopied(true)
      setError(null)
      setTimeout(() => setShareCopied(false), 1500)
    } catch {
      setError('Clipboard unavailable — copy the URL manually.')
    }
  }

  const doImport = () => {
    try {
      const parsed = JSON.parse(importText) as PendingTx[]
      const list = Array.isArray(parsed) ? parsed : [parsed]
      onChanged(mergePending(list))
      setImportText('')
      setPanel(null)
    } catch {
      setError('Could not parse the imported JSON.')
    }
  }

  /** Add a single out-of-band signature (code or link) to a queued transaction. */
  const addSignature = async () => {
    setError(null)
    try {
      const result = await importSignatureShare(wallet.publicClient, parseSignatureShare(signatureText))
      onChanged(result.list)
      setSignatureText('')
      setPanel(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="card">
      <div className="row between">
        <div>
          <h2>Queue</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Approvals for Safe <span className="mono-sm">{shortAddress(safe, 5)}</span>. Owners can
            sign off-chain (<span className="badge ok small">✓</span>) or approve the hash on-chain
            (<span className="badge info small">⛓</span>) — either counts toward the threshold.
          </p>
        </div>
        <div className="row">
          <button className="btn small ghost" onClick={shareAll} disabled={mine.length === 0}>
            {shareCopied ? 'Link copied ✓' : 'Share all'}
          </button>
          <button className="btn small ghost" onClick={exportAll} disabled={mine.length === 0}>
            Export JSON
          </button>
          <button className="btn small ghost" onClick={() => setPanel(panel === 'import' ? null : 'import')}>
            Import tx
          </button>
          <button
            className="btn small ghost"
            onClick={() => setPanel(panel === 'signature' ? null : 'signature')}
            title="Paste a signature code from another signer"
          >
            Add signature
          </button>
        </div>
      </div>

      {panel === 'import' && (
        <div style={{ marginTop: 14 }}>
          <textarea
            className="mono"
            rows={4}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='[{"id":"0x…","safe":"0x…", …}]'
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small primary" onClick={doImport} disabled={!importText.trim()}>
              Merge
            </button>
            <button className="btn small ghost" onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {panel === 'signature' && (
        <div style={{ marginTop: 14 }}>
          <input
            className="mono"
            value={signatureText}
            onChange={(e) => setSignatureText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addSignature()}
            placeholder="Paste a signature code (or a link containing #sig=…)"
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small primary" onClick={() => void addSignature()} disabled={!signatureText.trim()}>
              Add signature
            </button>
            <button className="btn small ghost" onClick={() => setPanel(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ marginTop: 14 }}><Notice kind="err">{error}</Notice></div>}

      {mine.length === 0 ? (
        <div className="empty">
          No queued transactions. Create one from the <strong>New transaction</strong> tab.
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 14 }}>
          {mine.map((item) => (
            <QueuedTxCard
              key={item.id}
              wallet={wallet}
              safe={safe}
              info={info}
              item={item}
              abis={abis}
              onChanged={onChanged}
              onExecuted={onExecuted}
              onError={setError}
            />
          ))}
        </div>
      )}
    </section>
  )
}
