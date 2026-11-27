/* End-to-end verification against real Safe v1.3.0 contracts on anvil. */
import { createPublicClient, createWalletClient, http, hashTypedData, hashStruct, encodeFunctionData, keccak256, concat, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { gasToSend, parseUnits, TX_GAS_CAP } from '../src/chain'
import { multiSendCallOnlyAbi, safeAbi, safeProxyFactoryAbi } from '../src/lib/abi'
import {
  SAFE_ADDRESSES,
  SAFE_CREATION_CODE,
  SAFE_L2_RUNTIME_HASH,
  SAFE_PROXY_RUNTIME_HASH,
} from '../src/lib/safeArtifacts'
import {
  buildSafeTx,
  computeSafeTxHash,
  encodeSafeSetup,
  executionSucceeded,
  nextFreeNonce,
  normalizeSignatureV,
  packMultiSend,
  packSignatures,
  preApprovedSignature,
  proxyRuntimeProblem,
  predictSafeAddress,
  recoverSigner,
  safeDomainSeparator,
  safeIdentityProblem,
  SAFE_MASTER_COPY_SLOT,
  safeTxStructHash,
  safeTxTypedData,
  serializeTx,
  type SafeCall,
  type SafeTxParams,
} from '../src/lib/safe'
import {
  buildSafeUrl,
  buildShareUrl,
  buildSignatureUrl,
  decodeShare,
  decodeSignatureShare,
  encodeShare,
  encodeSignatureShare,
  parseShared,
  parseSignatureShare,
  readShareLink,
} from '../src/lib/share'
import { assertSafeIdentity, assertSafeTxHash, importPending, importSignatureShare } from '../src/lib/coordinate'
import { assertOnCorrectChain } from '../src/lib/wallet'
import { decodeMultiSend, isMultiSendCall, nativeValueProblem, txRisks } from '../src/lib/decode'
import { BUILTIN_ABIS, decodeWithAbis } from '../src/lib/contracts'
import { loadPending, rebasePending, savePending, upsertPending, type PendingTx } from '../src/lib/storage'

// localStorage shim so the pending-transaction store works under bun.
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
}

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const pub = createPublicClient({ chain: foundry, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) })

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failures++
}

function throws(fn: () => unknown) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

async function deploy(data: `0x${string}`) {
  const hash = await wallet.sendTransaction({ data })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (!r.contractAddress) throw new Error('no contract address')
  return r.contractAddress
}

async function readHash(safe: `0x${string}`, tx: SafeTxParams) {
  return pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getTransactionHash',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
  })
}

async function signTx(safe: `0x${string}`, tx: SafeTxParams) {
  const typed = safeTxTypedData(31337, safe, tx)
  return wallet.signTypedData({ domain: typed.domain, types: typed.types, primaryType: 'SafeTx', message: typed.message })
}

async function exec(safe: `0x${string}`, tx: SafeTxParams, signature: `0x${string}`) {
  const hash = await wallet.writeContract({
    address: safe,
    abi: safeAbi,
    functionName: 'execTransaction',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, packSignatures([{ owner: account.address, signature }])],
  })
  return pub.waitForTransactionReceipt({ hash })
}

// --- deploy the suite (regular CREATE; address derivation is verified separately) ---
const safeL2 = await deploy(SAFE_CREATION_CODE.safeL2 as `0x${string}`)
const factory = await deploy(SAFE_CREATION_CODE.safeProxyFactory as `0x${string}`)
const fallback = await deploy(SAFE_CREATION_CODE.compatibilityFallbackHandler as `0x${string}`)
const multiSendLocal = await deploy(SAFE_CREATION_CODE.multiSendCallOnly as `0x${string}`)

const initializer = encodeSafeSetup({ owners: [account.address], threshold: 1n, fallbackHandler: fallback })
const predicted = predictSafeAddress({ singleton: safeL2, factory, initializer, saltNonce: 0n })
const createHash = await wallet.writeContract({ address: factory, abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [safeL2, initializer, 0n] })
const createR = await pub.waitForTransactionReceipt({ hash: createHash })
const proxyLog = createR.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase())
if (!proxyLog) throw new Error('ProxyCreation log not found')
const safe = ('0x' + proxyLog.data.slice(26, 66)) as `0x${string}`

