import { proxySettings } from "@/lib/settings-proxy";

export async function GET(request: Request) {
  return proxySettings(
    request,
    "GET",
    "/llm",
    "api.errors.settings.fetch",
    "Failed to get settings"
  );
}

export async function PUT(request: Request) {
  return proxySettings(
    request,
    "PUT",
    "/llm",
    "api.errors.settings.update",
    "Failed to save settings"
  );
}
