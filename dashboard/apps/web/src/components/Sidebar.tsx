import { NavLink } from "react-router-dom";
import { Bot, Fingerprint, Zap, AlertTriangle, GitFork } from "lucide-react";
import type { ReactNode } from "react";

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Discovery",
    items: [
      { label: "AI Agents", to: "/inventory/agents", icon: <Bot size={16} /> },
      { label: "Identities", to: "/inventory/identities", icon: <Fingerprint size={16} /> },
      { label: "Permissions", to: "/inventory/permissions", icon: <Zap size={16} /> },
    ],
  },
  {
    title: "Secure",
    items: [
      { label: "Risk", to: "/secure/risk", icon: <AlertTriangle size={16} /> },
      { label: "Graph", to: "/secure/graph", icon: <GitFork size={16} /> },
    ],
  },
];

export function Sidebar() {
  return (
    <nav className="nav">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="nav-group">
          <div className="nav-label">{group.title}</div>
          <div className="nav-group__items">
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `nav-item${isActive ? " active" : ""}`
                }
              >
                <span className="nav-item__icon">{item.icon}</span>
                <span className="nav-item__text">{item.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