check('predictSafeAddress == factory proxy', predicted.toLowerCase() === safe.toLowerCase(), `${predicted} / ${safe}`)
const owners = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })
check('proxy owners/threshold', owners.length === 1 && owners[0]!.toLowerCase() === account.address.toLowerCase() && (await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' })) === 1n)
// The identity check the UI runs on load depends on slot 0 naming the singleton.
const proxySlot0 = await pub.getStorageAt({ address: safe, slot: SAFE_MASTER_COPY_SLOT })
check(
  'proxy slot 0 is the singleton (what the identity check reads)',
  Boolean(proxySlot0) && (`0x${(proxySlot0 as string).slice(-40)}`).toLowerCase() === safeL2.toLowerCase(),
)
// The identity anchor: the proxy's runtime code, which a lookalike cannot forge.
const proxyRuntimeHash = keccak256((await pub.getCode({ address: safe }))!)
check('deployed proxy runtime is SafeProxy (pinned constant)', proxyRuntimeHash === SAFE_PROXY_RUNTIME_HASH, proxyRuntimeHash)
check(
  'bundled SafeL2 runtime matches the pinned constant',
  keccak256((await pub.getCode({ address: safeL2 }))!) === SAFE_L2_RUNTIME_HASH,
)

// --- single transaction: hash + sign + execute ---
const tx: SafeTxParams = {
  to: '0x000000000000000000000000000000000000dEaD',
  value: 0n,
  data: '0xdeadbeef',
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: '0x0000000000000000000000000000000000000000',
  refundReceiver: '0x0000000000000000000000000000000000000000',
  nonce: 0n,
}
const mine = computeSafeTxHash(31337n, safe, tx)
const onchain = await readHash(safe, tx)
check('computeSafeTxHash == Safe.getTransactionHash', mine.toLowerCase() === onchain.toLowerCase(), mine)
const typed = safeTxTypedData(31337, safe, tx)
check('hashTypedData == computeSafeTxHash', hashTypedData({ domain: typed.domain, types: typed.types, primaryType: 'SafeTx', message: typed.message }).toLowerCase() === mine.toLowerCase())

// The parts a hardware wallet displays: domain hash + message hash.
const domain = safeDomainSeparator(31337n, safe)
const structHash = safeTxStructHash(tx)
const onchainDomain = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'domainSeparator' })
check('safeDomainSeparator == Safe.domainSeparator()', domain.toLowerCase() === onchainDomain.toLowerCase(), domain)
check(
  'safeTxStructHash == hashStruct(SafeTx)',
  structHash.toLowerCase() === hashStruct({ data: typed.message, types: typed.types, primaryType: 'SafeTx' }).toLowerCase(),
  structHash,
)
check(
  'safeTxHash = keccak256(0x1901 ‖ domain ‖ structHash)',
  keccak256(concat(['0x1901', domain, structHash])).toLowerCase() === mine.toLowerCase(),
)
const passes = (p: Promise<void>) => p.then(() => true, () => false)
check('assertSafeTxHash accepts the hash the Safe computes', await passes(assertSafeTxHash(pub, safe, tx, mine)))
check('assertSafeTxHash refuses another chain id', !(await passes(assertSafeTxHash(pub, safe, tx, computeSafeTxHash(1n, safe, tx)))))
const signature = await signTx(safe, tx)
check('recoverSigner == signer', (await recoverSigner(mine, signature)).toLowerCase() === account.address.toLowerCase())
const executed = await exec(safe, tx, signature)
check('execTransaction succeeded', executed.status === 'success' && executionSucceeded(safe, executed.logs))
check('nonce incremented', (await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })) === 1n)

