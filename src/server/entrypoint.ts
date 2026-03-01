import type { SSRManifest } from "astro";
import { App } from "astro/app";
import { handle } from "@astrojs/cloudflare/handler";
import { routePartykitRequest } from "partyserver";
import { GameServer } from "./game-server";

export { GameServer };

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);

  return {
    default: {
      async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        const partyResponse = await routePartykitRequest(request, env);
        if (partyResponse) {
          return partyResponse;
        }

        return handle(manifest, app, request, env, ctx);
      },
    } satisfies ExportedHandler<Env>,

    GameServer,
  };
}
