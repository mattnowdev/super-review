import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";

// Share-link routes embed the token as `/share-links/<token>/...`.
function sanitizeUrl(url: string): string {
  return url.replace(/(\/share-links\/)[^/?]+/g, "$1[redacted]");
}

export function setupErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode ?? 500;
    const code = (error as any).code;
    const errorMessage = error.message;
    const isHttpError = status >= 400 && status < 500;
    const safeUrl = sanitizeUrl(request.url);

    if (status >= 500) {
      request.log.error({ err: error, code, url: safeUrl, method: request.method }, "server error");
    } else {
      console.warn(`[${status}] ${request.method} ${safeUrl} - ${errorMessage}`);
    }

    const payload: { statusCode: number; message: string; code?: string } = {
      statusCode: status,
      message: isHttpError ? errorMessage : "Internal Server Error",
    };
    if (code && /^[a-z][\w.]*$/.test(code)) {
      payload.code = code;
    }

    reply.code(status).send(payload);
  });
}
