import { proxySettings } from "@/lib/settings-proxy";

export async function POST(request: Request) {
  return proxySettings(
    request,
    "POST",
    "/llm/test",
    "api.errors.settings.test",
    "Failed to test the connection"
  );
}
