/**
 * Strict bash-subset command parser for the Layer-1 gate.
 *
 * Philosophy: this parser only needs to be CONFIDENT, never complete. It fully
 * tokenizes the plain-command subset of shell (words, quotes, pipes, `;`,
 * `&&`/`||`, redirects) and BAILS — returns null — on anything richer:
 * substitutions, expansions in command position, heredocs, escapes it cannot
 * prove inert. A null parse means the gate answers `ask` (the model judges);
 * only a fully-understood command line can ever be auto-allowed. That makes
 * the tokenizer exactly as safe as a full AST for the allow path — an AST
 * (tree-sitter, per docs/automode-v6.md) can later slot in behind the same
 * interface to widen confident coverage, not to fix safety.
 */

export interface SimpleCommand {
  /** argv[0] as written (after quote stripping; never from an expansion). */
  name: string;
  args: string[];
}

export interface CommandAnalysis {
  commands: SimpleCommand[];
  /** true when any command's output is redirected into a file (`>`, `>>`). */
  writesFile: boolean;
  /** true when stdin redirect reads a file (`<`) — still read-only. */
  readsFile: boolean;
  /** true when any argument holds a `$` expansion, whose value this parser cannot know. */
  hasExpansion: boolean;
}

/** Constructs that force an immediate bail (→ ask). Checked on the RAW string
 * so quoting tricks cannot hide them from the tokenizer's happy path. */
const BAIL_RAW = [
  "$(", "`", "${", "<(", ">(", "<<", // substitution / process-sub / heredoc
  "\\\n", // line continuation
];

const OPERATORS = new Set(["|", ";", "&&", "||", "&"]);

/** Shell reserved words in command position = control flow the tokenizer does
 * not model → bail. */
const RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "function", "select", "in",
]);

/**
 * Tokenize one command line. Returns null (bail) when the line contains any
 * construct outside the confident subset.
 */
export function analyzeCommand(raw: string): CommandAnalysis | null {
  const line = raw.trim();
  if (line.length === 0 || line.length > 8192) return null;
  for (const b of BAIL_RAW) if (line.includes(b)) return null;

  const tokens: string[] = [];
  let i = 0;
  let cur = "";
  let curHadExpansion = false;
  const tokenMeta: boolean[] = []; // per token: contained $-expansion
  const push = () => {
    if (cur.length > 0 || curHadExpansion) {
      tokens.push(cur);
      tokenMeta.push(curHadExpansion);
      cur = "";
      curHadExpansion = false;
    }
  };

  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      // double quotes: allow only if content has no $ or backslash (no expansion)
      const end = line.indexOf('"', i + 1);
      if (end === -1) return null;
      const body = line.slice(i + 1, end);
      if (body.includes("$") || body.includes("\\") || body.includes("`")) return null;
      cur += body;
      i = end + 1;
      continue;
    }
    if (c === "\\") {
      // escaped char outside quotes: keep it literal only for space/safe chars
      const n = line[i + 1];
      if (n === undefined) return null;
      if (!/[ \t\\'"./:@=+-]/.test(n)) return null;
      cur += n;
      i += 2;
      continue;
    }
    if (c === "$") {
      // unquoted expansion: tolerate INSIDE an argument word (value unknown →
      // the word is marked; command names with expansions bail below)
      curHadExpansion = true;
      i += 1;
      // swallow the variable-ish tail so `$FOO/bar` stays one token
      while (i < line.length && /[A-Za-z0-9_{}]/.test(line[i]!)) i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      i += 1;
      continue;
    }
    if (c === "&" || c === "|" || c === ";") {
      push();
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        tokens.push(two);
        tokenMeta.push(false);
        i += 2;
      } else {
        tokens.push(c);
        tokenMeta.push(false);
        i += 1;
      }
      continue;
    }
    if (c === "<" || c === ">") {
      push();
      const two = line.slice(i, i + 2);
      if (two === ">>") {
        tokens.push(">>");
        tokenMeta.push(false);
        i += 2;
      } else {
        tokens.push(c);
        tokenMeta.push(false);
        i += 1;
      }
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}" || c === "\n") return null;
    cur += c;
    i += 1;
  }
  push();
  if (tokens.length === 0) return null;

  // ---- group into simple commands over operators, tracking redirects
  const commands: SimpleCommand[] = [];
  let writesFile = false;
  let readsFile = false;
  const hasExpansion = tokenMeta.some(Boolean);
  let argv: string[] = [];
  let argvExp: boolean[] = [];
  let expectRedirectTarget: ">" | ">>" | "<" | null = null;

  const flush = (): boolean => {
    if (argv.length === 0) return true;
    if (argvExp[0]) return false; // expansion in command position → bail
    if (RESERVED.has(argv[0]!)) return false; // control flow → not a plain command list
    commands.push({ name: argv[0]!, args: argv.slice(1) });
    argv = [];
    argvExp = [];
    return true;
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    const exp = tokenMeta[t]!;
    if (expectRedirectTarget) {
      if (OPERATORS.has(tok) || tok === ">" || tok === ">>" || tok === "<") return null;
      if (expectRedirectTarget === "<") readsFile = true;
      else {
        // /dev/null is not a file write we care about
        if (tok !== "/dev/null") writesFile = true;
      }
      expectRedirectTarget = null;
      continue;
    }
    if (tok === ">" || tok === ">>" || tok === "<") {
      expectRedirectTarget = tok;
      continue;
    }
    if (OPERATORS.has(tok)) {
      if (tok === "&") return null; // backgrounding → ask
      if (!flush()) return null;
      continue;
    }
    // stderr merge `2>&1` style arrives as word "2" + ">" — the "2" lands as an
    // arg; harmless. `&1` cannot appear (operator & bails above via redirect path).
    argv.push(tok);
    argvExp.push(exp);
  }
  if (expectRedirectTarget) return null;
  if (!flush()) return null;
  if (commands.length === 0) return null;
  return { commands, writesFile, readsFile, hasExpansion };
}
