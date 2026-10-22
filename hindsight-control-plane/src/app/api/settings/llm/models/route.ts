import { proxySettings } from "@/lib/settings-proxy";

export async function POST(request: Request) {
  return proxySettings(
    request,
    "POST",
    "/llm/models",
    "api.errors.settings.models",
    "Failed to list models"
  );
}
