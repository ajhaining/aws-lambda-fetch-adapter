import { defineConfig } from "lint-staged/config";

export default defineConfig({
  "*.{js,cjs,mjs,ts,cts,mts}": ["oxlint --fix", "oxfmt"],
  "*.{json,md,html,yml,yaml}": "oxfmt",
});
