import type { Options } from "semantic-release";

export default {
  // "next" publishes regular versions on the next dist-tag; it is not a prerelease-version branch.
  branches: ["main", "next"],
} satisfies Options;
