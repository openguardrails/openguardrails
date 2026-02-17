import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import {
  api,
  type AgentCapability,
  type AgentProfile,
  type AgentSkill,
} from "../lib/api";

// ---- Helpers ----

const formatDate = (iso: string | null) => {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
};

// ---- SOUL.md Parser ----

interface SoulData {
  headline: string;
  coreTruths: string[];
  boundaries: string[];
  vibe: string;
  continuity: string[];
  raw: string;
}

function parseSoulMd(content: string): SoulData {
  const result: SoulData = { headline: "", coreTruths: [], boundaries: [], vibe: "", continuity: [], raw: content };
  if (!content) return result;

  let currentSection = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      const heading = headerMatch[1].toLowerCase();
      if (heading.includes("core truth")) currentSection = "truths";
      else if (heading.includes("boundar")) currentSection = "boundaries";
      else if (heading.includes("vibe")) currentSection = "vibe";
      else if (heading.includes("continuity")) currentSection = "continuity";
      else currentSection = "";
      continue;
    }

    const bullet = trimmed.replace(/^[-*]\s+/, "");
    if (!bullet || bullet === trimmed.replace(/\s/g, "")) continue;

    if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      if (currentSection === "truths") result.coreTruths.push(bullet);
      else if (currentSection === "boundaries") result.boundaries.push(bullet);
      else if (currentSection === "continuity") result.continuity.push(bullet);
    }

    if (currentSection === "vibe" && trimmed && !trimmed.startsWith("#")) {
      if (!result.vibe) result.vibe = trimmed;
      else result.vibe += " " + trimmed;
    }
  }

  return result;
}

// ---- USER.md Parser ----

interface UserData {
  name: string;
  timezone: string;
  context: string[];
  raw: string;
}

function parseUserMd(content: string): UserData {
  const result: UserData = { name: "", timezone: "", context: [], raw: content };
  if (!content) return result;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Handle "- **Name:** value" (bullet + bold markdown)
    const nameMatch = trimmed.match(/^[-*]?\s*\*\*name:\*\*\s*(.*)/i)
      || trimmed.match(/^\*?\*?name\*?\*?:\s*(.*)/i);
    if (nameMatch && !result.name) {
      const val = nameMatch[1].replace(/^\*?\*?\s*/, "").trim();
      if (val) { result.name = val; continue; }
    }
    const tzMatch = trimmed.match(/^[-*]?\s*\*\*timezone:\*\*\s*(.*)/i)
      || trimmed.match(/^\*?\*?timezone\*?\*?:\s*(.*)/i);
    if (tzMatch && !result.timezone) {
      const val = tzMatch[1].replace(/^\*?\*?\s*/, "").trim();
      if (val) { result.timezone = val; continue; }
    }
    if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      const bullet = trimmed.replace(/^[-*]\s+/, "").trim();
      if (bullet && !/^-+$/.test(bullet)) result.context.push(bullet);
    }
  }

  return result;
}

// ---- Skill Categories ----

const SKILL_CATEGORIES: Record<string, string[]> = {
  "Communication": ["discord", "slack", "wacli", "imsg", "bluebubbles", "voice-call", "himalaya", "email"],
  "Media & Audio": ["camsnap", "gifgrep", "nano-banana-pro", "video-frames", "openai-image-gen", "image-gen", "screenshot", "webcam", "media"],
  "Development": ["github", "coding-agent", "mcporter", "oracle", "git", "npm", "code"],
  "Productivity": ["apple-notes", "bear-notes", "notion", "obsidian", "things-mac", "trello", "todoist", "calendar", "reminders", "notes"],
  "Music": ["spotify-player", "sonoscli", "blucli", "music", "audio"],
  "Smart Home": ["openhue", "eightctl", "homekit", "hue"],
  "Security": ["moltguard", "healthcheck", "guard", "monitor"],
  "Web & Search": ["web-search", "browser", "fetch", "scrape", "search"],
  "Files & Storage": ["file-manager", "dropbox", "gdrive", "icloud", "files"],
  "AI & Models": ["openai", "anthropic", "gemini", "llm", "model", "ai"],
};

function categorizeSkill(name: string): string {
  const lower = name.toLowerCase();
  for (const [category, keywords] of Object.entries(SKILL_CATEGORIES)) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "Other";
}

