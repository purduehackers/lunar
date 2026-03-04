import { handle } from "@astrojs/cloudflare/handler";
import { routePartykitRequest } from "partyserver";
import { GameServer } from "./server";

export { GameServer };

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) {
      return partyResponse;
    }

    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