// --- MultiSend batch: place MultiSendCallOnly at its configured address, then execute ---
const runtime = await pub.getCode({ address: multiSendLocal })
await pub.request({ method: 'anvil_setCode', params: [SAFE_ADDRESSES.multiSendCallOnly, runtime] } as never)
const calls: SafeCall[] = [
  { to: '0x000000000000000000000000000000000000dEaD', value: 0n, data: '0x' },
  { to: '0x000000000000000000000000000000000000bEEF', value: 0n, data: '0x1234' },
]
const batchTx = buildSafeTx(calls, 1n)
check('batch targets MultiSendCallOnly + delegatecall', batchTx.to.toLowerCase() === SAFE_ADDRESSES.multiSendCallOnly.toLowerCase() && batchTx.operation === 1)
check('batch calldata == multiSend(packMultiSend)', batchTx.data.toLowerCase() === encodeFunctionData({ abi: multiSendCallOnlyAbi, functionName: 'multiSend', args: [packMultiSend(calls)] }).toLowerCase())
check('batch SafeTx hash matches on-chain', computeSafeTxHash(31337n, safe, batchTx).toLowerCase() === (await readHash(safe, batchTx)).toLowerCase())
check('batch MultiSend execution succeeded', (await exec(safe, batchTx, await signTx(safe, batchTx))).status === 'success')

// --- transaction review decoding ---
const transferAbi = parseAbi(['function transfer(address to, uint256 amount)'])
const transferData = encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [account.address, 1234567n] })
const decoded = decodeWithAbis(BUILTIN_ABIS, account.address, transferData)
check(
  'review decodes transfer',
  decoded?.fn.name === 'transfer' &&
    (decoded.args[0] as string).toLowerCase() === account.address.toLowerCase() &&
    decoded.args[1] === 1234567n,
)
const unpacked = decodeMultiSend(batchTx.data)
check(
  'decodeMultiSend round-trips the batch',
  unpacked.length === 2 &&
    unpacked[0]!.to.toLowerCase() === calls[0]!.to.toLowerCase() &&
    unpacked[1]!.data === calls[1]!.data &&
    isMultiSendCall(batchTx, SAFE_ADDRESSES.multiSendCallOnly),
)
check(
  'review flags a gas refund and a delegatecall outside MultiSend',
  txRisks(tx).length === 0 &&
    txRisks(batchTx).length === 0 &&
    txRisks({ ...tx, operation: 1 }).length === 1 &&
    txRisks({ ...tx, baseGas: 5n, gasPrice: 1n }).length === 1,
)

// --- gas ---
check('gas to send is a tenth over the estimate, at most the cap', gasToSend(25_200_000n) === 27_720_000n && gasToSend(28_000_000n) === TX_GAS_CAP)

// --- nonces ---
check('next free nonce skips the ones taken', nextFreeNonce(5n, [5n, 6n, 9n]) === 7n && nextFreeNonce(5n, [7n]) === 5n)

// --- amounts ---
check(
  'amounts parse strictly',
  parseUnits('1.5', 6) === 1500000n &&
    parseUnits('.5', 6) === 500000n &&
    parseUnits('1.50', 1) === 15n &&
    parseUnits('2', 0) === 2n &&
    ['', '.', '-1', '0x10', '1e3', '1,5', '1.5.9', '1.2345678'].every((v) => throws(() => parseUnits(v, 6))),
)

// --- owner sorting: pass owners in descending order, expect ascending on-chain ---
const secondOwner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const init2 = encodeSafeSetup({ owners: [account.address, secondOwner], threshold: 1n, fallbackHandler: fallback })
const pred2 = predictSafeAddress({ singleton: safeL2, factory, initializer: init2, saltNonce: 1n })
const create2 = await wallet.writeContract({ address: factory, abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [safeL2, init2, 1n] })
const createR2 = await pub.waitForTransactionReceipt({ hash: create2 })
const log2 = createR2.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase())!
const safe2 = ('0x' + log2.data.slice(26, 66)) as `0x${string}`
check('multi-owner prediction matches', pred2.toLowerCase() === safe2.toLowerCase())
const owners2 = await pub.readContract({ address: safe2, abi: safeAbi, functionName: 'getOwners' })
check(
  'setup sorts owners ascending',
  owners2[0]!.toLowerCase() === secondOwner.toLowerCase() && owners2[1]!.toLowerCase() === account.address.toLowerCase(),
  owners2.join(', '),
)

