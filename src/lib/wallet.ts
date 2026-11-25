import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import {
  chainFor,
  errorMessage,
  gasToSend,
  getNetwork,
  getNetworkKey,
  networkKeyForChainId,
  NETWORKS,
  setNetworkKey as persistNetwork,
  type NetworkKey,
} from '../chain'

type InjectedProvider = EIP1193Provider & {
  on?: (event: string, handler: (...args: any[]) => void) => void
  removeListener?: (event: string, handler: (...args: any[]) => void) => void
}

export function getInjectedProvider(): InjectedProvider | undefined {
  return (globalThis as { ethereum?: InjectedProvider }).ethereum
}

function chainParams(key: NetworkKey) {
  const n = NETWORKS[key]
  return {
    chainId: `0x${n.chainId.toString(16)}`,
    chainName: n.name,
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    rpcUrls: [n.rpcUrl],
    blockExplorerUrls: [n.explorerUrl],
  }
}

async function ensureChain(provider: InjectedProvider, key: NetworkKey): Promise<void> {
  const net = chainFor(key)
  const current = (await provider.request({ method: 'eth_chainId' })) as string
  if (Number.parseInt(current, 16) === net.id) return
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${net.id.toString(16)}` }],
    })
  } catch (e) {
    const code = (e as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [chainParams(key)] })
    } else {
      throw e
    }
  }
}

export type Wallet = {
  provider?: InjectedProvider
  available: boolean
  account: Address | null
  connecting: boolean
  error: string | null
  networkKey: NetworkKey
  chainId: number
  walletChainId: number | null
  onCorrectChain: boolean
  publicClient: PublicClient
  walletClient: WalletClient | null
  connect: () => Promise<void>
  disconnect: () => void
  switchNetwork: () => Promise<void>
  setNetworkKey: (key: NetworkKey) => void
}

/**
 * Ask the wallet which chain it is on, right now.
 *
 * The `Wallet` snapshot cannot answer this: `walletChainId` only moves when the
 * provider emits `chainChanged`, which is asynchronous and which some wallets
 * (relayed/mobile ones in particular) never emit at all.
 */
export async function readWalletChainId(wallet: Wallet): Promise<number | null> {
  if (!wallet.provider) return null
  try {
    const id = (await wallet.provider.request({ method: 'eth_chainId' })) as string
    const chainId = Number.parseInt(id, 16)
    return Number.isSafeInteger(chainId) ? chainId : null
  } catch {
    return null
  }
}

/**
 * Refuse to use the wallet unless it is on the network the app is reading.
 *
 * Safe addresses are identical on every NVNM network, so a wallet left on another
 * chain would sign for one network and broadcast on another. The chain is read from
 * the provider on every call rather than from React state, so a stale snapshot
 * (or a wallet that never announced its switch) cannot let a transaction through.
 * It is still a check-then-act: the wallet's own domain/chain prompt is the real
 * backstop, this just makes the failure early and legible.
 */
export async function assertOnCorrectChain(wallet: Wallet): Promise<void> {
  const network = chainFor(wallet.networkKey).name
  const chainId = await readWalletChainId(wallet)
  if (chainId === null) {
    throw new Error(`Your wallet's network could not be confirmed; switch it to ${network} and try again.`)
  }
  if (chainId !== wallet.chainId) {
    throw new Error(
      `Your wallet is on chain ${chainId}, but this app is on ${network} (chain ${wallet.chainId}). ` +
        "Switch the wallet's network first.",
    )
  }
}

/** Send a call with `gasToSend` of the node's estimate as its gas, so the wallet does not pad it. */
export async function send(wallet: Wallet, call: { to: Address; data: Hex }): Promise<Hex> {
  if (!wallet.walletClient || !wallet.account) throw new Error('Connect a wallet first.')
  await assertOnCorrectChain(wallet)
  const request = { account: wallet.account, ...call }
  const gas = gasToSend(await wallet.publicClient.estimateGas(request))
  return wallet.walletClient.sendTransaction({ ...request, chain: chainFor(wallet.networkKey), gas })
}

export function useWallet(): Wallet {
  const [networkKey, setKey] = useState<NetworkKey>(getNetworkKey())
  const [account, setAccount] = useState<Address | null>(null)
  const [walletChainId, setWalletChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = getInjectedProvider()

  useEffect(() => {
    const handler = () => setKey(getNetworkKey())
    window.addEventListener('nvnm:network-changed', handler)
    return () => window.removeEventListener('nvnm:network-changed', handler)
  }, [])

  useEffect(() => {
    if (!provider) return
    let cancelled = false
    const readChain = () => {
      provider
        .request({ method: 'eth_chainId' })
        .then((id) => {
          if (!cancelled) setWalletChainId(Number.parseInt(id as string, 16))
        })
        .catch(() => {})
    }
    readChain()
    provider
      .request({ method: 'eth_accounts' })
      .then((accounts) => {
        if (!cancelled) setAccount((accounts as Address[])[0] ?? null)
      })
      .catch(() => {})
    const onAccounts = (accounts: Address[]) => setAccount(accounts?.[0] ?? null)
    // Follow a network picked in the wallet, but not on load, so a link's network wins.
    const onChain = (id: string) => {
      const chainId = Number.parseInt(id, 16)
      setWalletChainId(chainId)
      const key = networkKeyForChainId(chainId)
      if (key && key !== getNetworkKey()) persistNetwork(key)
    }
    provider.on?.('accountsChanged', onAccounts)
    provider.on?.('chainChanged', onChain)
    // Snapshot refreshes for the banner: the guards read the chain themselves, but a
    // wallet that never emits `chainChanged` would otherwise leave the banner wrong.
    window.addEventListener('focus', readChain)
    return () => {
      cancelled = true
      window.removeEventListener('focus', readChain)
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [provider])

  const publicClient = useMemo(
    () => createPublicClient({ chain: chainFor(networkKey), transport: http(getNetwork().rpcUrl) }),
    [networkKey],
  )

  const walletClient = useMemo(() => {
    if (!provider) return null
    return createWalletClient({
      account: account ?? undefined,
      chain: chainFor(networkKey),
      transport: custom(provider),
    })
  }, [provider, account, networkKey])

  const connect = useCallback(async () => {
    if (!provider) {
      setError('No EVM wallet detected. Install MetaMask, Rabby, or another injected wallet.')
      return
    }
    setConnecting(true)
    setError(null)
    try {
      await ensureChain(provider, getNetworkKey())
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
      setAccount(accounts[0] ?? null)
      const id = (await provider.request({ method: 'eth_chainId' })) as string
      setWalletChainId(Number.parseInt(id, 16))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setConnecting(false)
    }
  }, [provider])

  const switchNetwork = useCallback(async () => {
    if (!provider) return
    setError(null)
    try {
      await ensureChain(provider, getNetworkKey())
      const id = (await provider.request({ method: 'eth_chainId' })) as string
      setWalletChainId(Number.parseInt(id, 16))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [provider])

  const disconnect = useCallback(() => setAccount(null), [])

  const setNetworkKey = useCallback(
    (key: NetworkKey) => {
      persistNetwork(key)
      if (account) void switchNetwork()
    },
    [account, switchNetwork],
  )

  return {
    provider,
    available: Boolean(provider),
    account,
    connecting,
    error,
    networkKey,
    chainId: getNetwork().chainId,
    walletChainId,
    onCorrectChain: walletChainId === getNetwork().chainId,
    publicClient,
    walletClient,
    connect,
    disconnect,
    switchNetwork,
    setNetworkKey,
  }
}
