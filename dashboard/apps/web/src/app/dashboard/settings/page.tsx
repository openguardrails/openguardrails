"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Save, Zap } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [ogCoreUrl, setOgCoreUrl] = useState("");
  const [ogCoreKey, setOgCoreKey] = useState("");
  const [dashboardName, setDashboardName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api.getSettings().then((res) => {
      if (res.success) {
        setSettings(res.data);
        setOgCoreUrl(res.data.og_core_url || "https://api.openguardrails.com");
        setOgCoreKey(res.data.og_core_key || "");
        setDashboardName(res.data.dashboard_name || "");
      }
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    const updates: Record<string, string> = {};
    if (ogCoreUrl) updates.og_core_url = ogCoreUrl;
    if (ogCoreKey) updates.og_core_key = ogCoreKey;
    if (dashboardName) updates.dashboard_name = dashboardName;

    const res = await api.updateSettings(updates);
    if (res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    const res = await api.testConnection();
    if (res.success && res.data?.healthy) {
      setTestResult({ ok: true, message: "Connected to core successfully!" });
    } else {
      setTestResult({ ok: false, message: res.data?.error || res.error || "Connection failed" });
    }
    setTesting(false);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="text-muted-foreground">Configure your OpenGuardrails Dashboard</p>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>core Connection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">core URL</label>
              <Input
                value={ogCoreUrl}
                onChange={(e) => setOgCoreUrl(e.target.value)}
                placeholder="https://api.openguardrails.com"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The URL of the core detection API
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">core API Key</label>
              <Input
                type="password"
                value={ogCoreKey}
                onChange={(e) => setOgCoreKey(e.target.value)}
                placeholder="sk-og-..."
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Get your key from platform.openguardrails.com
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={handleTestConnection} disabled={testing}>
                <Zap className="mr-2 h-4 w-4" />
                {testing ? "Testing..." : "Test Connection"}
              </Button>
              {testResult && (
                <Badge variant={testResult.ok ? "success" : "destructive"}>
                  {testResult.message}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dashboard</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium">Dashboard Name</label>
              <Input
                value={dashboardName}
                onChange={(e) => setDashboardName(e.target.value)}
                placeholder="My Dashboard"
              />
            </div>
          </CardContent>
        </Card>

        <Button onClick={handleSave} disabled={saving}>
          <Save className="mr-2 h-4 w-4" />
          {saved ? "Saved!" : saving ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
