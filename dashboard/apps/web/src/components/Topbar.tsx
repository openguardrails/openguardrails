import { ThemeToggle } from "./ThemeToggle";
import { useAuth } from "../lib/auth-context";

export function Topbar() {
  const { logout } = useAuth();

  return (
    <header className="topbar">
      <div className="topbar-left">
        <a href="/" className="brand">
          <div className="brand-logo">
            <img src="/logo.svg" alt="OpenGuardrails" />
          </div>
          <span className="brand-title">OpenGuardrails</span>
        </a>
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
