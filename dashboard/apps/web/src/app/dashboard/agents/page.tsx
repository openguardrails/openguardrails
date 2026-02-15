"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: string;
  lastHeartbeat: string | null;
  createdAt: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState("custom");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadAgents();
  }, []);

  function loadAgents() {
    api.listAgents().then((res) => {
      if (res.success) setAgents(res.data);
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    const res = await api.createAgent({ name, description: description || undefined, provider });
    if (res.success) {
      setShowForm(false);
      setName("");
      setDescription("");
      loadAgents();
    }
    setCreating(false);
  }

  async function handleDelete(id: string) {
    const res = await api.deleteAgent(id);
    if (res.success) loadAgents();
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-muted-foreground">{agents.length} of 10 agents registered</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} disabled={agents.length >= 10}>
          <Plus className="mr-2 h-4 w-4" /> Add Agent
        </Button>
      </div>

      {showForm && (
        <Card className="mt-4">
          <CardContent className="pt-6">
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-sm font-medium">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="My Agent" />
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
              </div>
              <div>
                <label className="text-sm font-medium">Provider</label>
                <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="custom" />
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
        {agents.map((agent) => (
          <Card key={agent.id}>
            <CardContent className="flex items-center justify-between py-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{agent.name}</span>
                  <Badge variant="outline">{agent.provider}</Badge>
                  <Badge variant={agent.status === "active" ? "success" : "secondary"}>
                    {agent.status}
                  </Badge>
                </div>
                {agent.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{agent.description}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  Created: {new Date(agent.createdAt).toLocaleDateString()}
                  {agent.lastHeartbeat && ` | Last seen: ${new Date(agent.lastHeartbeat).toLocaleString()}`}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(agent.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </CardContent>
          </Card>
        ))}
        {agents.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No agents registered yet.</p>
        )}
      </div>
    </div>
  );
}
