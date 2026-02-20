import { useState, useEffect, useRef, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth-context";

export function LoginPage() {
  const { authenticated, login } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const autoLoginAttempted = useRef(false);

  // Auto-login from URL params (e.g. linked from Core portal)
  useEffect(() => {
    if (autoLoginAttempted.current || authenticated) return;
    const paramEmail = searchParams.get("email");
    const paramKey = searchParams.get("apiKey");
    if (paramEmail && paramKey) {
      autoLoginAttempted.current = true;
      // Clear params from URL immediately
      setSearchParams({}, { replace: true });
      setLoading(true);
      login(paramKey, paramEmail).then((res) => {
        setLoading(false);
        if (!res.success) {
          setEmail(paramEmail);
          setError(res.error || "Auto-login failed. Please sign in manually.");
        }
      });
    }
  }, [searchParams, setSearchParams, authenticated, login]);

  if (authenticated) {
    return <Navigate to="/inventory/agents" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmedKey = apiKey.trim();
    const trimmedEmail = email.trim();
    if (!trimmedKey || !trimmedEmail) return;
    setLoading(true);
    setError("");
    const res = await login(trimmedKey, trimmedEmail);
    setLoading(false);
    if (!res.success) {
      setError(res.error || "Login failed. Check your email and API key.");
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__logo">
          <img src="/logo.svg" alt="OpenGuardrails" />
        </div>
        <h1 className="login-card__title">OpenGuardrails</h1>
        <p className="login-card__sub">Sign in with your email and API key</p>

        {loading && !email && !apiKey ? (
          <p className="login-card__sub">Signing in...</p>
        ) : (
          <form className="login-card__form" onSubmit={handleSubmit}>
            <input
              className="login-card__input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              autoComplete="email"
              required
            />
            <input
              className="login-card__input"
              type="text"
              placeholder="sk-og-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
            {error && <div className="login-card__error">{error}</div>}
            <button
              className="login-card__button"
              type="submit"
              disabled={loading || !apiKey.trim() || !email.trim()}
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        )}

        <p className="login-card__hint">
          Get your API key by running <code>/og_activate</code> in OpenClaw,
          then completing the activation email.
        </p>
      </div>
    </div>
  );
}