function groupSkillsByCategory(skills: AgentSkill[]): Record<string, AgentSkill[]> {
  const groups: Record<string, AgentSkill[]> = {};
  for (const skill of skills) {
    const cat = categorizeSkill(skill.name);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(skill);
  }
  const sorted: Record<string, AgentSkill[]> = {};
  const keys = Object.keys(groups).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
  for (const k of keys) sorted[k] = groups[k];
  return sorted;
}

// ---- Tabs ----

type TopTab = "profile" | "tasks" | "identities" | "capabilities";

// ---- Components ----

function RawFileViewer({ title, content }: { title: string; content: string }) {
  const [open, setOpen] = useState(false);
  if (!content) return null;

  return (
    <div className="raw-file-viewer">
      <button className="raw-file-viewer__header" onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className="raw-file-viewer__chevron">{open ? "\u25BC" : "\u25B6"}</span>
      </button>
      {open && (
        <div className="raw-file-viewer__content">
          <pre>{content}</pre>
        </div>
      )}
    </div>
  );
}

// ---- Main Component ----

export function AgentProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TopTab>("profile");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      api.getAgentProfile(id),
      api.getAgentCapabilities(id),
    ]).then(([profileRes, capRes]) => {
      if (profileRes.success) setProfile(profileRes.data);
      if (capRes.success) setCapabilities(capRes.data);
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return (
      <div className="card">
        <div className="card-sub">Loading agent profile...</div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="card">
        <div className="card-title">Agent not found</div>
        <div className="card-sub">
          <Link to="/discovery/agents">Back to agents</Link>
        </div>
      </div>
    );
  }

  const soulData = parseSoulMd(profile.workspaceFiles.soul);
  const userData = parseUserMd(profile.workspaceFiles.user);
  const skillGroups = groupSkillsByCategory(profile.allSkills);
  const headline = [profile.creature, profile.vibe].filter(Boolean).join(" \u2014 ");

  const tabs: { key: TopTab; label: string }[] = [
    { key: "profile", label: "Profile" },
    { key: "tasks", label: "Bot Tasks" },
    { key: "identities", label: "Identities" },
    { key: "capabilities", label: "Capabilities" },
  ];

  return (
    <>
      <Link to="/discovery/agents" className="profile-back">
        &larr; Back to Agents
      </Link>

      <div className="profile-waterfall">
        {/* Cover banner + Hero */}
        <div className="profile-hero-cover" />
        <div className="profile-hero">
          <div className="profile-hero__avatar">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt={profile.name} className="profile-hero__avatar-img" />
            ) : (
              profile.emoji
            )}
          </div>
          <div className="profile-hero__info">
            <h1 className="profile-hero__name">{profile.name}</h1>
            {headline && (
              <div className="profile-hero__creature">{headline}</div>
            )}
            {profile.channels.length > 0 && (
              <div className="profile-hero__channels">
                {profile.channels.map((ch) => (
                  <span key={ch} className="channel-pill">{ch}</span>
                ))}
              </div>
            )}
            <div className="profile-hero__model">
              <span className="mono">{profile.provider} / {profile.model}</span>
            </div>
            {(profile.ownerName || userData.timezone) && (
              <div className="profile-hero__owner">
                {profile.ownerName && (
                  <>
                    <span className="profile-hero__owner-label">Owner</span>
                    <span className="profile-hero__owner-name">{profile.ownerName}</span>
                  </>
                )}
                {userData.timezone && (
                  <span className="profile-hero__owner-tz">{userData.timezone}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="profile-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`profile-tab${activeTab === tab.key ? " profile-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "profile" && (
          <div className="profile-tab-content">
            <ProfileView
              profile={profile}
              soulData={soulData}
              userData={userData}
              skillGroups={skillGroups}
            />
          </div>
        )}

        {activeTab === "tasks" && (
          <BotTasksView profile={profile} />
        )}

        {activeTab === "identities" && (
          <IdentitiesView profile={profile} />
        )}

        {activeTab === "capabilities" && (
          <CapabilitiesView capabilities={capabilities} formatDate={formatDate} />
        )}
      </div>
    </>
  );
}

// ---- Profile Tab (unified) ----

function ProfileView({
  profile,
  soulData,
  userData,
  skillGroups,
}: {
  profile: AgentProfile;
  soulData: SoulData;
  userData: UserData;
  skillGroups: Record<string, AgentSkill[]>;
}) {
  return (
    <div className="profile-view">
      {/* About */}
      {(soulData.coreTruths.length > 0 || soulData.vibe || soulData.boundaries.length > 0) && (
        <div className="profile-section persona-about">
          <div className="profile-section__title">About</div>
          {soulData.vibe && (
            <div className="persona-headline">{soulData.vibe}</div>
          )}
          {soulData.coreTruths.length > 0 && (
            <div className="persona-section">
              <div className="persona-section__label">Core Traits</div>
              <div className="persona-traits">
                {soulData.coreTruths.map((trait, i) => (
                  <span key={i} className="persona-trait-pill">{trait}</span>
                ))}
              </div>
            </div>
          )}
          {soulData.boundaries.length > 0 && (
            <div className="persona-section">
              <div className="persona-section__label">Boundaries</div>
              <ul className="persona-boundaries">
                {soulData.boundaries.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          {soulData.continuity.length > 0 && (
            <div className="persona-section">
              <div className="persona-section__label">Continuity</div>
              <ul className="persona-boundaries">
                {soulData.continuity.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Owner */}
      {userData.raw && (
        <div className="profile-section persona-about">
          <div className="profile-section__title">Owner</div>
          {userData.name && (
            <div className="persona-headline">{userData.name}</div>
          )}
          {userData.timezone && (
            <div className="persona-section">
              <div className="persona-section__label">Timezone</div>
              <span className="pill">{userData.timezone}</span>
            </div>
          )}
          {userData.context.length > 0 && (
            <div className="persona-section">
              <div className="persona-section__label">Context</div>
              <ul className="persona-boundaries">
                {userData.context.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Possessed Ability */}
      {(profile.allSkills.length > 0 || profile.plugins.length > 0 || profile.bundledExtensions.length > 0) && (
        <div className="profile-section">
          <div className="profile-section__title">
            Possessed Ability
            <span className="profile-section__subtitle">Configured skills and plugins</span>
          </div>

          {/* Skills */}
          {profile.allSkills.length > 0 && (
            <div className="possessed-subsection">
              <div className="possessed-subsection__label">
                Skills
                <span className="profile-section__count">{profile.allSkills.length}</span>
              </div>
              <div className="possessed-hierarchy-hint">workspace &gt; bundled</div>
              {Object.entries(skillGroups).map(([category, skills]) => (
                <div key={category} className="skill-category">
                  <div className="skill-category__label">{category}</div>
                  <div className="skill-grid">
                    {skills.map((skill) => (
                      <span
                        key={`${skill.source}-${skill.name}`}
                        className={`skill-card${skill.source === "workspace" ? " skill-card--workspace" : ""}`}
                        data-tip={skill.description || ""}
                      >
                        {skill.emoji && <span className="skill-card__emoji">{skill.emoji}</span>}
                        <span className="skill-card__name">{skill.name}</span>
                        <span className="skill-card__badge">
                          {skill.source === "workspace" ? "workspace" : "bundled"}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Configured Plugins */}
          {profile.plugins.length > 0 && (
            <div className="possessed-subsection">
              <div className="possessed-subsection__label">
                Configured Plugins
                <span className="profile-section__count">{profile.plugins.length}</span>
              </div>
              <div className="profile-section__grid">
                {profile.plugins.map((plugin) => {
                  const ext = profile.bundledExtensions.find((e) => e.name === plugin.name);
                  return (
                    <div key={plugin.name} className="list-item" data-tip={ext?.description || ""}>
                      <div><div className="list-title">{plugin.name}</div></div>
                      <div className="list-meta">
                        <span className={`chip ${plugin.enabled ? "ok" : "warn"}`}>
                          {plugin.enabled ? "Active" : "Disabled"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bundled Extensions */}
          {profile.bundledExtensions.length > 0 && (
            <div className="possessed-subsection">
              <div className="possessed-subsection__label">
                Bundled Extensions
                <span className="profile-section__count">{profile.bundledExtensions.length}</span>
              </div>
              <div className="skill-grid">
                {profile.bundledExtensions.map((ext) => (
                  <span key={ext.name} className="skill-card" data-tip={ext.description || ""}>
                    <span className="skill-card__name">{ext.name}</span>
                    <span className="skill-card__badge">bundled</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Raw Data Files */}
      <div className="profile-section">
        <div className="profile-section__title">Raw Data Files</div>
        <div className="raw-files-list">
          <RawFileViewer title="SOUL.md" content={profile.workspaceFiles.soul} />
          <RawFileViewer title="IDENTITY.md" content={profile.workspaceFiles.identity} />
          <RawFileViewer title="USER.md" content={profile.workspaceFiles.user} />
          <RawFileViewer title="AGENTS.md" content={profile.workspaceFiles.agents} />
          <RawFileViewer title="TOOLS.md" content={profile.workspaceFiles.tools} />
          <RawFileViewer title="HEARTBEAT.md" content={profile.workspaceFiles.heartbeat} />
        </div>
      </div>
    </div>
  );
}

// ---- Bot Tasks Tab ----

function BotTasksView({ profile }: { profile: AgentProfile }) {
  const hasHeartbeat = !!profile.workspaceFiles.heartbeat;
  const hasCron = profile.cronJobs.length > 0;
  const hasAny = hasHeartbeat || hasCron;

  if (!hasAny) {
    return (
      <div className="profile-section">
        <div className="profile-section__title">Bot Tasks</div>
        <div className="profile-summary__empty">
          No heartbeat or scheduled jobs configured.
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-view">
      {hasHeartbeat && (
        <div className="profile-section">
          <div className="profile-section__title">Heartbeat</div>
          <div className="profile-summary__content">
            {profile.workspaceFiles.heartbeat.replace(/^#\s*HEARTBEAT\.md\s*\n*/i, "").trim()}
          </div>
        </div>
      )}

      {hasCron && (
        <div className="profile-section">
          <div className="profile-section__title">Scheduled Jobs</div>
          <div className="profile-section__list">
            {profile.cronJobs.map((job: any, i) => (
              <div key={job.id || i} className="profile-section__list-item">
                <span>{job.name || job.task || job.id || `Job ${i + 1}`}</span>
                {job.schedule && (
                  <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>
                    {typeof job.schedule === "string" ? job.schedule : job.schedule.expr || JSON.stringify(job.schedule)}
                  </span>
                )}
                {job.enabled !== undefined && (
                  <span className={`chip ${job.enabled ? "ok" : "warn"}`}>
                    {job.enabled ? "Active" : "Disabled"}
                  </span>
                )}
                {job.payload?.text && (
                  <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
                    {job.payload.text}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

// ---- Identities Tab ----

function IdentitiesView({ profile }: { profile: AgentProfile }) {
  return (
    <div className="identities-view">
      <div className="profile-section">
        <div className="profile-section__title">Identities</div>
        <div className="profile-summary__empty">
          No identity data available.
        </div>
      </div>
    </div>
  );
}

// ---- Capabilities Tab ----

function CapabilitiesView({
  capabilities,
  formatDate,
}: {
  capabilities: AgentCapability[];
  formatDate: (iso: string | null) => string;
}) {
  if (capabilities.length === 0) {
    return (
      <div className="profile-section">
        <div className="profile-section__title">Capabilities</div>
        <div className="profile-summary__empty">
          No capabilities observed yet.
        </div>
      </div>
    );
  }

  return (
    <div className="profile-section">
      <div className="profile-section__title">
        Capabilities
        <span className="profile-section__subtitle">Proven — observed runtime tool usage</span>
      </div>
      <div className="cap-table-wrap">
        <table className="cap-table">
          <thead>
            <tr>
              <th />
              <th className="cap-th">Tool</th>
              <th className="cap-th">Category</th>
              <th className="cap-th">Access</th>
              <th className="cap-th">Calls</th>
              <th className="cap-th">Targets</th>
              <th className="cap-th">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.map((cap) => {
              const isNew = cap.callCount === 1;
              const targets = cap.targetsJson || [];
              return (
                <tr key={cap.id} className="cap-row">
                  <td className="cap-td" style={{ width: 28 }}>
                    {isNew && <span className="anomaly-dot" title="First-seen tool" />}
                  </td>
                  <td className="cap-td">
                    <span className="mono">{cap.toolName}</span>
                  </td>
                  <td className="cap-td">
                    <span className="chip">{cap.category || "unknown"}</span>
                  </td>
                  <td className="cap-td">
                    <span className={`access-pill ${cap.accessPattern}`}>
                      {cap.accessPattern || "unknown"}
                    </span>
                  </td>
                  <td className="cap-td cap-td--num">{cap.callCount}</td>
                  <td className="cap-td">
                    {targets.length > 0 ? (
                      <span className="cap-targets">
                        {targets.slice(0, 3).map((t) => (
                          <span key={t} className="chip">{t}</span>
                        ))}
                        {targets.length > 3 && (
                          <span className="chip" style={{ borderStyle: "dashed", color: "var(--muted)" }}>
                            +{targets.length - 3}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>&mdash;</span>
                    )}
                  </td>
                  <td className="cap-td cap-td--date">{formatDate(cap.lastSeen)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
