import { NavLink } from "react-router-dom";
import { Home, Bot, Activity, Shield, Key, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Overview", to: "/overview", icon: <Home size={18} /> },
  { label: "Agents", to: "/agents", icon: <Bot size={18} /> },
  { label: "Activity", to: "/activity", icon: <Activity size={18} /> },
  { label: "Security", to: "/security", icon: <Shield size={18} /> },
  { label: "Gateway", to: "/gateway", icon: <ShieldCheck size={18} /> },
  { label: "Secrets", to: "/secrets", icon: <Key size={18} /> },
  { label: "Settings", to: "/settings", icon: <Settings size={18} /> },
];

export function Sidebar() {
  return (
    <nav className="nav">
      <div className="nav-items">
        {NAV_ITEMS.map((item) => (
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
    </nav>
  );
}
