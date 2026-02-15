"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";

interface Policy {
  id: string;
  name: string;
  description: string | null;
  scannerIds: string[];
  action: string;
  sensitivityThreshold: number;
  isEnabled: boolean;
  createdAt: string;
}

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scannerIds, setScannerIds] = useState("S01,S02");
  const [action, setAction] = useState("alert");
  const [threshold, setThreshold] = useState("0.7");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadPolicies();
  }, []);

  function loadPolicies() {
    api.listPolicies().then((res) => {
      if (res.success) setPolicies(res.data);
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await api.createPolicy({
      name,
      description: description || undefined,
      scannerIds: scannerIds.split(",").map((s) => s.trim()),
      action,
      sensitivityThreshold: parseFloat(threshold),
    });
    if (res.success) {
      setShowForm(false);
      setName("");
      setDescription("");
      loadPolicies();
    }
    setCreating(false);
  }

  async function handleDelete(id: string) {
    const res = await api.deletePolicy(id);
    if (res.success) loadPolicies();
  }

  const actionColors: Record<string, string> = {
    block: "destructive",
    alert: "warning",
    log: "secondary",
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Policies</h1>
          <p className="text-muted-foreground">Define actions when threats are detected</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="mr-2 h-4 w-4" /> Add Policy
        </Button>
      </div>

      {showForm && (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Block Prompt Injection" />
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <label className="text-sm font-medium">Scanner IDs (comma-separated)</label>
                <Input value={scannerIds} onChange={(e) => setScannerIds(e.target.value)} placeholder="S01,S02" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Action</label>
                  <select
                    className="w-full rounded-md border px-3 py-2 text-sm"
                    value={action}
                    onChange={(e) => setAction(e.target.value)}
                  >
                    <option value="block">Block</option>
                    <option value="alert">Alert</option>
                    <option value="log">Log</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">Sensitivity Threshold</label>
                  <Input type="number" step="0.1" min="0" max="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="mt-6 space-y-3">
        {policies.map((policy) => (
          <Card key={policy.id}>
            <CardContent className="flex items-center justify-between py-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{policy.name}</span>
                  <Badge variant={actionColors[policy.action] as any || "secondary"}>
                    {policy.action}
                  </Badge>
                  {!policy.isEnabled && <Badge variant="outline">Disabled</Badge>}
                </div>
                {policy.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{policy.description}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Scanners: {(policy.scannerIds as string[]).join(", ")} | Threshold: {policy.sensitivityThreshold}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(policy.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {policies.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No policies configured yet.</p>
        )}
      </div>
    </div>
  );
}
