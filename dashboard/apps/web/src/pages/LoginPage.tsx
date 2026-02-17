import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth-context";

export function LoginPage() {
  const { authenticated, login } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // If already authenticated, redirect
  if (authenticated) {
    navigate("/discovery/agents", { replace: true });
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setError("");
    const res = await login(token.trim());
    setLoading(false);
    if (res.success) {
      navigate("/discovery/agents", { replace: true });
    } else {
      setError(res.error || "Invalid session token");
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__logo">
          <img src="/logo.svg" alt="OpenGuardrails" />
        </div>
        <h1 className="login-card__title">OpenGuardrails</h1>
        <p className="login-card__sub">Enter your session token to continue</p>
        <form className="login-card__form" onSubmit={handleSubmit}>
          <input
            className="login-card__input"
            type="password"
            placeholder="Session token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          {error && <div className="login-card__error">{error}</div>}
          <button
            className="login-card__button"
            type="submit"
            disabled={loading || !token.trim()}
          >
            {loading ? "Authenticating..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