// --- on-chain approval path: approveHash + pre-approved signature ---
const tx2: SafeTxParams = { ...tx, data: '0x1234', nonce: 2n }
check('approve tx hash matches on-chain', computeSafeTxHash(31337n, safe, tx2).toLowerCase() === (await readHash(safe, tx2)).toLowerCase())
const approveHashTx = await wallet.writeContract({ address: safe, abi: safeAbi, functionName: 'approveHash', args: [computeSafeTxHash(31337n, safe, tx2)] })
await pub.waitForTransactionReceipt({ hash: approveHashTx })
const approvedValue = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'approvedHashes', args: [account.address, computeSafeTxHash(31337n, safe, tx2)] })
check('approvedHashes == 1 after approveHash', approvedValue === 1n)
const preSig = preApprovedSignature(account.address)
const exec2 = await wallet.writeContract({
  address: safe,
  abi: safeAbi,
  functionName: 'execTransaction',
  args: [tx2.to, tx2.value, tx2.data, tx2.operation, tx2.safeTxGas, tx2.baseGas, tx2.gasPrice, tx2.gasToken, tx2.refundReceiver, packSignatures([{ owner: account.address, signature: preSig }])],
})
check('execTransaction with pre-approved signature succeeded', (await pub.waitForTransactionReceipt({ hash: exec2 })).status === 'success')

// --- share link round-trip ---
const sampleSig = await signTx(safe, tx2)
const sample: PendingTx = {
  id: computeSafeTxHash(31337n, safe, tx2),
  chainId: 31337,
  safe,
  createdAt: Date.now(),
  tx: serializeTx(tx2),
  signatures: { [account.address.toLowerCase()]: sampleSig },
}
const round = decodeShare(encodeShare([sample]))
check('share encode/decode round-trip', round.length === 1 && round[0]!.id === sample.id && round[0]!.signatures[account.address.toLowerCase()] === sampleSig)

// --- imports are bound to their SafeTx hash ---
const forged = { ...sample, tx: serializeTx({ ...tx2, to: secondOwner }) }
check('import rejects a tx that does not hash to its id', throws(() => decodeShare(encodeShare([forged]))))
check('import rejects a shapeless entry', throws(() => parseShared([{}])))
check('import cannot mark a transaction executed', parseShared({ ...sample, executedTxHash: sample.id })[0]!.executedTxHash === undefined)
savePending([{} as PendingTx, forged, sample])
check('load drops stored entries that fail the check', loadPending().length === 1 && loadPending()[0]!.id === sample.id)
savePending([])

// --- imported signatures must recover to the owner they name ---
const misattributed = { ...sample, signatures: { ...sample.signatures, [secondOwner.toLowerCase()]: sampleSig } }
check('import keeps only signatures that recover to their owner', Object.keys((await importPending([misattributed]))[0]!.signatures).join() === account.address.toLowerCase())
const again = await importPending([{ ...sample, createdAt: 1, signatures: {} }])
check('re-import leaves a queued transaction as it was', again.length === 1 && again[0]!.createdAt === sample.createdAt && again[0]!.signatures[account.address.toLowerCase()] === sampleSig)
savePending([])

// --- deep link: carries the Safe address (and chain), loads it immediately ---
;(globalThis as unknown as { location: unknown }).location = { hash: '', origin: 'https://app.example', pathname: '/', search: '' }
const loc = (globalThis as unknown as { location: { hash: string } }).location
loc.hash = new URL(buildSafeUrl(account.address, 31337)).hash
const safeLink = readShareLink()
check('deep link parses safe + chain', safeLink.safe?.toLowerCase() === account.address.toLowerCase() && safeLink.chainId === 31337 && safeLink.txs === undefined)
loc.hash = new URL(buildShareUrl([sample])).hash
const txLink = readShareLink()
check('deep link parses safe + chain + txs', txLink.safe?.toLowerCase() === safe.toLowerCase() && txLink.chainId === 31337 && txLink.txs?.length === 1 && txLink.txs[0]!.id === sample.id)

