import { describe, expect, it } from "vitest";
import { claimRefresh } from "../src/telegram.js";

describe("Telegram refresh cooldown", () => {
  it("allows one refresh every fifteen seconds", () => {
    const cooldowns = new Map<string, number>();
    expect(claimRefresh(cooldowns, "chat:message", 100_000)).toBe(0);
    expect(claimRefresh(cooldowns, "chat:message", 101_000)).toBe(14);
    expect(claimRefresh(cooldowns, "chat:message", 114_999)).toBe(1);
    expect(claimRefresh(cooldowns, "chat:message", 115_000)).toBe(0);
  });
});
