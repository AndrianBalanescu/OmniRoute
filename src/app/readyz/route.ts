import { GET as healthGet, HEAD as healthHead } from "../healthz/route";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthGet();
}

export function HEAD(): Response {
  return healthHead();
}