// --- single-signature sharing: signer copies just their signature ---
const tx3: SafeTxParams = { ...tx, data: '0xabcd', nonce: 3n }
const hash3 = computeSafeTxHash(31337n, safe, tx3)
const sig3 = await signTx(safe, tx3)
upsertPending({ id: hash3, chainId: 31337, safe, createdAt: Date.now(), tx: serializeTx(tx3), signatures: {} })
const shareSig = { id: hash3, owner: account.address, signature: sig3 }
const sigCode = encodeSignatureShare(shareSig)
check('signature share round-trip', decodeSignatureShare(sigCode).signature === sig3 && parseSignatureShare(buildSignatureUrl(shareSig)).id === hash3)
const imported = await importSignatureShare(pub, decodeSignatureShare(sigCode))
check(
  'importSignatureShare adds the single signature',
  imported.owner.toLowerCase() === account.address.toLowerCase() &&
    imported.list.find((p) => p.id === hash3)?.signatures[account.address.toLowerCase()] === sig3,
)
const elsewhere = computeSafeTxHash(1n, safe, tx3)
upsertPending({ id: elsewhere, chainId: 1, safe, createdAt: Date.now(), tx: serializeTx(tx3), signatures: {} })
check(
  'a signature is not checked against another network',
  await importSignatureShare(pub, { ...shareSig, id: elsewhere }).then(
    () => false,
    () => true,
  ),
)

