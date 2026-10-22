"use client";

import { useEffect } from "react";
import { BankSelector } from "@/components/bank-selector";
import { GlobalSettingsView } from "@/components/global-settings-view";
import { useBank } from "@/lib/bank-context";

export default function SettingsPage() {
  const { setCurrentBank } = useBank();

  // Global, not bank-scoped: same reasoning as the dashboard.
  useEffect(() => {
    setCurrentBank(null);
  }, [setCurrentBank]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 flex flex-col">
        <BankSelector />
        <GlobalSettingsView />
      </div>
    </div>
  );
}
