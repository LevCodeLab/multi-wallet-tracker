import {
  Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseAbi,
  parseEther,
  PublicClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANONICAL_MULTICALL3,
  RpcFailoverPool,
  SUPPORTED_CHAINS,
  SupportedChainId
} from "./chains";

const MULTICALL3_ABI = parseAbi([
  "function getEthBalance(address addr) view returns (uint256 balance)",
  "function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"
]);

export interface NetworkStatus {
  chainId: SupportedChainId;
  chainName: string;
  rpcUrl: string;
  blockNumber: number;
  latencyMs: number;
}

export interface DisperseTransfer {
  recipient: string;
  amountEth: number;
}

export interface DisperseResult {
  success: boolean;
  totalDispersed: number;
  txHashes: string[];
  transfersCount: number;
  error?: string;
}

export class RealtimeBalanceEngine {
  private chainId: SupportedChainId;
  private failoverPool: RpcFailoverPool;
  private currentBlock: number = 0;
  private lastLatencyMs: number = 0;

  private balanceCache = new Map<string, { balance: number; timestamp: number }>();
  private inFlightPromise: Promise<Record<string, number>> | null = null;
  private readonly cacheTtlMs = 1500;

  private networkListeners = new Set<(status: NetworkStatus) => void>();

  public constructor(initialChainId: SupportedChainId = 8453, customRpcUrl?: string) {
    this.chainId = SUPPORTED_CHAINS[initialChainId] ? initialChainId : 8453;
    this.failoverPool = new RpcFailoverPool(
      SUPPORTED_CHAINS[this.chainId].rpcPool,
      customRpcUrl
    );
  }

  public setChain(chainId: SupportedChainId, customRpcUrl?: string): void {
    if (!SUPPORTED_CHAINS[chainId]) return;
    this.chainId = chainId;
    this.failoverPool = new RpcFailoverPool(
      SUPPORTED_CHAINS[chainId].rpcPool,
      customRpcUrl
    );
    this.currentBlock = 0;
    this.balanceCache.clear();
    this.notifyNetworkListeners();
  }

  public getChainId(): SupportedChainId {
    return this.chainId;
  }

  public rotateRpcEndpoint(): string {
    const nextUrl = this.failoverPool.rotateNext();
    this.notifyNetworkListeners();
    return nextUrl;
  }

  public getClient(rpcUrl: string = this.failoverPool.getCurrentUrl()): PublicClient {
    const cfg = SUPPORTED_CHAINS[this.chainId];
    return createPublicClient({
      chain: cfg.viemChain,
      transport: http(rpcUrl, { timeout: 6000 })
    });
  }

  public getNetworkStatus(): NetworkStatus {
    const cfg = SUPPORTED_CHAINS[this.chainId];
    return {
      chainId: this.chainId,
      chainName: cfg.name,
      rpcUrl: this.failoverPool.getCurrentUrl(),
      blockNumber: this.currentBlock,
      latencyMs: this.lastLatencyMs
    };
  }

  public onNetworkChange(cb: (status: NetworkStatus) => void): () => void {
    this.networkListeners.add(cb);
    cb(this.getNetworkStatus());
    return () => {
      this.networkListeners.delete(cb);
    };
  }

  private notifyNetworkListeners(): void {
    const status = this.getNetworkStatus();
    this.networkListeners.forEach((fn) => {
      try {
        fn(status);
      } catch {
        // ignore listener errors
      }
    });
  }

  public invalidateAddress(address: string): void {
    if (address) {
      this.balanceCache.delete(`${this.chainId}:${address.toLowerCase()}`);
    }
  }

