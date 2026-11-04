// Builds libogr-observe for this Linux machine. Elsewhere there is nothing to build: macOS reports
// through Seatbelt, and Windows is not supported yet.
import { execFileSync } from "node:child_process";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

if (platform !== "linux") process.exit(0);
const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}libogr-observe-linux-${arch}.so`;
execFileSync(process.env.CC ?? "cc", ["-O2", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-o", out, `${here}observe.c`, "-ldl"], { stdio: "inherit" });
console.log(`built ${out}`);