// --- hardened imports: signature length, chain id, link consistency, Safe identity ---
const shortSig = ('0x' + '11'.repeat(64)) as `0x${string}` // EIP-2098 style, not r‖s‖v
check('packSignatures refuses a signature that is not 65 bytes', throws(() => packSignatures([{ owner: account.address, signature: shortSig }])))
check('normalizeSignatureV refuses a signature that is not 65 bytes', throws(() => normalizeSignatureV(shortSig)))
check(
  'a signature code with a short signature or a short hash is refused',
  throws(() => decodeSignatureShare(encodeSignatureShare({ ...shareSig, signature: shortSig }))) &&
    throws(() => decodeSignatureShare(encodeSignatureShare({ ...shareSig, id: '0x1234' as `0x${string}` }))),
)
check(
  'imports refuse a non-positive chain id',
  throws(() => decodeShare(encodeShare([{ ...sample, chainId: 0 }]))) &&
    throws(() => decodeShare(encodeShare([{ ...sample, chainId: -1 }]))),
)
const otherSafeTx: PendingTx = {
  id: computeSafeTxHash(31337n, secondOwner, tx2),
  chainId: 31337,
  safe: secondOwner,
  createdAt: Date.now(),
  tx: serializeTx(tx2),
  signatures: {},
}
const otherChainTx: PendingTx = {
  id: computeSafeTxHash(1n, safe, tx2),
  chainId: 1,
  safe,
  createdAt: Date.now(),
  tx: serializeTx(tx2),
  signatures: {},
}
loc.hash = `#safe=${secondOwner}&chain=31337&txs=${encodeShare([sample])}`
const foreignSafe = readShareLink()
check(
  'a link naming a Safe its transactions do not belong to imports nothing',
  foreignSafe.mismatch === true &&
    foreignSafe.skipped === 1 &&
    foreignSafe.txs?.length === 0 &&
    foreignSafe.safe?.toLowerCase() === secondOwner.toLowerCase(),
)
loc.hash = `#safe=${sample.safe}&chain=1&txs=${encodeShare([sample])}`
const foreignChain = readShareLink()
check(
  'a link naming another network than its transactions imports nothing',
  foreignChain.mismatch === true && foreignChain.chainId === 1 && foreignChain.txs?.length === 0,
)
// The gap this closes: a payload that *starts* consistent and appends another Safe.
loc.hash = `#safe=${sample.safe}&chain=31337&txs=${encodeShare([sample, otherSafeTx])}`
const mixedPayload = readShareLink()
check(
  'every entry is checked, not just the first: a trailing foreign Safe is dropped',
  mixedPayload.mismatch === true &&
    mixedPayload.skipped === 1 &&
    mixedPayload.txs?.length === 1 &&
    mixedPayload.txs[0]!.id === sample.id,
)
loc.hash = `#safe=${sample.safe}&chain=0&txs=${encodeShare([sample])}`
const zeroChain = readShareLink()
check(
  'a nonsensical chain in the link cannot switch the check off',
  zeroChain.mismatch === true && zeroChain.txs?.length === 0,
)
loc.hash = `#txs=${encodeShare([sample, otherChainTx])}`
const undecorated = readShareLink()
check(
  'a mixed payload is flagged even when the link names no Safe or network',
  undecorated.mismatch === true &&
    undecorated.skipped === 1 &&
    undecorated.txs?.length === 1 &&
    undecorated.chainId === 31337 &&
    undecorated.safe?.toLowerCase() === sample.safe.toLowerCase(),
)
const impostorRuntime = keccak256((await pub.getCode({ address: multiSendLocal }))!)
const forgedAnswers = {
  // everything a lookalike would answer to look like a Safe
  masterCopy: SAFE_ADDRESSES.safeL2,
  version: '1.3.0',
  singletonCodeHash: SAFE_L2_RUNTIME_HASH,
}
check(
  'a real proxy over the official singleton passes the identity check',
  safeIdentityProblem({ proxyCodeHash: SAFE_PROXY_RUNTIME_HASH, ...forgedAnswers }) === null,
)
check(
  'a lookalike answering slot 0 = SafeL2 and version 1.3.0 is refused on its code',
  safeIdentityProblem({ ...forgedAnswers, proxyCodeHash: impostorRuntime }) !== null &&
    proxyRuntimeProblem(impostorRuntime) !== null,
)
check(
  'a proxy over a non-official singleton is refused',
  safeIdentityProblem({ ...forgedAnswers, proxyCodeHash: SAFE_PROXY_RUNTIME_HASH, masterCopy: secondOwner }) !== null,
)
check(
  'a proxy whose singleton is not the official bytecode is refused',
  safeIdentityProblem({
    ...forgedAnswers,
    proxyCodeHash: SAFE_PROXY_RUNTIME_HASH,
    singletonCodeHash: impostorRuntime,
  }) !== null,
)
check(
  'a Safe reporting another version is refused',
  safeIdentityProblem({ ...forgedAnswers, proxyCodeHash: SAFE_PROXY_RUNTIME_HASH, version: '1.4.1' }) !== null,
)
check(
  'assertSafeIdentity refuses an address that is not a proxy, before reading slot 0',
  await assertSafeIdentity(pub, multiSendLocal).then(
    () => false,
    (e: unknown) => String(e).includes('not a Safe proxy'),
  ),
)
check(
  'assertSafeIdentity says an address without code has none',
  await assertSafeIdentity(pub, '0x000000000000000000000000000000000000dEaD').then(
    () => false,
    (e: unknown) => String(e).includes('No contract code'),
  ),
)

// --- the chain guard reads the wallet, not a React snapshot ---
type ChainWallet = Parameters<typeof assertOnCorrectChain>[0]
const fakeWallet = (snapshot: number | null, reported: string): ChainWallet =>
  ({
    provider: { request: async ({ method }: { method: string }) => (method === 'eth_chainId' ? reported : null) },
    chainId: 787223, // the app's network (NVNM testnet)
    walletChainId: snapshot, // what React state would have shown
    networkKey: 'testnet',
  }) as unknown as ChainWallet
const passesChain = (w: ChainWallet) => assertOnCorrectChain(w).then(() => true, () => false)
check(
  'the chain guard asks the wallet, not the snapshot it captured earlier',
  (await passesChain(fakeWallet(787223, '0xc0317'))) && // both agree
    (await passesChain(fakeWallet(1, '0xc0317'))) && // stale snapshot is ignored
    !(await passesChain(fakeWallet(787223, '0x1'))) && // wallet moved away: refused
    !(await passesChain(fakeWallet(787223, 'garbage'))), // unreadable: fails closed
)

