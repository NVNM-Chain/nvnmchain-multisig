import { decodeFunctionData, getAddress, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem'
import type { SafeTxParams } from './safe'
import { SAFE_ADDRESSES } from './safeArtifacts'

/** MultiSendCallOnly / MultiSend batch entry. */
export type PackedCall = {
  operation: number
  to: Address
  value: bigint
  data: Hex
}

export const multiSendAbi = parseAbi(['function multiSend(bytes transactions)'])

export const MULTISEND_SELECTOR = toFunctionSelector('multiSend(bytes)')

export function selectorOf(data: Hex): Hex {
  return (data.length >= 10 ? data.slice(0, 10) : data) as Hex
}

/** Unpack the `MultiSend.multiSend` byte blob into individual calls. */
export function unpackMultiSend(packed: Hex): PackedCall[] {
  const hex = packed.slice(2)
  const calls: PackedCall[] = []
  let i = 0
  while (i < hex.length) {
    if (i + 2 + 40 + 64 + 64 > hex.length) throw new Error('Truncated MultiSend data')
    const operation = Number.parseInt(hex.slice(i, i + 2), 16)
    i += 2
    const to = getAddress(`0x${hex.slice(i, i + 40)}`)
    i += 40
    const value = BigInt(`0x${hex.slice(i, i + 64)}`)
    i += 64
    const dataLen = Number(BigInt(`0x${hex.slice(i, i + 64)}`))
    i += 64
    if (i + dataLen * 2 > hex.length) throw new Error('Truncated MultiSend call data')
    const data = (`0x${hex.slice(i, i + dataLen * 2)}`) as Hex
    i += dataLen * 2
    calls.push({ operation, to, value, data })
  }
  return calls
}

/** Decode a `multiSend(bytes)` call into its individual calls. */
export function decodeMultiSend(data: Hex): PackedCall[] {
  const { args } = decodeFunctionData({ abi: multiSendAbi, data })
  return unpackMultiSend(args[0] as Hex)
}

/** True when a transaction is a `MultiSendCallOnly.multiSend` delegatecall. */
export function isMultiSendCall(tx: { to: Address; operation: number; data: Hex }, multiSendAddress: Address): boolean {
  return (
    tx.operation === 1 &&
    tx.to.toLowerCase() === multiSendAddress.toLowerCase() &&
    tx.data.length >= 10 &&
    selectorOf(tx.data).toLowerCase() === MULTISEND_SELECTOR.toLowerCase()
  )
}

/** The calls a Safe transaction makes, with a MultiSendCallOnly batch unpacked. */
export function callsOf(tx: SafeTxParams): { batch: boolean; calls: PackedCall[] } {
  if (isMultiSendCall(tx, SAFE_ADDRESSES.multiSendCallOnly)) {
    try {
      return { batch: true, calls: decodeMultiSend(tx.data) }
    } catch {
      /* malformed batch: show the raw call */
    }
  }
  return { batch: false, calls: [{ operation: tx.operation, to: tx.to, value: tx.value, data: tx.data }] }
}

/** Warnings for a delegatecall outside MultiSend and for a gas refund the Safe pays. */
export function txRisks(tx: SafeTxParams): string[] {
  const risks: string[] = []
  const multiSend = isMultiSendCall(tx, SAFE_ADDRESSES.multiSendCallOnly)
  if (tx.operation === 1 && !multiSend) {
    risks.push(`Delegatecall: the code at ${tx.to} runs as the Safe and can change its owners or move everything it holds.`)
  }
  if (multiSend) {
    // MultiSendCallOnly hard-codes CALL, so a review that honours the packed
    // operation byte would describe a different transaction than the one that runs.
    if (tx.value > 0n) {
      risks.push(
        `Value: this batch is a delegatecall to MultiSendCallOnly carrying ${tx.value} wei; MultiSendCallOnly keeps it instead of forwarding it to the calls.`,
      )
    }
    try {
      if (decodeMultiSend(tx.data).some((call) => call.operation !== 0)) {
        risks.push(
          'Operation byte: this batch sets a per-call operation, but MultiSendCallOnly ignores it and runs every entry as a plain call.',
        )
      }
    } catch {
      /* malformed batch: already shown as a raw call */
    }
  }
  if (tx.gasPrice > 0n) {
    const token = tx.gasToken === zeroAddress ? 'the native token' : `token ${tx.gasToken}`
    const receiver = tx.refundReceiver === zeroAddress ? 'whoever executes' : tx.refundReceiver
    risks.push(`Gas refund: the Safe pays (gas used + ${tx.baseGas}) × ${tx.gasPrice} of ${token} to ${receiver}.`)
  }
  return risks
}
