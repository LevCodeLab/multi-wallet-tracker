import { parseEther } from "viem";
import { computeSweepPreview, RpcFailoverPool, SUPPORTED_CHAINS } from "../src";

const pool = new RpcFailoverPool(SUPPORTED_CHAINS[8453].rpcPool);
console.log("Primary Base RPC:", pool.getCurrentUrl());

const preview = computeSweepPreview(
  [
    {
      address: "0x0000000000000000000000000000000000000001",
      balanceWei: parseEther("0.025"),
      hasKey: true
    },
    {
      address: "0x0000000000000000000000000000000000000002",
      balanceWei: parseEther("0.000001"),
      hasKey: true
    }
  ],
  50_000_000n // 0.05 gwei
);

console.log("Sweep preview:", preview);
