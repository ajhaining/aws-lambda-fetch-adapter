import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "api-gateway-v1": "src/api-gateway-v1.ts",
    "api-gateway-v2": "src/api-gateway-v2.ts",
    "function-url": "src/function-url.ts",
  },
  clean: true,
  dts: true,
  exports: true,
  platform: "node",
  target: "node22",
  unbundle: true,
});
