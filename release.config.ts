import type { Options } from "semantic-release";

export default {
  // Publish a new stable version when next is merged, rather than retagging via npm dist-tag.
  branches: ["main", { name: "next", prerelease: "next" }],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/npm", { tarballDir: "release" }],
    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "release/*.tgz",
            name: "aws-lambda-fetch-adapter-<%= nextRelease.version %>.tgz",
            label: "npm package v<%= nextRelease.version %>",
          },
        ],
      },
    ],
  ],
} satisfies Options;
