import { useEffect, useMemo, useState } from 'react'
import { formatUnits, type Address, type Hex, type PublicClient } from 'viem'
import { FEE_TOKEN, shortAddress } from '../chain'
import { safeAbi } from '../lib/abi'
import { readSafeTxHash } from '../lib/coordinate'
import { useTokenMeta, type TokenMeta } from '../lib/hooks'
import { callsOf, nativeValueProblem, selectorOf, type PackedCall } from '../lib/decode'
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

/**
 * Decode a call with the registered ABIs. Token metadata (`symbol`, `decimals`) is
 * only read for a token we know by address — the fee token or an interface bound to
 * that target — because any contract can report whatever metadata it likes for a
 * selector that merely looks like `transfer(address,uint256)`.
 */
function useDecoded(publicClient: PublicClient, abis: readonly AbiEntry[], call: PackedCall | undefined) {
  const decoded = useMemo(() => (call ? decodeWithAbis(abis, call.to, call.data) : null), [abis, call])
  const bound = Boolean(
    decoded?.entry.address && call && decoded.entry.address.toLowerCase() === call.to.toLowerCase(),
  )
  const trustedToken = Boolean(call) && (bound || call!.to.toLowerCase() === FEE_TOKEN.toLowerCase())
  const isToken = decoded !== null && TOKEN_FUNCTIONS.has(decoded.fn.name) && trustedToken
  const meta = useTokenMeta(publicClient, isToken ? call!.to : null)
  return { decoded, meta, verified: bound || isToken }
}

/** One-line title of a Safe transaction, read from its calldata. */
export function TxTitle({ publicClient, abis, tx }: { publicClient: PublicClient; abis: readonly AbiEntry[]; tx: SafeTxParams }) {
  const { batch, calls } = useMemo(() => callsOf(tx), [tx])
  const { decoded, meta, verified } = useDecoded(publicClient, abis, batch ? undefined : calls[0])
  if (batch) return `${calls.length} calls (MultiSend)`
  // A selector-only match is a guess about an unknown contract; say so.
  const suffix = verified ? '' : ' (unverified interface)'
  if (decoded) return `${describe(decoded, selectorOf(tx.data), meta)}${suffix}`
  return `${tx.operation === 1 ? 'Delegatecall' : 'Call'} ${shortAddress(tx.to, 4)}`
}

/** The Safe's own `domainSeparator()` and `getTransactionHash()` for `tx`, keyed by its local hash `digest`; null until read. */
function useOnchainHashes(publicClient: PublicClient, safe: Address, tx: SafeTxParams, digest: Hex) {
  const [result, setResult] = useState<{ digest: Hex; domainSeparator: Hex | null; safeTxHash: Hex | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [domainSeparator, safeTxHash] = await Promise.all([
        publicClient
          .readContract({ address: safe, abi: safeAbi, functionName: 'domainSeparator' })
          .catch(() => null),
        readSafeTxHash(publicClient, safe, tx).catch(() => null),
      ])
      if (!cancelled) setResult({ digest, domainSeparator: domainSeparator ?? null, safeTxHash: safeTxHash ?? null })
    })()
    return () => {
      cancelled = true
    }
  }, [publicClient, safe, digest])

  return result?.digest === digest ? result : null
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
  packed,
}: {
  publicClient: PublicClient
  abis: readonly AbiEntry[]
  call: PackedCall
  index: number
  total: number
  /** True when this entry is inside a MultiSend blob (where the operation byte is ignored). */
  packed: boolean
}) {
  const { decoded, meta } = useDecoded(publicClient, abis, call)
  const selector = selectorOf(call.data)
  const summary = useMemo(() => describe(decoded, selector, meta), [decoded, selector, meta])
  const operation = packed
    ? 'call (MultiSendCallOnly ignores the operation byte)'
    : call.operation === 1
      ? 'delegatecall'
      : 'call'

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
        <dd>{operation}</dd>
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
  const onchain = useOnchainHashes(publicClient, safe, tx, hashes.safeTxHash)
  const domainMatches =
    !onchain || onchain.domainSeparator === null
      ? null
      : onchain.domainSeparator.toLowerCase() === hashes.domainSeparator.toLowerCase()
  const digestMatches =
    !onchain || onchain.safeTxHash === null
      ? null
      : onchain.safeTxHash.toLowerCase() === hashes.safeTxHash.toLowerCase()

  const { batch, calls } = useMemo(() => callsOf(tx), [tx])
  // No native token on this chain: value is not a risk to weigh, it is a
  // transaction that cannot run. The queue refuses to sign or execute it.
  const valueProblem = nativeValueProblem(tx)

  return (
    <div className="review">
      <div className="muted small" style={{ marginBottom: 8 }}>
        {batch ? `Batch of ${calls.length} calls via MultiSendCallOnly` : 'Single call'}
      </div>

      {valueProblem && (
        <Notice kind="err">
          {valueProblem} Signing and executing are refused.
        </Notice>
      )}

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

      {digestMatches === false && (
        <div style={{ marginTop: 10 }}>
          <Notice kind="err">
            The local digest does not match <span className="mono-sm">getTransactionHash()</span> on
            this Safe, so signing is refused: the network's chain id is probably wrong.
          </Notice>
        </div>
      )}

      {calls.map((call, index) => (
        <CallRow
          key={index}
          publicClient={publicClient}
          abis={abis}
          call={call}
          index={index}
          total={calls.length}
          packed={batch}
        />
      ))}

      <details style={{ marginTop: 10 }}>
        <summary className="muted small">Raw transaction parameters</summary>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>nonce</dt>
          <dd className="mono">{tx.nonce.toString()}</dd>
          <dt>value</dt>
          <dd className="mono">{tx.value.toString()}</dd>
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
