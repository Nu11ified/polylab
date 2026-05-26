import type { AuthStatus } from "@polylab/types";

const TOKEN_PREFIX = "Bearer ";

export function authStatus(): AuthStatus {
  const token = configuredToken();
  return {
    enabled: Boolean(token),
    mode: token ? "token" : "local-open",
    header: "authorization",
    tokenConfigured: Boolean(token)
  };
}

export function isPublicRoute(request: Request) {
  const url = new URL(request.url);
  return request.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/api/auth/status";
}

export function isAuthorizedRequest(request: Request) {
  const token = configuredToken();
  if (!token || isPublicRoute(request)) return true;
  return bearerToken(request) === token || request.headers.get("x-polylab-token") === token;
}

function configuredToken() {
  const token = process.env.POLYLAB_AUTH_TOKEN?.trim();
  return token && token.length >= 12 ? token : undefined;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith(TOKEN_PREFIX)) return undefined;
  return authorization.slice(TOKEN_PREFIX.length);
}
