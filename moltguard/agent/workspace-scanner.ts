/**
 * Workspace MD File Scanner
 *
 * Scans OpenClaw workspace for all .md files and categorizes them:
 * - soul.md (agent personality)
 * - agent.md (agent configuration)
 * - memories/*.md (conversation memories)
 * - heartbeat.md (task scheduler)
 * - Other md files in workspace root
 */

import fs from "node:fs";
import path from "node:path";
import { openclawHome } from "./env.js";

export type FileType = "soul" | "agent" | "memory" | "task" | "skill" | "plugin" | "other";

export interface WorkspaceFile {
  path: string;        // Relative path from workspace
  absolutePath: string;
  content: string;
  type: FileType;
  sizeBytes: number;
}

/**
 * Get OpenClaw workspace directory
 */
function getWorkspaceDir(): string {
  return openclawHome;
}

/**
 * Categorize file by path
 */
function categorizeFile(relativePath: string): FileType {
  const lower = relativePath.toLowerCase();

  if (lower === "soul.md") return "soul";
  if (lower === "agent.md") return "agent";
  if (lower === "heartbeat.md") return "task";
  if (lower.startsWith("memories/") || lower.startsWith("memories\\")) return "memory";
  if (lower.startsWith("skills/") || lower.startsWith("skills\\")) return "skill";
  if (lower.startsWith("plugins/") || lower.startsWith("plugins\\")) return "plugin";

  return "other";
}

/**
 * Recursively find all .md files in a directory
 */
async function findMdFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, .git, dist, build directories
        if (["node_modules", ".git", "dist", "build", ".cache"].includes(entry.name)) {
          continue;
        }

        // Recursively scan subdirectories
        const subFiles = await findMdFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relativePath = path.relative(baseDir, fullPath);
        files.push(relativePath);
      }
    }
  } catch {
    // Ignore permission errors, etc.
  }

  return files;
}

/**
 * Read file content safely
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Scan workspace for all .md files
 */
export async function scanWorkspaceMdFiles(): Promise<WorkspaceFile[]> {
  const workspaceDir = getWorkspaceDir();
  const files: WorkspaceFile[] = [];

  // Find all .md files
  const mdFiles = await findMdFiles(workspaceDir, workspaceDir);

  // Read each file
  for (const relativePath of mdFiles) {
    const absolutePath = path.join(workspaceDir, relativePath);
    const content = await readFileSafe(absolutePath);

    if (content === null) continue; // Skip unreadable files

    const type = categorizeFile(relativePath);
    const sizeBytes = Buffer.byteLength(content, "utf-8");

    files.push({
      path: relativePath,
      absolutePath,
      content,
      type,
      sizeBytes,
    });
  }

  return files;
}

/**
 * Scan specific file types
 */
export async function scanFilesByType(types: FileType[]): Promise<WorkspaceFile[]> {
  const allFiles = await scanWorkspaceMdFiles();
  return allFiles.filter(f => types.includes(f.type));
}

/**
 * Get summary of workspace files
 */
export async function getWorkspaceSummary(): Promise<{
  totalFiles: number;
  byType: Record<FileType, number>;
  totalSizeBytes: number;
}> {
  const files = await scanWorkspaceMdFiles();

  const byType: Record<FileType, number> = {
    soul: 0,
    agent: 0,
    memory: 0,
    task: 0,
    skill: 0,
    plugin: 0,
    other: 0,
  };

  let totalSizeBytes = 0;

  for (const file of files) {
    byType[file.type]++;
    totalSizeBytes += file.sizeBytes;
  }

  return {
    totalFiles: files.length,
    byType,
    totalSizeBytes,
  };
}
