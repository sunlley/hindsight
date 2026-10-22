import { proxySettings } from "@/lib/settings-proxy";

export async function POST(request: Request) {
  return proxySettings(
    request,
    "POST",
    "/restart",
    "api.errors.settings.restart",
    "Failed to restart the server"
  );
}
