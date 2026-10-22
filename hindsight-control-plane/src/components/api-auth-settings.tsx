"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { client, type ApiAuthSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

/** A random key with the prefix that makes it recognisable in a config file or a log. */
function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `hs-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether callers must send an API key, and which. The control plane starts sending the new key itself. */
export function ApiAuthSettingsSection() {
  const t = useTranslations("globalSettings");
  const [state, setState] = useState<ApiAuthSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [generated, setGenerated] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client
      .getApiAuthSettings()
      .then(setState)
      .catch(() => {});
  }, []);

  if (!state) return <Spinner />;

  const open = () => {
    setEnabled(state.enabled);
    setApiKey("");
    setGenerated(false);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      setState(
        await client.updateApiAuthSettings({ enabled, api_key: apiKey.trim() || undefined })
      );
      setEditing(false);
      toast.success(t("authSaved"));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(apiKey);
    toast.success(t("authCopied"));
  };

  // Turning it on needs a key to require: one typed or generated now, or the one already saved.
  const missingKey = enabled && !apiKey.trim() && !state.enabled;

  return (
    <section className="rounded-lg border bg-muted/30 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("authTitle")}</h2>
        {!editing && !state.managed_by_extension && (
          <Button variant="outline" size="sm" onClick={open}>
            {t("edit")}
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("authDescription")}</p>

      <p className="text-sm">
        {state.managed_by_extension
          ? t("authManaged")
          : state.enabled
            ? t("authOn", { hint: state.api_key_hint ?? t("keySet") })
            : t("authOff")}
      </p>

      {editing && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-3">
            <Switch id="api-auth-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="api-auth-enabled">{t("authToggle")}</Label>
          </div>

          {enabled && (
            <div className="space-y-2">
              <Label htmlFor="api-auth-key">{t("authKey")}</Label>
              <div className="flex gap-2">
                <Input
                  id="api-auth-key"
                  type={generated ? "text" : "password"}
                  autoComplete="off"
                  value={apiKey}
                  placeholder={
                    state.enabled
                      ? t("authKeyPlaceholderKeep", { hint: state.api_key_hint ?? t("keySet") })
                      : t("authKeyPlaceholderNew")
                  }
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setGenerated(false);
                  }}
                />
                <Button
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    setApiKey(generateKey());
                    setGenerated(true);
                  }}
                >
                  {t("authGenerate")}
                </Button>
                {generated && (
                  <Button variant="outline" className="shrink-0" onClick={copy}>
                    {t("authCopy")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t("authNote")}</p>
            </div>
          )}

          {enabled && !state.enabled && <Alert>{t("authWarning")}</Alert>}

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving || missingKey}>
              {saving ? t("saving") : t("save")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
