import { Link } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../lib/auth-context";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "") || "";

export function Topbar() {
  const { logout } = useAuth();

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link to="/" className="brand">
          <div className="brand-logo">
            <img src={`${BASE}/logo.svg`} alt="OpenGuardrails" />
          </div>
          <span className="brand-title">OpenGuardrails</span>
        </Link>
      </div>
      <div className="topbar-status">
        <div className="pill">
          <span className="statusDot ok" />
          <span>Online</span>
        </div>
        <ThemeToggle />
        <button className="btn btn--sm" onClick={logout}>
          Logout
        </button>
      </div>
    </header>
  );
}
