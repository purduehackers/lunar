import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  adapter: cloudflare({
    workerEntryPoint: {
      path: "src/server/entrypoint.ts",
      namedExports: ["GameServer"],
    },
  }),
});