  /**
   * Resolves native ETH balances for up to 100+ wallets in a single Multicall3 round-trip,
   * automatically failing over across the public RPC pool on error.
   */
  public async fetchBatchBalances(addresses: string[]): Promise<Record<string, number>> {
    if (!addresses || addresses.length === 0) return {};

    const cleanAddresses = Array.from(
      new Set(
        addresses
          .filter((a) => Boolean(a && isAddress(a)))
          .map((a) => a.toLowerCase() as Address)
      )
    );
    if (cleanAddresses.length === 0) return {};

    const now = Date.now();
    const out: Record<string, number> = {};
    const toFetch: Address[] = [];

    for (const addr of cleanAddresses) {
      const cacheKey = `${this.chainId}:${addr}`;
      const cached = this.balanceCache.get(cacheKey);
      if (cached && now - cached.timestamp < this.cacheTtlMs) {
        out[addr] = cached.balance;
      } else {
        toFetch.push(addr);
      }
    }

    if (toFetch.length === 0) return out;

    if (this.inFlightPromise) {
      const shared = await this.inFlightPromise;
      Object.assign(out, shared);
      const missing = toFetch.filter((a) => out[a] === undefined);
      if (missing.length === 0) return out;
    }

    this.inFlightPromise = (async () => {
      const startedAt = Date.now();
      const fetched: Record<string, number> = {};

      const { result } = await this.failoverPool.executeWithFailover(async (rpcUrl) => {
        const client = this.getClient(rpcUrl);
        const [blockNumber, multicallRes] = await Promise.all([
          client.getBlockNumber(),
          client.multicall({
            multicallAddress: CANONICAL_MULTICALL3,
            contracts: toFetch.map((addr) => ({
              address: CANONICAL_MULTICALL3,
              abi: MULTICALL3_ABI,
              functionName: "getEthBalance" as const,
              args: [addr] as const
            })),
            allowFailure: true
          })
        ]);
        return { blockNumber, multicallRes };
      });

      this.currentBlock = Number(result.blockNumber);
      this.lastLatencyMs = Math.max(1, Date.now() - startedAt);
      this.notifyNetworkListeners();

      result.multicallRes.forEach((entry, idx) => {
        const addr = toFetch[idx];
        if (entry.status === "success" && typeof entry.result === "bigint") {
          const ethVal = Number.parseFloat(formatEther(entry.result));
          fetched[addr] = ethVal;
          this.balanceCache.set(`${this.chainId}:${addr}`, {
            balance: ethVal,
            timestamp: Date.now()
          });
        } else {
          fetched[addr] = 0;
        }
      });

      return fetched;
    })();

    try {
      const fresh = await this.inFlightPromise;
      Object.assign(out, fresh);
      return out;
    } finally {
      this.inFlightPromise = null;
    }
  }

  /**
   * Atomic native ETH disperse across multiple recipients via Multicall3 aggregate3Value.
   */
  public async disperseFundsOnChain(params: {
    funderPrivateKey: `0x${string}`;
    transfers: DisperseTransfer[];
  }): Promise<DisperseResult> {
    const validTransfers = params.transfers.filter(
      (t) => t.amountEth > 0 && isAddress(t.recipient)
    );
    if (validTransfers.length === 0) {
      return { success: true, totalDispersed: 0, txHashes: [], transfersCount: 0 };
    }

    try {
      const cfg = SUPPORTED_CHAINS[this.chainId];
      const rpcUrl = this.failoverPool.getCurrentUrl();
      const account = privateKeyToAccount(params.funderPrivateKey);
      const publicClient = this.getClient(rpcUrl);
      const walletClient = createWalletClient({
        account,
        chain: cfg.viemChain,
        transport: http(rpcUrl)
      });

      const calls = validTransfers.map((t) => ({
        target: t.recipient as Address,
        allowFailure: false,
        value: parseEther(t.amountEth.toFixed(6)),
        callData: "0x" as const
      }));

      const totalValueWei = calls.reduce((acc, c) => acc + c.value, 0n);
      const totalEth = validTransfers.reduce((acc, t) => acc + t.amountEth, 0);

      const txHash = await walletClient.writeContract({
        address: CANONICAL_MULTICALL3,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3Value",
        args: [calls],
        value: totalValueWei
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      validTransfers.forEach((t) => this.invalidateAddress(t.recipient));

      return {
        success: true,
        totalDispersed: totalEth,
        txHashes: [txHash],
        transfersCount: validTransfers.length
      };
    } catch (err) {
      return {
        success: false,
        totalDispersed: 0,
        txHashes: [],
        transfersCount: 0,
        error: err instanceof Error ? err.message : "Failed to disperse ETH"
      };
    }
  }
}

export const realtimeBalanceEngine = new RealtimeBalanceEngine();
