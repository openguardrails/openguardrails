/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Target {
  kind: "http" | "shell";
  describe(): string;
  send(prompt: string): Promise<string>;
}

export function parseTarget(spec: string): Target {
  if (/^https?:\/\//i.test(spec)) return new HttpTarget(spec);
  if (spec.startsWith("cmd:")) return new ShellTarget(spec.slice(4));
  throw new Error(
    `Unrecognized --target: "${spec}". Use an http(s) URL or "cmd:<shell command>".`,
  );
}

class HttpTarget implements Target {
  kind = "http" as const;
  constructor(private readonly url: string) {}
  describe(): string {
    return `http:${this.url}`;
  }
  async send(prompt: string): Promise<string> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      throw new Error(`Target returned HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = (await res.json()) as Record<string, unknown>;
      const v = j.response ?? j.output ?? j.text ?? j.message ?? j.content;
      return typeof v === "string" ? v : JSON.stringify(j);
    }
    return await res.text();
  }
}

class ShellTarget implements Target {
  kind = "shell" as const;
  constructor(private readonly cmd: string) {}
  describe(): string {
    return `cmd:${this.cmd}`;
  }
  async send(prompt: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", this.cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0 && out.length === 0) {
      throw new Error(`Target command exited ${code}: ${err.slice(0, 200)}`);
    }
    return out;
  }
}
