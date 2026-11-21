import {
  Address,
  formatEther,
  formatUnits,
  isAddress,
  parseAbi
} from "viem";
import {
  CANONICAL_MULTICALL3,
  SupportedChainId,
  ZERO_ADDRESS
} from "../lib/chains";
import { RealtimeBalanceEngine, realtimeBalanceEngine } from "../lib/realtimeBalanceEngine";

const ERC20_METADATA_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)"
]);

const MULTICALL3_ETH_ABI = parseAbi([
  "function getEthBalance(address addr) view returns (uint256 balance)"
]);

export interface TrackedWalletRow {
  address: string;
  short: string;
  ethBalance: number;
  ethValueUsd: number;
  tokenBalance: number;
  portfolioSharePct: number;
}

export interface PortfolioSummary {
  walletCount: number;
  fundedWalletCount: number;
  totalEth: number;
  totalEthUsd: number;
  totalTokenBalance: number;
  tokenSymbol: string | null;
  lastSyncedAt: number;
  blockNumber: number;
  rpcUrl: string;
}

export interface PositionEngineState {
  chainId: SupportedChainId;
  tokenAddress: string | null;
  ethPriceUsd: number;
  wallets: TrackedWalletRow[];
  summary: PortfolioSummary;
  isSyncing: boolean;
  error: string | null;
}

export function buildPortfolioRows(params: {
  addresses: string[];
  ethBalances: Record<string, number>;
  tokenBalances: Record<string, number>;
  ethPriceUsd: number;
}): { rows: TrackedWalletRow[]; totalEth: number; totalTokenBalance: number; fundedCount: number } {
  const { addresses, ethBalances, tokenBalances, ethPriceUsd } = params;
  let totalEth = 0;
  let totalTokenBalance = 0;
  let fundedCount = 0;

  for (const addr of addresses) {
    const key = addr.toLowerCase();
    const eth = ethBalances[key] || 0;
    const tok = tokenBalances[key] || 0;
    totalEth += eth;
    totalTokenBalance += tok;
    if (eth > 0 || tok > 0) {
      fundedCount++;
    }
  }

  const rows: TrackedWalletRow[] = addresses.map((addr) => {
    const key = addr.toLowerCase();
    const ethBalance = ethBalances[key] || 0;
    const tokenBalance = tokenBalances[key] || 0;
    const ethValueUsd = ethBalance * ethPriceUsd;
    const portfolioSharePct = totalEth > 0 ? (ethBalance / totalEth) * 100 : 0;

    return {
      address: addr,
      short: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      ethBalance,
      ethValueUsd,
      tokenBalance,
      portfolioSharePct
    };
  });

  return { rows, totalEth, totalTokenBalance, fundedCount };
}

export class PositionEngine {
  private balanceEngine: RealtimeBalanceEngine;
  private addresses: string[] = [];
  private tokenAddress: string | null = null;
  private ethPriceUsd: number = 3100;
  private subscribers = new Set<(state: PositionEngineState) => void>();

  private state: PositionEngineState;

  public constructor(engine: RealtimeBalanceEngine = realtimeBalanceEngine) {
    this.balanceEngine = engine;
    const net = this.balanceEngine.getNetworkStatus();
    this.state = {
      chainId: net.chainId,
      tokenAddress: null,
      ethPriceUsd: this.ethPriceUsd,
      wallets: [],
      summary: {
        walletCount: 0,
        fundedWalletCount: 0,
        totalEth: 0,
        totalEthUsd: 0,
        totalTokenBalance: 0,
        tokenSymbol: null,
        lastSyncedAt: 0,
        blockNumber: net.blockNumber,
        rpcUrl: net.rpcUrl
      },
      isSyncing: false,
      error: null
    };
  }

  public getState(): PositionEngineState {
    return this.state;
  }

