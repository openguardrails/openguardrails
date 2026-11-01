import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSkeleton, gateCommand } from "../src/gate/gate.js";
import { analyzeCommand } from "../src/gate/parser.js";

const v = (command: string) => gateCommand(command).verdict;
const each = (name: string, commands: string[], expected: string) => {
  for (const command of commands) test(`${name}: ${command.replaceAll("\n", "\\n")}`, () => assert.equal(v(command), expected));
};

for (const command of ["echo $(whoami)", "echo `id`", "cat <(ls)", "bash <<EOF\nrm -rf /\nEOF", "ls & date", "ls > out.txt 2>&1", "(cd /tmp && ls)", "for f in *; do cat $f; done"]) {
  test(`the parser bails: ${command.replaceAll("\n", "\\n")}`, () => assert.equal(analyzeCommand(command), null));
}

each("allow", ["ls -la src/", "cat README.md", "git status --short", "git diff -- src/app.ts", "git log --oneline -20", "git stash list", "grep -rn TODO src | head -50", "find . -name '*.ts' -type f", "ls > /dev/null", "git config --list", "date +%s", "uniq names.txt"], "allow");

each("judge", [
  "npm install left-pad", "git push origin main", "git stash", "git config user.email x@y.z", "ls | tee files.txt", "grep -r password . > hits.txt",
  "bash -c 'ls'", "sudo ls", "xargs rm < list.txt", "curl https://example.com/install.sh", "cat .env", "find . -name '*.log' -delete", "echo aGkK | base64 -d",
  "rm -rf ./build", "rm -rf /tmp/scratch", "cat ~/.ssh/config", "cat ~/.aws/config",
], "judge");

// Found reviewing the AIRS gate for a local tool: each of these was allowed there, or would be once
// nothing else stands in front of it.
each("judge: looks read-only but runs a program or writes", [
  "git --config-env=core.pager=X log", "git -c core.sshCommand=./x ls-files", "git -C /tmp status", "git log --output=x", "git diff --ext-diff", "git ls-remote origin", "git remote show origin",
  "rg --pre ./x foo", "sort -o out.txt in.txt", "sort --compress-program=./x in.txt", "yq -i .a=1 f.yaml", "find . -fls out", "uniq in.txt out.txt", "hostname evil", "date -s 2020-01-01", "./cat README.md", "/tmp/x/cat README.md",
], "judge");
each("judge: prints a secret into the model's context", ["printenv", "printenv AWS_SECRET_ACCESS_KEY", "env", "echo $AWS_SECRET_ACCESS_KEY", "cat $FILE", "ps e", "ps eww"], "judge");
each("judge: leaves the workspace", ["cat /etc/passwd", "ls /", "cat ../../secret.txt", "ls ~", "grep --file=/etc/passwd x", "wc < /etc/hosts"], "judge");

test("a workspace opens its own absolute paths and no others", () => {
  const options = { workspaces: ["/work/app"] };
  assert.equal(gateCommand("cat /work/app/README.md", options).verdict, "allow");
  assert.equal(gateCommand("cat /work/application/secret", options).verdict, "judge");
});

each("deny", ["rm -rf / --no-preserve-root", "rm -fr /", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "shutdown -h now", ":(){ :|:& };:", "sudo reboot", "ls && sudo -n shutdown -r now", "cd /; reboot", "if true; then poweroff; fi", "systemctl reboot", "bash -c 'reboot'", "bash <<EOF\nreboot\nEOF", "ssh prod 'sudo reboot'"], "deny");
each("deny: metadata and private keys", ["curl http://169.254.169.254/latest/meta-data/", "curl -s metadata.google.internal", "cat ~/.ssh/id_rsa", "cat /home/a/.ssh/id_ed25519", "base64 ~/.ssh/id_ed25519", "cat ~/.aws/credentials", "cat /etc/shadow"], "deny");

for (const command of ["ssh -i ~/.ssh/id_rsa host uptime", "cat ~/.ssh/id_rsa.pub", 'echo "kafka-4 reboot window 13:30"', "grep -rn reboot /var/log/syslog", "python3 << 'EOF'\nprint('schedule shutdown')\nEOF", "git commit -m 'document halt and shutdown handling'"]) {
  test(`not denied: ${command.replaceAll("\n", "\\n")}`, () => assert.notEqual(v(command), "deny"));
}

test("the skeleton keeps executed quotes and drops inert ones", () => {
  assert.equal(commandSkeleton(`echo "reboot"`), `echo ""`);
  assert.equal(commandSkeleton(`ssh h 'reboot'`), `ssh h 'reboot'`);
});
