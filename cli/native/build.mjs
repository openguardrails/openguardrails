// Builds libogr-observe for this Linux machine. Elsewhere there is nothing to build: macOS reports
// through Seatbelt, and Windows is not supported yet.
import { execFileSync } from "node:child_process";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

if (platform !== "linux") process.exit(0);
const here = fileURLToPath(new URL(".", import.meta.url));
const flags = ["-O2", "-Wall", "-Wextra", "-Werror"];
const cc = process.env.CC ?? "cc";
for (const [source, out, extra] of [
  ["observe.c", `libogr-observe-linux-${arch}.so`, ["-shared", "-fPIC", "-ldl"]],
  ["join.c", `ogr-join-linux-${arch}`, []],
]) {
  execFileSync(cc, [...flags, "-o", `${here}${out}`, `${here}${source}`, ...extra], { stdio: "inherit" });
  console.log(`built ${here}${out}`);
}
