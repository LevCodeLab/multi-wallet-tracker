import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { RpcFailoverPool } from "../src/lib/chains";
import { computeSweepPreview, GasSweepEngine } from "../src/lib/gasSweep";
import { generateIdenticonDataUri, generateIdenticonSvg } from "../src/lib/identicon";
import { buildPortfolioRows } from "../src/engine/positionEngine";

describe("multi-wallet-tracker core engines", () => {
  it("rotates RPC pool endpoints automatically on failure", async () => {
    const pool = new RpcFailoverPool(["https://bad-rpc-1.local", "https://good-rpc-2.local"]);
    let attempts = 0;

    const { result, rpcUrl } = await pool.executeWithFailover(async (url) => {
      attempts++;
      if (url.includes("bad-rpc-1")) {
        throw new Error("HTTP 503");
      }
      return 19_500_000;
    });

    expect(attempts).toBe(2);
    expect(result).toBe(19_500_000);
    expect(rpcUrl).toBe("https://good-rpc-2.local");
    expect(pool.getCurrentUrl()).toBe("https://good-rpc-2.local");
  });

  it("generates deterministic monochrome SVG identicons", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const svgA = generateIdenticonSvg(addr, 40);
    const svgB = generateIdenticonSvg(addr, 40);
    const uri = generateIdenticonDataUri(addr, 40);

    expect(svgA).toBe(svgB);
    expect(svgA).toContain("#141418");
    expect(svgA).toContain("#26262E");
    expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
  });

  it("subtracts exact 21,000 gas fee and filters dust wallets in GasSweepEngine", () => {
    const gasPriceWei = 1_000_000_000n; // 1 gwei -> 21,000 gwei = 0.000021 ETH fee
    const preview = computeSweepPreview(
      [
        {
          address: "0x1111111111111111111111111111111111111111",
          balanceWei: parseEther("0.01"),
          hasKey: true
        },
        {
          address: "0x2222222222222222222222222222222222222222",
          balanceWei: parseEther("0.00001"), // below 0.000021 gas cost
          hasKey: true
        }
      ],
      gasPriceWei
    );

    expect(preview[0].canSweep).toBe(true);
    expect(preview[0].recoverableEth).toBeCloseTo(0.01 - 0.000021, 8);
    expect(preview[1].canSweep).toBe(false);
    expect(preview[1].recoverableEth).toBe(0);

    const summary = GasSweepEngine.estimateRecoverableFromBalances(
      {
        "0x1111111111111111111111111111111111111111": 0.05,
        "0x2222222222222222222222222222222222222222": 0
      },
      1.0
    );
    expect(summary.sweepableWallets).toBe(1);
    expect(summary.totalRecoverableEth).toBeCloseTo(0.05 - 0.000021, 6);
  });

  it("computes multi-wallet portfolio share percentages cleanly", () => {
    const w1 = "0x1111111111111111111111111111111111111111";
    const w2 = "0x2222222222222222222222222222222222222222";
    const res = buildPortfolioRows({
      addresses: [w1, w2],
      ethBalances: { [w1]: 1.5, [w2]: 0.5 },
      tokenBalances: { [w1]: 100, [w2]: 300 },
      ethPriceUsd: 3000
    });

    expect(res.totalEth).toBeCloseTo(2.0, 6);
    expect(res.totalTokenBalance).toBe(400);
    expect(res.fundedCount).toBe(2);
    expect(res.rows[0].portfolioSharePct).toBeCloseTo(75, 5);
    expect(res.rows[1].portfolioSharePct).toBeCloseTo(25, 5);
  });
});
