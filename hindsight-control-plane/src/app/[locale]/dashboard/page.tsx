"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { BankSelector } from "@/components/bank-selector";
import { BanksOverview } from "@/components/banks-overview";
import { Button } from "@/components/ui/button";
import { useBank } from "@/lib/bank-context";
import { useFeatures } from "@/lib/features-context";

export default function DashboardPage() {
  const { setCurrentBank } = useBank();
  const { features } = useFeatures();
  const t = useTranslations("banksOverview");

  // This page is the "all banks" view, so nothing is selected while it is open.
  // The selection survives navigating back here from a bank page otherwise, and the
  // header would keep offering bank-scoped actions for a bank that is not on screen.
  useEffect(() => {
    setCurrentBank(null);
  }, [setCurrentBank]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 flex flex-col">
        <BankSelector />
        {features?.global_settings_api && (
          <div className="mx-auto flex w-full max-w-6xl justify-end px-6 pt-4">
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings">
                <Settings className="mr-1.5 h-4 w-4" />
                {t("settings")}
              </Link>
            </Button>
          </div>
        )}
        <BanksOverview />
      </div>
    </div>
  );
}
