import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";
import { config } from "../src/config";
import { readBook, log10 } from "../src/book";

// This script does not read PRIVATE_KEY, approve tokens, deposit, or broadcast transactions.
const provider = new ethers.providers.StaticJsonRpcProvider(config.readRpcUrl, config.chainId);
const params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
const minMon = Number(ethers.utils.formatUnits(params.minSize, log10(params.sizePrecision)));
const maxMon = Number(ethers.utils.formatUnits(params.maxSize, log10(params.sizePrecision)));
const market = {
  chainId: config.chainId, market: config.market, marginAccount: config.marginAccount,
  quoteToken: params.quoteAssetAddress, minOrderMon: minMon, maxOrderMon: maxMon,
  configuredOrderMon: config.tradeSizeMon,
};
console.log("Kuru MON-USDC market (read-only):", JSON.stringify(market, null, 2));
if (config.tradeSizeMon < minMon || config.tradeSizeMon > maxMon) {
  console.warn("Configured TRADE_SIZE_MON is outside this market's accepted range.");
}
try {
  const book = await readBook(config.readRpcUrl, config.market, params);
  console.log(`Current indicative best ask: ${book.ask.toFixed(6)} USDC/MON`);
  console.log(`One minimum-size bid needs approximately ${(minMon * book.ask).toFixed(4)} margin USDC (price may change).`);
} catch (e) {
  console.warn(`Book unavailable; no current USDC estimate: ${(e as Error).message}`);
}

const input = process.env.WALLET_ADDRESS;
if (input) {
  const wallet = ethers.utils.getAddress(input);
  const token = new ethers.Contract(params.quoteAssetAddress, ["function balanceOf(address) view returns (uint256)"], provider);
  const margin = new ethers.Contract(config.marginAccount, MarginAccountAbi.abi, provider);
  const [walletMon, walletUsdc, marginMon, marginUsdc] = await Promise.all([
    provider.getBalance(wallet), token.balanceOf(wallet),
    margin.getBalance(wallet, ethers.constants.AddressZero),
    margin.getBalance(wallet, params.quoteAssetAddress),
  ]);
  console.log("Balances for", wallet, JSON.stringify({
    walletMon: ethers.utils.formatEther(walletMon),
    walletUsdc: ethers.utils.formatUnits(walletUsdc, params.quoteAssetDecimals.toNumber()),
    marginMon: ethers.utils.formatUnits(marginMon, params.baseAssetDecimals.toNumber()),
    marginUsdc: ethers.utils.formatUnits(marginUsdc, params.quoteAssetDecimals.toNumber()),
  }, null, 2));
  console.log("An ask needs at least one order size in margin MON; a bid needs enough margin USDC. Wallet MON separately pays gas. No transaction was sent.");
} else {
  console.log("Set WALLET_ADDRESS to your public dedicated wallet address to inspect wallet and Kuru margin balances without a private key.");
}
