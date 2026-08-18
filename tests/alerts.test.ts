import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hash } from "viem";
import { classifyMovement, movementValuation, renderAlert } from "../src/alerts.js";
import type { TrackedWallet, WalletMovement } from "../src/types.js";

const wallet = getAddress("0x1111111111111111111111111111111111111111");
const router = getAddress("0x2222222222222222222222222222222222222222");
const token = getAddress("0x3333333333333333333333333333333333333333");
const weth = getAddress("0x4444444444444444444444444444444444444444");
const hash = `0x${"ab".repeat(32)}` as Hash;

describe("wallet movement classification", () => {
  it("identifies a token buy", () => {
    const movement = classifyMovement(hash, wallet, 1_000n, 10n, [
      { token, from: router, to: wallet, value: 50_000n },
    ], [weth]);
    expect(movement?.direction).toBe("BUY");
    expect(movement?.tokenAddress).toBe(token);
    expect(movement?.nativeAmountWei).toBe(1_000n);
  });

  it("identifies a token sale into a quote asset", () => {
    const movement = classifyMovement(hash, wallet, 0n, 11n, [
      { token, from: wallet, to: router, value: 25_000n },
      { token: weth, from: router, to: wallet, value: 900n },
    ], [weth]);
    expect(movement?.direction).toBe("SELL");
    expect(movement?.quoteAddress).toBe(weth);
    expect(movement?.quoteAmountRaw).toBe(900n);
  });

  it("does not call a plain outgoing token transfer a sale", () => {
    const movement = classifyMovement(hash, wallet, 0n, 12n, [
      { token, from: wallet, to: router, value: 25_000n },
    ], [weth]);
    expect(movement?.direction).toBe("TRANSFER");
  });

  it("falls back to live token price for a missing quote value", () => {
    const movement = movementFixture();
    const valuation = movementValuation(movement, 9_977_064.857, 0.0000018, getAddress("0x5555555555555555555555555555555555555555"), weth);
    expect(valuation.valueUsd).toBeCloseTo(17.9587, 3);
    expect(valuation.approximate).toBe(true);
    const html = renderAlert(trackedFixture(), movement, "TRUMPBANK", 9_977_064.857, valuation, 0.0000018, 19_710, 5_330);
    expect(html).toContain("≈ $17.96");
    expect(html).toContain("9.98M");
    expect(html).not.toContain("unknown value");
    expect(html).toContain("My Smart Wallet");
  });

  it("uses a USDG settlement as the direct USD value", () => {
    const usdg = getAddress("0x5555555555555555555555555555555555555555");
    const movement = { ...movementFixture(), quoteAddress: usdg, quoteAmountRaw: 42n * 10n ** 18n };
    const valuation = movementValuation(movement, 100, 0.5, usdg, weth);
    expect(valuation.valueUsd).toBe(42);
    expect(valuation.approximate).toBe(false);
  });
});

function movementFixture(): WalletMovement {
  return { txHash: hash, wallet, direction: "BUY", tokenAddress: token, tokenAmountRaw: 1n, quoteAddress: null, quoteAmountRaw: null, nativeAmountWei: 0n, blockNumber: 12n };
}

function trackedFixture(): TrackedWallet {
  return { id: 1, scope: "chat:1", chatId: "1", telegramUserId: "2", address: wallet, label: "My Smart Wallet", isKol: false, enabled: true, createdAt: Date.now() };
}
