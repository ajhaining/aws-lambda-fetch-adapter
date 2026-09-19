import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "api-gateway-v1": "src/api-gateway-v1.ts",
    "api-gateway-v2": "src/api-gateway-v2.ts",
    "function-url": "src/function-url.ts",
  },
  clean: true,
  // package.json includes the implementation sources so declaration-map targets exist after install.
  dts: { sourcemap: true },
  exports: true,
  platform: "node",
  sourcemap: true,
  target: "node22",
  unbundle: true,
});
