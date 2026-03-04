import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

const SESSION_TOKEN_STORAGE = "og_session_token";

// API base: empty for dev mode (Vite proxy handles /api),
// or tunnel base path for production tunnel access
function getApiBase(): string {
  if (typeof document !== "undefined" && document.baseURI) {
    try {
      const base = new URL(document.baseURI);
      // Check if we're behind a tunnel (path contains more than just /dashboard)
      // e.g., /core/tunnel/abc123/dashboard -> tunnel base is /core/tunnel/abc123
      const match = base.pathname.match(/^(.*?)\/dashboard(?:\/|$)/);
      if (match && match[1]) {
        return match[1]; // Return tunnel base path
      }
    } catch {
      // Fallback
    }
  }
  return ""; // Dev mode: use relative /api paths (Vite proxy)
}

const API_BASE = getApiBase();

// Session token helpers
export function getSessionToken(): string | null {
  // First check URL param, then localStorage
  if (typeof window !== "undefined") {
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get("token");
    if (urlToken) {
      // Save to localStorage for subsequent requests
      localStorage.setItem(SESSION_TOKEN_STORAGE, urlToken);
      return urlToken;
    }
  }
  return localStorage.getItem(SESSION_TOKEN_STORAGE);
}

function setSessionToken(token: string) {
  localStorage.setItem(SESSION_TOKEN_STORAGE, token);
}

function clearSessionToken() {
  localStorage.removeItem(SESSION_TOKEN_STORAGE);
}

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  name: string;
  logout: () => void;
  checkSession: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  authenticated: false,
  loading: true,
  name: "",
  logout: () => {},
  checkSession: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");

  // Check session on mount
  const checkSession = useCallback(async () => {
    setLoading(true);
    try {
      const token = getSessionToken();
      if (!token) {
        setAuthenticated(false);
        setName("");
        setLoading(false);
        return;
      }

      const res = await fetch(`${API_BASE}/api/auth/me?token=${token}`, {
        credentials: "include",
      });
      const data = await res.json();

      if (data.success) {
        setAuthenticated(true);
        setSessionToken(token);
        setName(data.name ?? "Local Dashboard");
      } else {
        setAuthenticated(false);
        setName("");
        clearSessionToken();
      }
    } catch {
      setAuthenticated(false);
      setName("");
      clearSessionToken();
    } finally {
      setLoading(false);
    }
  }, []);

  // Restore session on mount
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const logout = useCallback(() => {
    clearSessionToken();
    setAuthenticated(false);
    setName("");
    fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, loading, name, logout, checkSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
