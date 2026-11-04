import assert from "node:assert/strict";
import { test } from "node:test";
import { absorb, isSensitive, SENSITIVE, writePlace } from "../src/ui.js";

const fresh = () => ({ id: "r", label: "r", mode: "", started: 0, last: 0, ended: null, counts: {}, hosts: new Map(), writes: new Map(), execs: new Map(), sensitive: [], tools: [], refused: [], alerts: [] });

test("the files worth a look are keys, cookies and credentials, not ordinary work", () => {
  for (const path of ["/data/voicego/secrets/youtube-cookies.txt", "/home/me/.ssh/id_ed25519", "/w/.env", "/w/.env.local", "/home/me/.netrc", "/w/server.pem"]) assert.ok(SENSITIVE.test(path), path);
  for (const path of ["/data/voicego/episodes/ep1/dub/translation.json", "/home/me/.cache/x", "/w/environment.md", "/v/logs/mosstts_dl_MOSS-Audio-Tokenizer.log", "/v/run_stepaudio2_dit_token2wav.sh"]) assert.ok(!SENSITIVE.test(path), path);
  for (const path of ["/v/secrets/api.json", "/v/youtube-cookies.txt", "/home/me/.config/x/token.json"]) assert.ok(isSensitive(path), path);
  for (const path of ["/s/searx/botdetection/link_token.py", "/a/secure_secret_store.py"]) assert.ok(!isSensitive(path), path);
});

test("writes are counted by directory, so a tree of segments is one line", () => {
  assert.equal(writePlace("/mnt/data/voicego/work/ep1/clips/seg-0001.wav"), "/mnt/data/voicego/work");
  assert.equal(writePlace("/tmp/x"), "/tmp");
  assert.equal(writePlace("/tmp/claude/tmph73l_wcg/a.py"), "/tmp/claude");
});

test("a run's record becomes destinations, refusals, secrets read and alerts", () => {
  const run = fresh();
  for (const event of [
    { t: 1, type: "start", command: "sandbox voicego", mode: "observe" },
    { t: 2, type: "connect", host: "www.youtube.com", port: 443, allowed: true },
    { t: 3, type: "request", method: "CONNECT", host: "www.youtube.com", port: 443, bytes_down: 2_000_000, via: "upstream" },
    { t: 4, type: "connect", host: "127.0.0.1", port: 4180, inside: 18080, allowed: true, via: "bridge" },
    { t: 5, type: "connect", host: "creator.xiaohongshu.com", port: 443, allowed: false },
    { t: 6, type: "file", action: "read", path: "/data/voicego/secrets/youtube-cookies.txt", process: "yt-dlp" },
    { t: 7, type: "file", action: "write", path: "/data/voicego/work/ep1/a.wav", process: "python3" },
    { t: 8, type: "file", action: "exec", path: "/usr/bin/ffmpeg", process: "python3" },
    { t: 9, type: "broker", tool: "systemctl", args: ["--user", "restart", "sshd"], refused: "sshd is not one of this sandbox's units" },
    { t: 10, type: "stalled", rule: "translating gets stuck", idle_ms: 1_800_000 },
  ]) absorb(run as never, event);
  assert.equal(run.label, "sandbox voicego");
  assert.deepEqual([...run.hosts.keys()].sort(), ["creator.xiaohongshu.com", "local :18080", "www.youtube.com"]);
  assert.equal(run.hosts.get("www.youtube.com")!.bytesDown, 2_000_000);
  assert.equal(run.hosts.get("creator.xiaohongshu.com")!.denied, 1);
  assert.equal(run.refused.length, 2);
  assert.equal(run.sensitive.length, 1);
  assert.equal(run.writes.get("/data/voicego/work/ep1")!.count, 1);
  assert.equal(run.execs.get("/usr/bin/ffmpeg")!.count, 1);
  assert.equal(run.alerts.length, 1);
});
