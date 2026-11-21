import { Chain } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";

export type SupportedChainId = 1 | 8453 | 42161;

export interface EvmChainConfig {
  id: SupportedChainId;
  name: string;
  shortName: string;
  nativeSymbol: string;
  viemChain: Chain;
  rpcPool: readonly string[];
  multicall3Address: `0x${string}`;
}

export const CANONICAL_MULTICALL3 =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export const SUPPORTED_CHAINS: Record<SupportedChainId, EvmChainConfig> = {
  1: {
    id: 1,
    name: "Ethereum Mainnet",
    shortName: "Ethereum",
    nativeSymbol: "ETH",
    viemChain: mainnet,
    rpcPool: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://1rpc.io/eth"
    ],
    multicall3Address: CANONICAL_MULTICALL3
  },
  8453: {
    id: 8453,
    name: "Base Mainnet",
    shortName: "Base",
    nativeSymbol: "ETH",
    viemChain: base,
    rpcPool: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://1rpc.io/base"
    ],
    multicall3Address: CANONICAL_MULTICALL3
  },
  42161: {
    id: 42161,
    name: "Arbitrum One",
    shortName: "Arbitrum",
    nativeSymbol: "ETH",
    viemChain: arbitrum,
    rpcPool: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://1rpc.io/arb"
    ],
    multicall3Address: CANONICAL_MULTICALL3
  }
};

/**
 * Stateful RPC failover pool for a chain.
 * Rotates automatically when an endpoint drops, times out, or returns 429/5xx.
 */
export class RpcFailoverPool {
  private readonly urls: string[];
  private activeIndex: number = 0;

  public constructor(urls: readonly string[], customPrimaryUrl?: string) {
    const deduped: string[] = [];
    if (customPrimaryUrl && customPrimaryUrl.trim()) {
      deduped.push(customPrimaryUrl.trim());
    }
    for (const u of urls) {
      if (u && !deduped.includes(u)) {
        deduped.push(u);
      }
    }
    if (deduped.length === 0) {
      throw new Error("RpcFailoverPool requires at least one RPC URL");
    }
    this.urls = deduped;
  }

  public getCurrentUrl(): string {
    return this.urls[this.activeIndex % this.urls.length];
  }

  public getAllUrls(): readonly string[] {
    return this.urls;
  }

  public rotateNext(): string {
    this.activeIndex = (this.activeIndex + 1) % this.urls.length;
    return this.getCurrentUrl();
  }

  public getOrderedCandidates(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.urls.length; i++) {
      out.push(this.urls[(this.activeIndex + i) % this.urls.length]);
    }
    return out;
  }

  /**
   * Executes an async operation against the current primary RPC and fails over
   * across remaining pool endpoints on error.
   */
  public async executeWithFailover<T>(
    task: (rpcUrl: string) => Promise<T>
  ): Promise<{ result: T; rpcUrl: string }> {
    const candidates = this.getOrderedCandidates();
    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidateUrl = candidates[i];
      try {
        const result = await task(candidateUrl);
        return { result, rpcUrl: candidateUrl };
      } catch (err) {
        lastError = err;
        if (i < candidates.length - 1) {
          this.rotateNext();
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("All RPC endpoints in failover pool failed");
  }
}
