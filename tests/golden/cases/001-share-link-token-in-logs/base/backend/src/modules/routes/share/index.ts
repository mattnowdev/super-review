import { FastifyInstance } from "fastify";
import { getShareLinkPreview } from "./getShareLinkPreview/getShareLinkPreview.controller";
import { acceptShareLink } from "./acceptShareLink/acceptShareLink.controller";
import { generateShareLink } from "./generateShareLink/generateShareLink.controller";
import { revokeShareLink } from "./revokeShareLink/revokeShareLink.controller";

export async function shareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/books/:bookId/share-links", { config: { public: false } }, generateShareLink);
  fastify.delete("/share-links/:linkId", { config: { public: false } }, revokeShareLink);

  fastify.get("/share-links/:token/preview", {
    config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, getShareLinkPreview);

  fastify.post("/share-links/:token/accept", {
    config: { public: false },
  }, acceptShareLink);
}