// --- a batch must not describe something MultiSendCallOnly will not do ---
const opByteBatch = {
  ...batchTx,
  data: encodeFunctionData({
    abi: multiSendCallOnlyAbi,
    functionName: 'multiSend',
    // flip the first entry's operation byte from call (0) to delegatecall (1)
    args: [`0x01${packMultiSend([{ to: '0x000000000000000000000000000000000000dEaD', value: 0n, data: '0x' }]).slice(4)}`],
  }),
}
check(
  'a batch with an entry that is not a plain call is flagged',
  txRisks(opByteBatch).some((risk) => risk.startsWith('Operation byte')),
)
const fundedBatch = {
  ...batchTx,
  data: encodeFunctionData({
    abi: multiSendCallOnlyAbi,
    functionName: 'multiSend',
    args: [packMultiSend([{ to: '0x000000000000000000000000000000000000dEaD', value: 7n, data: '0x' }])],
  }),
}
check(
  'value is refused, not merely flagged (no native token on this chain)',
  nativeValueProblem(tx) === null &&
    nativeValueProblem(batchTx) === null &&
    (nativeValueProblem({ ...tx, value: 1n }) ?? '').includes('no native token') &&
    (nativeValueProblem({ ...batchTx, value: 1n }) ?? '').includes('the Safe ignores') &&
    (nativeValueProblem(fundedBatch) ?? '').includes('inside this batch'),
)

// --- queueing the same transaction again must keep its signatures ---
const queued = (t: SafeTxParams, signatures: PendingTx['signatures'] = {}): PendingTx => ({
  id: computeSafeTxHash(31337n, safe, t),
  chainId: 31337,
  safe,
  createdAt: Date.now(),
  tx: serializeTx(t),
  signatures,
})
const merged = await importPending([queued(tx3)])
check(
  'importPending keeps signatures of an existing id',
  merged.filter((p) => p.id === hash3).length === 1 &&
    merged.find((p) => p.id === hash3)?.signatures[account.address.toLowerCase()] === sig3,
)

// --- rebasing a dead transaction ---
const dead = queued({ ...tx3, nonce: 1n })
const other = queued({ ...tx3, data: '0x1234', nonce: 5n })
const tx6 = { ...tx3, nonce: 6n }
const sig6 = await signTx(safe, tx6)
const copy = queued(tx6, { [account.address.toLowerCase()]: sig6 })
savePending([dead, other])
check(
  'rebase takes the next free nonce and drops the dead transaction',
  rebasePending(dead, 5n).map((p) => p.id).sort().join() === [other.id, copy.id].sort().join(),
)
savePending([dead, copy])
const kept = rebasePending(dead, 5n)
check(
  'rebasing again keeps the earlier copy and its signatures',
  kept.length === 1 && kept[0]!.id === copy.id && kept[0]!.signatures[account.address.toLowerCase()] === sig6,
)
savePending([])

// --- a mined execTransaction is not always an executed call ---
const failing: SafeTxParams = { ...tx, to: factory, data: '0xdeadbeef', safeTxGas: 100000n, nonce: 3n }
const failed = await exec(safe, failing, await signTx(safe, failing))
check('ExecutionFailure is not taken for an execution', failed.status === 'success' && !executionSucceeded(safe, failed.logs))
const reverting: SafeTxParams = { ...opByteBatch, safeTxGas: 100000n, nonce: 4n }
const reverted = await exec(safe, reverting, await signTx(safe, reverting))
check('MultiSendCallOnly reverts on a delegatecall entry', reverted.status === 'success' && !executionSucceeded(safe, reverted.logs))
const valued: SafeTxParams = { ...batchTx, value: 1n, nonce: 5n }
const ignored = await exec(safe, valued, await signTx(safe, valued))
check('the Safe ignores the value of a delegatecall', (await pub.getBalance({ address: safe })) === 0n && executionSucceeded(safe, ignored.logs))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
