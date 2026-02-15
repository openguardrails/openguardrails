"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, Eye, Save } from "lucide-react";

interface Scanner {
  id: string;
  scannerId: string;
  name: string;
  description: string;
  isEnabled: boolean;
}

const PROTECTION_IDS = ["S01", "S02", "S03", "S04", "S05"];

export default function ScannersPage() {
  const [scanners, setScanners] = useState<Scanner[]>([]);
  const [editing, setEditing] = useState<Scanner[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.listScanners().then((res) => {
      if (res.success) {
        setScanners(res.data);
        setEditing(res.data.map((s: Scanner) => ({ ...s })));
      }
    });
  }, []);

  function toggleScanner(idx: number) {
    setEditing((prev) => prev.map((s, i) => (i === idx ? { ...s, isEnabled: !s.isEnabled } : s)));
  }

  async function handleSave() {
    setSaving(true);
    const res = await api.updateScanners(editing);
    if (res.success) {
      setScanners(res.data);
      setEditing(res.data.map((s: Scanner) => ({ ...s })));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }

  const hasChanges = JSON.stringify(scanners) !== JSON.stringify(editing);

  const protectionScanners = editing.filter((s) => PROTECTION_IDS.includes(s.scannerId));
  const supervisionScanners = editing.filter((s) => !PROTECTION_IDS.includes(s.scannerId));

  function renderGroup(title: string, subtitle: string, icon: React.ReactNode, items: Scanner[]) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          {icon}
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="space-y-3">
          {items.map((scanner) => {
            const globalIdx = editing.findIndex((s) => s.scannerId === scanner.scannerId);
            return (
              <Card key={scanner.scannerId}>
                <CardContent className="flex items-start gap-4 py-4">
                  <button
                    onClick={() => toggleScanner(globalIdx)}
                    className={`mt-1 flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${scanner.isEnabled ? "bg-primary" : "bg-gray-200"}`}
                  >
                    <span
                      className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${scanner.isEnabled ? "translate-x-5" : "translate-x-0.5"}`}
                    />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono">{scanner.scannerId}</Badge>
                      <span className="text-sm font-semibold">{scanner.name}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{scanner.description}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">OG Top 10</h1>
          <p className="text-muted-foreground">The most critical threats to AI agents — toggle scanners on or off for your API calls</p>
        </div>
        <Button onClick={handleSave} disabled={!hasChanges || saving}>
          <Save className="mr-2 h-4 w-4" />
          {saved ? "Saved!" : saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <div className="mt-8 space-y-8">
        {renderGroup(
          "Protection",
          "Threats from attacks against the Agent",
          <Shield className="h-5 w-5 text-red-500" />,
          protectionScanners,
        )}
        {renderGroup(
          "Supervision",
          "Threats from Agent mistakes",
          <Eye className="h-5 w-5 text-amber-500" />,
          supervisionScanners,
        )}
      </div>
    </div>
  );
}
