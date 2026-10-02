import { expect, test } from "bun:test";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { Market } from "../src/market";

test("risk-stop cancellation calls batchCancelOrders with the expected order IDs", () => {
  const market = new Market(); // no init, wallet funding or RPC call
  const data = market.encodeCancel([123, 456]);
  const decoded = new ethers.utils.Interface(OrderBookAbi.abi).parseTransaction({ data });
  expect(decoded.functionFragment.name).toBe("batchCancelOrders");
  expect(decoded.args[0].map((id: number | ethers.BigNumber) => Number(id.toString()))).toEqual([123, 456]);
});
