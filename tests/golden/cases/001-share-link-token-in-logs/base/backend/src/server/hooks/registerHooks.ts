import { FastifyInstance } from "fastify";
import { isMaintenanceMode } from "@/server/posthog";
import { authPrehandler } from "@/server/auth/authPrehandler";

export function registerHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url.includes("/webhooks")) {
      return;
    }
    if (await isMaintenanceMode()) {
      reply.code(503).send({ error: "Maintenance mode" });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return;
    }
    await authPrehandler(request, reply);
  });
}
