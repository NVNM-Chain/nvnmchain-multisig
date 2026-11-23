import { useEffect, useMemo, useState } from 'react'
import { formatUnits, type Address, type Hex, type PublicClient } from 'viem'
import { shortAddress } from '../chain'
import { safeAbi } from '../lib/abi'
import { useTokenMeta, type TokenMeta } from '../lib/hooks'
import { callsOf, selectorOf, type PackedCall } from '../lib/decode'
import { decodeWithAbis, type AbiEntry, type DecodedWithAbi } from '../lib/contracts'
import { computeSafeTxHash, safeDomainSeparator, safeTxStructHash, type SafeTxParams } from '../lib/safe'
import { AddressLink, CopyButton, Notice } from './ui'

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function formatArg(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (isAddress(value)) return shortAddress(value, 4)
  if (Array.isArray(value)) return `[${value.map(formatArg).join(', ')}]`
  if (value && typeof value === 'object') {
    return `(${Object.values(value).map(formatArg).join(', ')})`
  }
  if (value === null || value === undefined) return ''
  return String(value)
}

const TOKEN_FUNCTIONS = new Set(['transfer', 'transferFrom', 'approve'])

/** A one-line human summary of a decoded call. */
function describe(decoded: DecodedWithAbi | null, selector: Hex, meta: TokenMeta | null): string {
  if (!decoded) {
    return selector === '0x' ? 'empty call' : `unknown function ${selector}`
  }
  const units = (amount: bigint) =>
    meta ? `${formatUnits(amount, meta.decimals)} ${meta.symbol}` : `${amount} base units`
  const args = decoded.args
  const name = decoded.fn.name
  if (name === 'transfer') {
    const [to, amount] = args as [Address, bigint]
    return `Transfer ${units(amount)} → ${shortAddress(to, 4)}`
  }
  if (name === 'transferFrom') {
    const [from, to, amount] = args as [Address, Address, bigint]
    return `Transfer ${units(amount)} · ${shortAddress(from, 4)} → ${shortAddress(to, 4)}`
  }
  if (name === 'approve') {
    const [spender, amount] = args as [Address, bigint]
    return `Approve ${units(amount)} → ${shortAddress(spender, 4)}`
  }
  return `${name}(${args.map(formatArg).join(', ')})`
}

/** Decode a call with the registered ABIs; for a token call, also load the token. */
function useDecoded(publicClient: PublicClient, abis: readonly AbiEntry[], call: PackedCall | undefined) {
  const decoded = useMemo(() => (call ? decodeWithAbis(abis, call.to, call.data) : null), [abis, call])
  const isToken = decoded !== null && TOKEN_FUNCTIONS.has(decoded.fn.name)
  const meta = useTokenMeta(publicClient, call && isToken ? call.to : null)
  return { decoded, meta }
}

/** One-line title of a Safe transaction, read from its calldata. */
export function TxTitle({ publicClient, abis, tx }: { publicClient: PublicClient; abis: readonly AbiEntry[]; tx: SafeTxParams }) {
  const { batch, calls } = useMemo(() => callsOf(tx), [tx])
  const { decoded, meta } = useDecoded(publicClient, abis, batch ? undefined : calls[0])
  if (batch) return `${calls.length} calls (MultiSend)`
  if (decoded) return describe(decoded, selectorOf(tx.data), meta)
  return `${tx.operation === 1 ? 'Delegatecall' : 'Call'} ${shortAddress(tx.to, 4)}`
}

