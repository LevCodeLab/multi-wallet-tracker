import React, { useEffect, useMemo, useState } from "react";
import { Activity, RefreshCw, RotateCcw, Shuffle } from "lucide-react";
import { isAddress } from "viem";
import {
  SUPPORTED_CHAINS,
  SupportedChainId,
  ZERO_ADDRESS
} from "./lib/chains";
import { GasSweepEngine } from "./lib/gasSweep";
import { WalletIdenticon } from "./lib/identicon";
import { realtimeBalanceEngine } from "./lib/realtimeBalanceEngine";
import { PositionEngine, PositionEngineState } from "./engine/positionEngine";

const DEFAULT_SAMPLE_WALLETS = [
  "0x0000000000000000000000000000000000000001",
  "0x000000000000000000000000000000000000dEaD",
  "0x00000000219ab540356cBB839Cbe05303d7705Fa"
];

function getInitialChainId(): SupportedChainId {
  const raw = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID || 8453);
  if (raw === 1 || raw === 8453 || raw === 42161) return raw;
  return 8453;
}

export const App: React.FC = () => {
  const engine = useMemo(() => new PositionEngine(realtimeBalanceEngine), []);
  const [chainId, setChainId] = useState<SupportedChainId>(getInitialChainId);
  const [addressInput, setAddressInput] = useState<string>(DEFAULT_SAMPLE_WALLETS.join("\n"));
  const [tokenInput, setTokenInput] = useState<string>(
    import.meta.env.VITE_DEFAULT_TOKEN_ADDRESS || ZERO_ADDRESS
  );
  const [treasuryInput, setTreasuryInput] = useState<string>(
    import.meta.env.VITE_TREASURY_SWEEP_ADDRESS || ZERO_ADDRESS
  );
  const [gasPriceGwei, setGasPriceGwei] = useState<number>(0.05);
  const [engineState, setEngineState] = useState<PositionEngineState>(() => engine.getState());

  useEffect(() => {
    return engine.subscribe(setEngineState);
  }, [engine]);

  const parsedAddresses = useMemo(() => {
    return addressInput
      .split(/[\n,\s]+/)
      .map((s) => s.trim())
      .filter((s) => isAddress(s));
  }, [addressInput]);

  const runSync = async (nextChainId: SupportedChainId = chainId) => {
    engine.configure({
      chainId: nextChainId,
      addresses: parsedAddresses,
      tokenAddress: tokenInput
    });
    await engine.sync();
  };

  useEffect(() => {
    runSync(chainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  const sweepEstimate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const w of engineState.wallets) {
      map[w.address] = w.ethBalance;
    }
    return GasSweepEngine.estimateRecoverableFromBalances(map, gasPriceGwei);
  }, [engineState.wallets, gasPriceGwei]);

  const handleRotateRpc = async () => {
    realtimeBalanceEngine.rotateRpcEndpoint();
    await runSync(chainId);
  };

  return (
    <div className="trackerShell">
      {/* Header */}
      <header className="topBar">
        <div className="brandGroup">
          <div className="brandMark">M</div>
          <div>
            <h1 className="brandTitle">Multi-Wallet EVM Tracker</h1>
            <p className="brandSub">
              Single-hit Multicall3 batching · Public RPC failover pool · Gas sweep math
            </p>
          </div>
        </div>

        <div className="chainPillsRow">
          {([1, 8453, 42161] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={chainId === id ? "pillChain active" : "pillChain"}
              onClick={() => setChainId(id)}
            >
              {SUPPORTED_CHAINS[id].shortName} ({id})
            </button>
          ))}

          <button
            type="button"
            className="btnWhitePrimary"
            disabled={engineState.isSyncing}
            onClick={() => runSync(chainId)}
          >
            <RefreshCw size={13} />
            <span>{engineState.isSyncing ? "Syncing..." : "Sync Multicall3"}</span>
          </button>
        </div>
      </header>

      {/* RPC Pool Telemetry */}
      <div className="rpcTelemetryBar">
        <div>
          <Activity size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
          <span>Active RPC: </span>
          <span className="rpcEndpointText">{engineState.summary.rpcUrl}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="monoText">
            Block #{engineState.summary.blockNumber || "---"}
          </span>
          <button type="button" className="btnObsidian" onClick={handleRotateRpc}>
            <Shuffle size={12} />
            <span>Rotate RPC</span>
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <section className="summaryGrid">
        <div className="summaryCard">
          <span className="summaryLabel">WATCHED WALLETS</span>
          <span className="summaryValue">{engineState.summary.walletCount}</span>
          <span className="summaryFoot">
            {engineState.summary.fundedWalletCount} non-zero balances
          </span>
        </div>

        <div className="summaryCard">
          <span className="summaryLabel">TOTAL NATIVE ETH</span>
          <span className="summaryValue">
            {engineState.summary.totalEth.toFixed(4)} ETH
          </span>
          <span className="summaryFoot">
            Est. ${engineState.summary.totalEthUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </span>
        </div>

        <div className="summaryCard">
          <span className="summaryLabel">ERC-20 TOTAL</span>
          <span className="summaryValue">
            {engineState.summary.tokenSymbol
              ? `${engineState.summary.totalTokenBalance.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${engineState.summary.tokenSymbol}`
              : "Native Only"}
          </span>
          <span className="summaryFoot">Set ERC-20 contract to batch balanceOf</span>
        </div>

        <div className="summaryCard">
          <span className="summaryLabel">SWEEPABLE NET ETH</span>
          <span className="summaryValue">
            {sweepEstimate.totalRecoverableEth.toFixed(4)} ETH
          </span>
          <span className="summaryFoot">
            After 21,000 gas x {sweepEstimate.sweepableWallets} wallets
          </span>
        </div>
      </section>

      {/* Main Two-Column Workspace */}
      <main className="mainColumns">
        {/* Left Controls */}
        <aside className="panelCard">
          <h2 className="panelTitle">Wallet List &amp; Sweep Config</h2>

          <label className="fieldLabel" htmlFor="walletsInput">
            EVM ADDRESSES (ONE PER LINE)
          </label>
          <textarea
            id="walletsInput"
            className="addressTextarea"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="0x..."
          />

          <label className="fieldLabel" htmlFor="tokenAddrInput">
            OPTIONAL ERC-20 TOKEN ADDRESS
          </label>
          <input
            id="tokenAddrInput"
            type="text"
            className="textInput"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />

          <label className="fieldLabel" htmlFor="treasuryInput">
            SWEEP DESTINATION TREASURY
          </label>
          <input
            id="treasuryInput"
            type="text"
            className="textInput"
            value={treasuryInput}
            onChange={(e) => setTreasuryInput(e.target.value)}
          />

          <label className="fieldLabel" htmlFor="gasGweiInput">
            GAS PRICE ASSUMPTION (GWEI)
          </label>
          <input
            id="gasGweiInput"
            type="number"
            step="0.01"
            min="0.001"
            className="textInput"
            value={gasPriceGwei}
            onChange={(e) => setGasPriceGwei(Number(e.target.value) || 0.05)}
          />

          <div className="sweepPreviewBox">
            <div className="sweepRow">
              <span>Sweepable Wallets</span>
              <span className="monoText">{sweepEstimate.sweepableWallets}</span>
            </div>
            <div className="sweepRow">
              <span>Total Gas Deduction</span>
              <span className="monoText">{sweepEstimate.totalGasCostEth.toFixed(6)} ETH</span>
            </div>
            <div className="sweepRow">
              <span>Net Recoverable</span>
              <span className="monoText">{sweepEstimate.totalRecoverableEth.toFixed(6)} ETH</span>
            </div>
          </div>

          <button
            type="button"
            className="btnWhitePrimary"
            onClick={() => runSync(chainId)}
          >
            <RotateCcw size={13} />
            <span>Apply &amp; Refresh Balances</span>
          </button>
        </aside>

        {/* Right Wallet Table */}
        <section className="panelCard">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 className="panelTitle">Multicall3 Portfolio Breakdown</h2>
            <span className="monoText" style={{ fontSize: 11, color: "#a1a1aa" }}>
              {parsedAddresses.length} valid EVM addresses
            </span>
          </div>

          {engineState.error && (
            <div className="sweepPreviewBox">
              <span>RPC Warning: {engineState.error}</span>
            </div>
          )}

          <div className="walletTableWrap">
            <table className="walletTable">
              <thead>
                <tr>
                  <th>WALLET</th>
                  <th>NATIVE ETH</th>
                  <th>USD EST.</th>
                  <th>ERC-20</th>
                  <th>SHARE</th>
                </tr>
              </thead>
              <tbody>
                {engineState.wallets.map((w) => (
                  <tr key={w.address}>
                    <td>
                      <div className="walletCellIdentity">
                        <WalletIdenticon address={w.address} size={32} />
                        <div>
                          <div className="monoText" style={{ fontWeight: 700 }}>
                            {w.short}
                          </div>
                          <div className="monoText" style={{ fontSize: 10.5, color: "#a1a1aa" }}>
                            {w.address}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="monoText">{w.ethBalance.toFixed(5)} ETH</td>
                    <td className="monoText">
                      ${w.ethValueUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                    </td>
                    <td className="monoText">
                      {engineState.summary.tokenSymbol
                        ? `${w.tokenBalance.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${engineState.summary.tokenSymbol}`
                        : "-"}
                    </td>
                    <td className="monoText">{w.portfolioSharePct.toFixed(1)}%</td>
                  </tr>
                ))}
                {engineState.wallets.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", color: "#a1a1aa", padding: 28 }}>
                      Paste one or more 0x wallet addresses on the left and click Sync Multicall3.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
};
