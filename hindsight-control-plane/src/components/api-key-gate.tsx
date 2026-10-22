"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { stripBasePath, withBasePath } from "@/lib/base-path";
import { API_KEY_REQUIRED_EVENT } from "@/lib/api-key-required";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Asks for the API key when the API wants one this control plane does not have: after a restart, since the
 * key is only kept in memory, or when authorization was turned on elsewhere. Entered once, here on the page.
 */
export function ApiKeyGate() {
  const t = useTranslations("apiKeyGate");
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // With a page login the key comes with signing in, so a missing key means signing in again, not typing it.
    const show = async () => {
      try {
        const { mode } = (await (await fetch(withBasePath("/api/auth/mode"))).json()) as {
          mode: string;
        };
        if (mode === "account") {
          // The session is still good but the key is gone (this control plane restarted). End it first, or the
          // login page would see a valid session and send the person straight back here.
          await fetch(withBasePath("/api/auth/logout"), { method: "POST" });
          const here = stripBasePath(`${window.location.pathname}${window.location.search}`);
          window.location.href = withBasePath(`/login?returnTo=${encodeURIComponent(here)}`);
          return;
        }
      } catch {
        // Fall through to the key prompt.
      }
      setOpen(true);
    };
    window.addEventListener(API_KEY_REQUIRED_EVENT, show);
    return () => window.removeEventListener(API_KEY_REQUIRED_EVENT, show);
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(withBasePath("/api/settings/api-key"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      if (response.ok) {
        // Every request the page already made failed without the key; start over with it.
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? t("failed"));
    } catch {
      setError(t("failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            aria-label={t("label")}
            placeholder={t("label")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !apiKey.trim()}>
              {submitting ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