/** Hashes a signer device shows, read from the Safe itself when it exposes them. */
function useOnchainHashes(publicClient: PublicClient, safe: Address, tx: SafeTxParams) {
  const [result, setResult] = useState<
    { key: string; domainSeparator: Hex | null; safeTxHash: Hex | null } | null
  >(null)
  const { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce } = tx
  // Results are tagged with the transaction they were read for, so a stale read from
  // the previous preview is never compared against the new local digest.
  const key = [
    safe,
    to,
    value.toString(),
    data,
    operation,
    safeTxGas.toString(),
    baseGas.toString(),
    gasPrice.toString(),
    gasToken,
    refundReceiver,
    nonce.toString(),
  ].join('|')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [domainSeparator, safeTxHash] = await Promise.all([
        publicClient
          .readContract({ address: safe, abi: safeAbi, functionName: 'domainSeparator' })
          .catch(() => null),
        publicClient
          .readContract({
            address: safe,
            abi: safeAbi,
            functionName: 'getTransactionHash',
            args: [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce],
          })
          .catch(() => null),
      ])
      if (!cancelled) {
        setResult({ key, domainSeparator: domainSeparator ?? null, safeTxHash: safeTxHash ?? null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicClient, safe, key, to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce])

  return result && result.key === key ? result : null
}

/** One hash row: value, copy button and an optional on-chain comparison badge. */
function HashRow({
  label,
  note,
  value,
  check,
  match,
}: {
  label: string
  note?: string
  value: Hex
  check?: string
  match?: boolean | null
}) {
  return (
    <>
      <dt>
        {label}
        {note && <div className="muted" style={{ fontSize: 11.5 }}>{note}</div>}
      </dt>
      <dd>
        <span className="mono-sm wrap-any" title={value}>
          {value}
        </span>{' '}
        <CopyButton value={value} />
        {check && match !== null && match !== undefined && (
          <span
            className={`badge ${match ? 'ok' : 'bad'}`}
            style={{ marginLeft: 6 }}
            title={match ? `equal to ${check}` : `differs from ${check}`}
          >
            {match ? '✓' : '✗'} {check}
          </span>
        )}
      </dd>
    </>
  )
}

function CallRow({
  publicClient,
  abis,
  call,
  index,
  total,
}: {
  publicClient: PublicClient
  abis: readonly AbiEntry[]
  call: PackedCall
  index: number
  total: number
}) {
  const { decoded, meta } = useDecoded(publicClient, abis, call)
  const selector = selectorOf(call.data)
  const summary = useMemo(() => describe(decoded, selector, meta), [decoded, selector, meta])

  return (
    <div className="tx-call">
      <div className="row between">
        <span className="badge">{total > 1 ? `call ${index + 1}/${total}` : 'call'}</span>
        <span className="mono-sm">{summary}</span>
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        <dt>target</dt>
        <dd>
          <AddressLink address={call.to} short={false} />
        </dd>
        <dt>operation</dt>
        <dd>{call.operation === 1 ? 'delegatecall' : 'call'}</dd>
        {decoded && (
          <>
            <dt>function</dt>
            <dd className="mono-sm truncate" title={decoded.signature}>
              {decoded.signature}
            </dd>
            <dt>interface</dt>
            <dd>
              {decoded.entry.name}
              {decoded.entry.address ? '' : <span className="muted"> · inferred</span>}
            </dd>
          </>
        )}
        {call.value > 0n && (
          <>
            <dt>value</dt>
            <dd className="mono">{call.value.toString()}</dd>
          </>
        )}
        <dt>calldata</dt>
        <dd className="mono-sm wrap-any" title={call.data}>
          {call.data === '0x' ? <span className="muted">(none)</span> : call.data}
        </dd>
      </dl>
      {call.data !== '0x' && (
        <div className="row" style={{ marginTop: 8 }}>
          <CopyButton value={call.data} label="copy calldata" />
        </div>
      )}
    </div>
  )
}

/** Decoded, human-readable review of a Safe transaction. */
export function TransactionReview({
  publicClient,
  safe,
  chainId,
  tx,
  abis,
}: {
  publicClient: PublicClient
  safe: Address
  chainId: number
  tx: SafeTxParams
  abis: readonly AbiEntry[]
}) {
  const hashes = useMemo(() => {
    const domainSeparator = safeDomainSeparator(BigInt(chainId), safe)
    return {
      domainSeparator,
      structHash: safeTxStructHash(tx),
      safeTxHash: computeSafeTxHash(BigInt(chainId), safe, tx),
    }
  }, [chainId, safe, tx])
  const onchain = useOnchainHashes(publicClient, safe, tx)
  const domainMatches =
    !onchain || onchain.domainSeparator === null
      ? null
      : onchain.domainSeparator.toLowerCase() === hashes.domainSeparator.toLowerCase()
  const digestMatches =
    !onchain || onchain.safeTxHash === null
      ? null
      : onchain.safeTxHash.toLowerCase() === hashes.safeTxHash.toLowerCase()

  const { batch, calls } = useMemo(() => callsOf(tx), [tx])

  return (
    <div className="review">
      <div className="muted small" style={{ marginBottom: 8 }}>
        {batch ? `Batch of ${calls.length} calls via MultiSendCallOnly` : 'Single call'}
      </div>

      <dl className="kv" style={{ margin: '8px 0' }}>
        <HashRow
          label="safeTxHash"
          note="the EIP-712 digest owners sign"
          value={hashes.safeTxHash}
          check="getTransactionHash()"
          match={digestMatches}
        />
        <HashRow
          label="domainSeparator"
          note="shown by a Ledger as the domain hash"
          value={hashes.domainSeparator}
          check="domainSeparator()"
          match={domainMatches}
        />
        <HashRow label="structHash" note="shown by a Ledger as the message hash" value={hashes.structHash} />
      </dl>
      <div className="muted small">
        safeTxHash = keccak256(0x1901 ‖ domainSeparator ‖ structHash). A hardware wallet shows only
        the domain and message hashes — match them against its screen before approving.
      </div>

      {digestMatches === false && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">
            The local digest does not match <span className="mono-sm">getTransactionHash()</span> on
            this Safe. Do not sign — the chain id or the Safe address is probably wrong.
          </Notice>
        </div>
      )}

      {calls.map((call, index) => (
        <CallRow key={index} publicClient={publicClient} abis={abis} call={call} index={index} total={calls.length} />
      ))}

      <details style={{ marginTop: 10 }}>
        <summary className="muted small">Raw transaction parameters</summary>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>nonce</dt>
          <dd className="mono">{tx.nonce.toString()}</dd>
          <dt>safeTxGas</dt>
          <dd className="mono">{tx.safeTxGas.toString()}</dd>
          <dt>baseGas</dt>
          <dd className="mono">{tx.baseGas.toString()}</dd>
          <dt>gasPrice</dt>
          <dd className="mono">{tx.gasPrice.toString()}</dd>
          <dt>gasToken</dt>
          <dd className="mono-sm">{tx.gasToken}</dd>
          <dt>refundReceiver</dt>
          <dd className="mono-sm">{tx.refundReceiver}</dd>
        </dl>
        <div className="muted small" style={{ marginTop: 4 }}>
          data: <span className="mono-sm">{tx.data === '0x' ? '(none)' : `${tx.data.length / 2 - 1} bytes`}</span>
        </div>
      </details>
    </div>
  )
}
