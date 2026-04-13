import type { PriceProvider } from "./price-provider.js";

export class StaticPriceProvider implements PriceProvider {
  private readonly usdcPerEthMicros: bigint;

  constructor(usdcPerEthMicros: bigint) {
    if (usdcPerEthMicros <= 0n) {
      throw new Error("Static price provider requires a positive usdcPerEthMicros value");
    }

    this.usdcPerEthMicros = usdcPerEthMicros;
  }

  getUsdcPerEthMicros(): bigint {
    return this.usdcPerEthMicros;
  }

  describe(): string {
    return "static";
  }
}
