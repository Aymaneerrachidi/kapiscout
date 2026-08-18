import { describe, expect, it } from "vitest";
import { calculateMultiple, calculateReturn, extractAddresses, formatTokenPrice, formatUsd } from "../src/utils.js";

describe("address extraction", () => {
  it("extracts and deduplicates EVM addresses", async () => {
    const address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
    expect(extractAddresses(`scan ${address} and ${address.toLowerCase()}`)).toEqual([address]);
  });

  it("ignores malformed addresses", async () => {
    expect(extractAddresses("0x1234 not a contract")).toEqual([]);
  });
});

describe("financial formatting", () => {
  it("calculates call returns and multiples", async () => {
    expect(calculateReturn(100_000, 250_000)).toBe(150);
    expect(calculateMultiple(100_000, 250_000)).toBe(2.5);
  });

  it("formats compact USD values", async () => {
    expect(formatUsd(1_250_000)).toBe("$1.25M");
    expect(formatUsd(null)).toBe("N/A");
    expect(formatTokenPrice(0.000003489)).toBe("$0.0₅3489");
  });
});
