"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { client, type ApiAuthSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

const MIN_PASSWORD_LENGTH = 8;

/** The one account the page asks for. Turning it on makes whoever did it signed in, so nothing breaks mid-click. */
export function PageLoginSettingsSection() {
  const t = useTranslations("globalSettings");
  const [state, setState] = useState<ApiAuthSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client
      .getApiAuthSettings()
      .then(setState)
      .catch(() => {});
  }, []);

  if (!state) return <Spinner />;

  const open = () => {
    setUsername(state.admin_username ?? "");
    setPassword("");
    setConfirm("");
    setEditing(true);
  };

  const invalid =
    username.trim().length < 3 || password.length < MIN_PASSWORD_LENGTH || password !== confirm;

  const save = async () => {
    setSaving(true);
    try {
      setState(await client.setPageLoginAccount({ username: username.trim(), password }));
      setEditing(false);
      toast.success(t("pageLoginSaved"));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setSaving(false);
    }
  };

  const turnOff = async () => {
    setSaving(true);
    try {
      setState(await client.removePageLoginAccount());
      setEditing(false);
      toast.success(t("pageLoginOffSaved"));
    } catch {
      // fetchApi already surfaced the error toast.
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border bg-muted/30 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("pageLoginTitle")}</h2>
        {!editing && (
          <Button variant="outline" size="sm" onClick={open}>
            {state.admin_username ? t("edit") : t("pageLoginTurnOn")}
          </Button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("pageLoginDescription")}</p>
      {!state.enabled && !state.managed_by_extension && (
        // The page login only guards this page: with the API open, anyone who reaches the API can still use
        // it directly, or replace the account through the settings endpoints.
        <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">{t("pageLoginApiOpen")}</p>
      )}
      <p className="text-sm">
        {state.admin_username
          ? t("pageLoginOn", { username: state.admin_username })
          : t("pageLoginOff")}
      </p>

      {editing && (
        <div className="mt-4 space-y-3">
          <div className="space-y-2">
            <Label htmlFor="page-login-username">{t("pageLoginUsername")}</Label>
            <Input
              id="page-login-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="page-login-password">{t("pageLoginPassword")}</Label>
            <Input
              id="page-login-password"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder={t("pageLoginPasswordPlaceholder", { min: MIN_PASSWORD_LENGTH })}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="page-login-confirm">{t("pageLoginConfirm")}</Label>
            <Input
              id="page-login-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {confirm && password !== confirm && (
              <p className="text-xs text-destructive">{t("pageLoginMismatch")}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t("pageLoginNote")}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving || invalid}>
              {saving ? t("saving") : t("save")}
            </Button>
            {state.admin_username && (
              <Button variant="outline" onClick={turnOff} disabled={saving}>
                {t("pageLoginTurnOff")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
