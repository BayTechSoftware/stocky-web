import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Standard dynamic rendering (pages read cookies() → dynamic). */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
