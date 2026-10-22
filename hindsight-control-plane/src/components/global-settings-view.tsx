"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  client,
  type GlobalLlmModels,
  type GlobalLlmSettings,
  type GlobalLlmTestResult,
} from "@/lib/api";
import { withBasePath } from "@/lib/base-path";
import { useFeatures } from "@/lib/features-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiAuthSettingsSection } from "@/components/api-auth-settings";
import { PageLoginSettingsSection } from "@/components/page-login-settings";
import { FeatureNotEnabled } from "@/components/feature-not-enabled";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const RESTART_POLL_MS = 3000;
const RESTART_GIVE_UP_MS = 120_000;

/** Provider ids the server understands; `openai` and `anthropic` double as the compatible-API types. */
const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepseek",
  "ollama",
  "lmstudio",
  "minimax",
  "openrouter",
];

export function GlobalSettingsView() {
  const t = useTranslations("globalSettings");
  const { features, loading: featuresLoading } = useFeatures();
  const [settings, setSettings] = useState<GlobalLlmSettings | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GlobalLlmTestResult | null>(null);
  const [restartState, setRestartState] = useState<"idle" | "confirm" | "waiting" | "timeout">(
    "idle"
  );
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelList, setModelList] = useState<GlobalLlmModels | null>(null);

  const enabled = features?.global_settings_api ?? false;

  const apply = (s: GlobalLlmSettings) => {
    setSettings(s);
    // The form shows what a restart would use. The key is write-only, so it always starts blank.
    setProvider(s.provider);
    setModel(s.model);
    setBaseUrl(s.base_url ?? "");
    setApiKey("");
  };

  useEffect(() => {
    if (enabled)
      client
        .getGlobalLlmSettings()
        .then(apply)
        .catch(() => {});
  }, [enabled]);

  // While restarting, wait for the server to go down and come back, then reload to show the new values.
  const sawDown = useRef(false);
  useEffect(() => {
    if (restartState !== "waiting") return;
    sawDown.current = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      let up = false;
      try {
        up = (await fetch(withBasePath("/api/settings/llm"), { cache: "no-store" })).ok;
      } catch {
        // The connection refusing is the expected sign of the restart.
      }
      if (!up) sawDown.current = true;
      else if (sawDown.current) window.location.reload();
      if (Date.now() - started > RESTART_GIVE_UP_MS) setRestartState("timeout");
    }, RESTART_POLL_MS);
    return () => clearInterval(timer);
  }, [restartState]);

  if (featuresLoading) return <Spinner />;
  if (!enabled) {
    return <FeatureNotEnabled title={t("disabledTitle")} description={t("disabledDescription")} />;
  }
  if (!settings) return <Spinner />;

  const input = () => ({
    provider,
    model: model.trim() || null,
    base_url: baseUrl.trim() || null,
    api_key: apiKey.trim() || null,
  });

  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setTestResult(null);
    // A model list belongs to the connection it was fetched with.
    setModelList(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      apply(await client.updateGlobalLlmSettings(input()));
      setTestResult(null);
      setEditing(false);
      toast.success(t("saved"));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    apply(settings);
    setTestResult(null);
    setEditing(false);
  };

  const restart = async () => {
    try {
      await client.restartServer();
      setRestartState("waiting");
    } catch {
      // fetchApi already surfaced the error toast.
      setRestartState("idle");
    }
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelList(null);
    try {
      setModelList(await client.listGlobalLlmModels(input()));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setFetchingModels(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await client.testGlobalLlmSettings(input()));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setTesting(false);
    }
  };

  // Offer the models the endpoint listed, plus the current one so an unlisted name is not lost.
  const listed = modelList?.status === "listed" ? modelList.models : [];
  const pickableModels =
    listed.length > 0 ? (model && !listed.includes(model) ? [model, ...listed] : listed) : null;

  const providers = PROVIDERS.includes(provider) ? PROVIDERS : [provider, ...PROVIDERS];
  const providerLabel = (p: string) =>
    p === "openai" ? t("providerOpenai") : p === "anthropic" ? t("providerAnthropic") : p;
  const keyPlaceholder = settings.api_key_set
    ? t("apiKeyPlaceholderSet", { hint: settings.api_key_hint ?? t("keySet") })
    : t("apiKeyPlaceholderEmpty");

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <section className="rounded-lg border bg-muted/30 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t("currentTitle")}</h2>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t("edit")}
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t("provider")}</dt>
          <dd className="min-w-0 break-words">{providerLabel(settings.effective_provider)}</dd>
          <dt className="text-muted-foreground">{t("model")}</dt>
          <dd className="min-w-0 break-words">{settings.effective_model}</dd>
          <dt className="text-muted-foreground">{t("baseUrl")}</dt>
          <dd className="min-w-0 break-all">
            {settings.effective_base_url ?? t("providerDefault")}
          </dd>
          <dt className="text-muted-foreground">{t("apiKey")}</dt>
          <dd>
            {settings.effective_api_key_set
              ? (settings.effective_api_key_hint ?? t("keySet"))
              : t("notSet")}
          </dd>
          <dt className="text-muted-foreground">{t("startedAt")}</dt>
          <dd>{new Date(settings.server_started_at).toLocaleString()}</dd>
        </dl>
      </section>

      {settings.restart_required && (
        <Alert>
          <p>{t("restartRequired")}</p>
          <p className="mt-1 break-all text-muted-foreground">
            {t("pending", {
              provider: providerLabel(settings.provider),
              model: settings.model,
              url: settings.base_url ?? t("providerDefault"),
              key: settings.api_key_set ? (settings.api_key_hint ?? t("keySet")) : t("notSet"),
            })}
          </p>
          {restartState === "waiting" ? (
            <p className="mt-2 flex items-center gap-2">
              <Spinner /> {t("restarting")}
            </p>
          ) : (
            <Button className="mt-3" size="sm" onClick={() => setRestartState("confirm")}>
              {t("restartNow")}
            </Button>
          )}
          {restartState === "timeout" && (
            <p className="mt-2 text-destructive">{t("restartTimeout")}</p>
          )}
        </Alert>
      )}

      <AlertDialog
        open={restartState === "confirm"}
        onOpenChange={(open) => !open && setRestartState("idle")}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("restartConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={restart}>{t("restartConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editing && (
        <>
          <div className="space-y-2">
            <Label htmlFor="llm-provider">{t("provider")}</Label>
            <Select value={provider} onValueChange={edit(setProvider)}>
              <SelectTrigger id="llm-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>
                    {providerLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="llm-base-url">{t("baseUrl")}</Label>
            <Input
              id="llm-base-url"
              type="url"
              value={baseUrl}
              placeholder={t("baseUrlPlaceholder")}
              onChange={(e) => edit(setBaseUrl)(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="llm-api-key">{t("apiKey")}</Label>
            <Input
              id="llm-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={keyPlaceholder}
              onChange={(e) => edit(setApiKey)(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="llm-model">{t("model")}</Label>
            <div className="flex gap-2">
              {pickableModels ? (
                <Select
                  value={model}
                  onValueChange={(value) => {
                    setModel(value);
                    setTestResult(null);
                  }}
                >
                  <SelectTrigger id="llm-model" className="min-w-0 flex-1">
                    <SelectValue placeholder={t("pickModel")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {pickableModels.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="llm-model"
                  value={model}
                  placeholder={t("modelPlaceholder")}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setTestResult(null);
                  }}
                />
              )}
              <Button
                variant="outline"
                className="shrink-0"
                onClick={fetchModels}
                disabled={fetchingModels || testing || saving}
              >
                {fetchingModels ? t("fetchingModels") : t("fetchModels")}
              </Button>
            </div>
            {modelList && (
              <p
                className={
                  modelList.status === "listed"
                    ? "text-xs text-muted-foreground"
                    : "text-xs text-destructive"
                }
              >
                {modelList.status === "listed"
                  ? t("modelsLoaded", { count: modelList.models.length })
                  : t(`models_${modelList.status}`)}
                {pickableModels && (
                  <button
                    type="button"
                    className="ml-2 underline hover:text-foreground"
                    onClick={() => setModelList(null)}
                  >
                    {t("typeManually")}
                  </button>
                )}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">{t("credentialsNote")}</p>

          {testResult && (
            <Alert variant={testResult.ok ? "default" : "destructive"}>
              {t(`test_${testResult.status}`, { ms: Math.round(testResult.latency_ms ?? 0) })}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={test} disabled={testing || saving}>
              {testing ? t("testing") : t("test")}
            </Button>
            <Button onClick={save} disabled={saving || testing}>
              {saving ? t("saving") : t("save")}
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={saving || testing}>
              {t("cancel")}
            </Button>
          </div>
        </>
      )}

      <PageLoginSettingsSection />
      <ApiAuthSettingsSection />
    </div>
  );
}
