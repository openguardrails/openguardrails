"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface DetectionResult {
  id: string;
  agentId: string | null;
  safe: boolean;
  categories: string[];
  sensitivityScore: number;
  findings: any[];
  latencyMs: number;
  requestId: string;
  createdAt: string;
}

export default function ResultsPage() {
  const [results, setResults] = useState<DetectionResult[]>([]);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  useEffect(() => {
    loadResults();
  }, [offset]);

  function loadResults() {
    api.listResults({ limit, offset }).then((res) => {
      if (res.success) setResults(res.data);
    });
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Detection Results</h1>
      <p className="text-muted-foreground">Recent detection history</p>

      <div className="mt-6 space-y-3">
        {results.map((result) => (
          <Card key={result.id}>
            <CardContent className="py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Badge variant={result.safe ? "success" : "destructive"}>
                    {result.safe ? "SAFE" : "UNSAFE"}
                  </Badge>
                  <span className="text-sm font-mono text-muted-foreground">
                    {result.requestId}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {new Date(result.createdAt).toLocaleString()}
                </span>
              </div>
              {!result.safe && (
                <div className="mt-2">
                  <div className="flex flex-wrap gap-1">
                    {result.categories.map((cat) => (
                      <Badge key={cat} variant="outline">{cat}</Badge>
                    ))}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Score: {result.sensitivityScore.toFixed(2)} | Latency: {result.latencyMs}ms
                    {result.agentId && ` | Agent: ${result.agentId.slice(0, 8)}...`}
                  </p>
                </div>
              )}
              {result.safe && (
                <p className="mt-1 text-sm text-muted-foreground">
                  Latency: {result.latencyMs}ms
                  {result.agentId && ` | Agent: ${result.agentId.slice(0, 8)}...`}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
        {results.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No detection results yet.</p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">Showing {offset + 1} - {offset + results.length}</span>
        <Button variant="outline" disabled={results.length < limit} onClick={() => setOffset(offset + limit)}>
          Next
        </Button>
      </div>
    </div>
  );
}
