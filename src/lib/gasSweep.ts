import {
  Address,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseEther,
  PublicClient
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SUPPORTED_CHAINS, SupportedChainId } from "./chains";
import { sessionKeyStore } from "./sessionKeyStore";

export interface WalletSweepInfo {
  address: string;
  balanceEth: number;
  transferGasFeeEth: number;
  recoverableEth: number;
  hasSessionKey: boolean;
  canSweep: boolean;
}

export interface SweepBatchResult {
  totalSweptEth: number;
  successfulSweeps: number;
  failedSweeps: number;
  txHashes: string[];
  error?: string;
}

const STANDARD_TRANSFER_GAS = 21_000n;
const MIN_SWEEP_THRESHOLD_ETH = 0.000005;

/**
 * Pure deterministic sweep calculator given raw wei balances and gasPrice.
 */
export function computeSweepPreview(
  wallets: ReadonlyArray<{ address: string; balanceWei: bigint; hasKey?: boolean }>,
  gasPriceWei: bigint
): WalletSweepInfo[] {
  const transferFeeWei = STANDARD_TRANSFER_GAS * gasPriceWei;
  const transferGasFeeEth = Number.parseFloat(formatEther(transferFeeWei));

  return wallets.map((w) => {
    const balanceEth = Number.parseFloat(formatEther(w.balanceWei));
    const recoverableWei = w.balanceWei > transferFeeWei ? w.balanceWei - transferFeeWei : 0n;
    const recoverableEth = Number.parseFloat(formatEther(recoverableWei));
    const hasSessionKey = Boolean(w.hasKey ?? sessionKeyStore.hasKey(w.address));

    return {
      address: w.address,
      balanceEth,
      transferGasFeeEth,
      recoverableEth,
      hasSessionKey,
      canSweep: recoverableEth > MIN_SWEEP_THRESHOLD_ETH && hasSessionKey
    };
  });
}

export class GasSweepEngine {
  /**
   * Evaluates recoverable native ETH across multiple wallets after subtracting 21,000 gas.
   */
  public static async evaluateSweepCandidates(
    publicClient: PublicClient,
    walletAddresses: string[]
  ): Promise<WalletSweepInfo[]> {
    const clean = walletAddresses.filter((a) => isAddress(a)) as Address[];
    if (clean.length === 0) return [];

    const gasPriceWei = await publicClient.getGasPrice().catch(() => 100_000_000n); // 0.1 gwei fallback
    const balances = await Promise.all(
      clean.map((addr) => publicClient.getBalance({ address: addr }).catch(() => 0n))
    );

    return computeSweepPreview(
      clean.map((address, idx) => ({
        address,
        balanceWei: balances[idx],
        hasKey: sessionKeyStore.hasKey(address)
      })),
      gasPriceWei
    );
  }

  /**
   * Sweeps recoverable ETH from session-unlocked wallets to a target treasury address.
   */
  public static async executeSweep(params: {
    publicClient: PublicClient;
    chainId: SupportedChainId;
    rpcUrl: string;
    candidates: WalletSweepInfo[];
    targetTreasuryAddress: string;
  }): Promise<SweepBatchResult> {
    const { publicClient, chainId, rpcUrl, candidates, targetTreasuryAddress } = params;
    if (!isAddress(targetTreasuryAddress)) {
      return {
        totalSweptEth: 0,
        successfulSweeps: 0,
        failedSweeps: candidates.length,
        txHashes: [],
        error: "Invalid target treasury address"
      };
    }

    const cfg = SUPPORTED_CHAINS[chainId];
    const gasPrice = await publicClient.getGasPrice().catch(() => 100_000_000n);
    const transferFeeWei = STANDARD_TRANSFER_GAS * gasPrice;

    let totalSweptEth = 0;
    let successfulSweeps = 0;
    let failedSweeps = 0;
    const txHashes: string[] = [];

    for (const candidate of candidates) {
      const pk = sessionKeyStore.getKey(candidate.address);
      if (!candidate.canSweep || !pk) {
        failedSweeps++;
        continue;
      }

      try {
        const account = privateKeyToAccount(pk);
        const walletClient = createWalletClient({
          account,
          chain: cfg.viemChain,
          transport: http(rpcUrl)
        });

        const liveBalWei = await publicClient.getBalance({
          address: candidate.address as Address
        });
        if (liveBalWei <= transferFeeWei) {
          failedSweeps++;
          continue;
        }

        const sendWei = liveBalWei - transferFeeWei;
        const hash = await walletClient.sendTransaction({
          to: targetTreasuryAddress as Address,
          value: sendWei,
          gas: STANDARD_TRANSFER_GAS,
          gasPrice
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") {
          successfulSweeps++;
          totalSweptEth += Number.parseFloat(formatEther(sendWei));
          txHashes.push(hash);
        } else {
          failedSweeps++;
        }
      } catch {
        failedSweeps++;
      }
    }

    return {
      totalSweptEth,
      successfulSweeps,
      failedSweeps,
      txHashes
    };
  }

  public static estimateRecoverableFromBalances(
    balancesEth: Record<string, number>,
    gasPriceGwei: number = 0.05
  ): {
    sweepableWallets: number;
    totalBalanceEth: number;
    totalGasCostEth: number;
    totalRecoverableEth: number;
  } {
    const gasPriceWei = BigInt(Math.max(1, Math.round(gasPriceGwei * 1e9)));
    const entries = Object.entries(balancesEth).map(([address, eth]) => ({
      address,
      balanceWei: eth > 0 ? parseEther(eth.toFixed(8)) : 0n,
      hasKey: true
    }));

    const preview = computeSweepPreview(entries, gasPriceWei);
    let sweepableWallets = 0;
    let totalBalanceEth = 0;
    let totalGasCostEth = 0;
    let totalRecoverableEth = 0;

    for (const item of preview) {
      totalBalanceEth += item.balanceEth;
      if (item.recoverableEth > MIN_SWEEP_THRESHOLD_ETH) {
        sweepableWallets++;
        totalGasCostEth += item.transferGasFeeEth;
        totalRecoverableEth += item.recoverableEth;
      }
    }

    return {
      sweepableWallets,
      totalBalanceEth,
      totalGasCostEth,
      totalRecoverableEth
    };
  }
}