  public subscribe(listener: (state: PositionEngineState) => void): () => void {
    this.subscribers.add(listener);
    listener(this.state);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(): void {
    this.subscribers.forEach((fn) => {
      try {
        fn(this.state);
      } catch {
        // ignore subscriber errors
      }
    });
  }

  public configure(params: {
    chainId?: SupportedChainId;
    addresses?: string[];
    tokenAddress?: string | null;
    ethPriceUsd?: number;
  }): void {
    if (params.chainId && params.chainId !== this.balanceEngine.getChainId()) {
      this.balanceEngine.setChain(params.chainId);
    }
    if (params.addresses) {
      this.addresses = Array.from(
        new Set(params.addresses.map((a) => a.trim()).filter((a) => isAddress(a)))
      );
    }
    if (params.tokenAddress !== undefined) {
      const cleanTok = (params.tokenAddress || "").trim();
      this.tokenAddress =
        cleanTok && isAddress(cleanTok) && cleanTok.toLowerCase() !== ZERO_ADDRESS
          ? cleanTok
          : null;
    }
    if (params.ethPriceUsd && params.ethPriceUsd > 0) {
      this.ethPriceUsd = params.ethPriceUsd;
    }
  }

  /**
   * Executes a single Multicall3 batch to fetch native ETH + optional ERC-20 balances
   * across all watched wallets.
   */
  public async sync(): Promise<PositionEngineState> {
    if (this.addresses.length === 0) {
      const net = this.balanceEngine.getNetworkStatus();
      this.state = {
        ...this.state,
        chainId: net.chainId,
        tokenAddress: this.tokenAddress,
        wallets: [],
        summary: {
          walletCount: 0,
          fundedWalletCount: 0,
          totalEth: 0,
          totalEthUsd: 0,
          totalTokenBalance: 0,
          tokenSymbol: null,
          lastSyncedAt: Date.now(),
          blockNumber: net.blockNumber,
          rpcUrl: net.rpcUrl
        },
        isSyncing: false,
        error: null
      };
      this.emit();
      return this.state;
    }

    this.state = { ...this.state, isSyncing: true, error: null };
    this.emit();

    try {
      const ethBalances = await this.balanceEngine.fetchBatchBalances(this.addresses);
      const tokenBalances: Record<string, number> = {};
      let tokenSymbol: string | null = null;

      if (this.tokenAddress && isAddress(this.tokenAddress)) {
        const client = this.balanceEngine.getClient();
        const tokAddr = this.tokenAddress as Address;

        const contracts = [
          { address: tokAddr, abi: ERC20_METADATA_ABI, functionName: "symbol" as const },
          { address: tokAddr, abi: ERC20_METADATA_ABI, functionName: "decimals" as const },
          ...this.addresses.map((w) => ({
            address: tokAddr,
            abi: ERC20_METADATA_ABI,
            functionName: "balanceOf" as const,
            args: [w as Address] as const
          }))
        ];

        const mcRes = await client.multicall({
          multicallAddress: CANONICAL_MULTICALL3,
          contracts,
          allowFailure: true
        });

        tokenSymbol =
          mcRes[0].status === "success" && typeof mcRes[0].result === "string"
            ? mcRes[0].result
            : "ERC20";
        const decimals =
          mcRes[1].status === "success" && typeof mcRes[1].result === "number"
            ? mcRes[1].result
            : 18;

        this.addresses.forEach((addr, idx) => {
          const entry = mcRes[idx + 2];
          if (entry && entry.status === "success" && typeof entry.result === "bigint") {
            tokenBalances[addr.toLowerCase()] = Number.parseFloat(
              formatUnits(entry.result, decimals)
            );
          } else {
            tokenBalances[addr.toLowerCase()] = 0;
          }
        });
      }

      const { rows, totalEth, totalTokenBalance, fundedCount } = buildPortfolioRows({
        addresses: this.addresses,
        ethBalances,
        tokenBalances,
        ethPriceUsd: this.ethPriceUsd
      });

      const net = this.balanceEngine.getNetworkStatus();
      this.state = {
        chainId: net.chainId,
        tokenAddress: this.tokenAddress,
        ethPriceUsd: this.ethPriceUsd,
        wallets: rows,
        summary: {
          walletCount: rows.length,
          fundedWalletCount: fundedCount,
          totalEth,
          totalEthUsd: totalEth * this.ethPriceUsd,
          totalTokenBalance,
          tokenSymbol,
          lastSyncedAt: Date.now(),
          blockNumber: net.blockNumber,
          rpcUrl: net.rpcUrl
        },
        isSyncing: false,
        error: null
      };
      this.emit();
      return this.state;
    } catch (err) {
      // Retain existing wallet balances if transient RPC failure occurs
      const net = this.balanceEngine.getNetworkStatus();
      this.state = {
        ...this.state,
        chainId: net.chainId,
        isSyncing: false,
        error: err instanceof Error ? err.message : "RPC sync failed"
      };
      this.emit();
      return this.state;
    }
  }
}

export { MULTICALL3_ETH_ABI, formatEther };
export const positionEngine = new PositionEngine();
