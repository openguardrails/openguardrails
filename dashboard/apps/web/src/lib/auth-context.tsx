import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

const API_KEY_STORAGE = "og_api_key";
const API_BASE =
  typeof import.meta.env.BASE_URL === "string" && import.meta.env.BASE_URL !== "/"
    ? import.meta.env.BASE_URL.replace(/\/$/, "")
    : "";

export function getStoredApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE);
}
function setStoredApiKey(key: string) {
  localStorage.setItem(API_KEY_STORAGE, key);
}
function clearStoredApiKey() {
  localStorage.removeItem(API_KEY_STORAGE);
}

export interface AgentSummary {
  agentId: string;
  name: string;
  apiKeyMasked: string;
  status: string;
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
}

export interface AccountInfo {
  email: string;
  agentId: string;
  name: string;
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
  agents: AgentSummary[];
}

interface AuthState {
  authenticated: boolean;
  account: AccountInfo | null;
  loading: boolean;
  login: (apiKey: string, email?: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  authenticated: false,
  account: null,
  loading: true,
  login: async () => ({ success: false }),
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const key = getStoredApiKey();
    if (!key) {
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${key}` } })
      .then((r) => r.json())
      .then((data: { success: boolean } & Partial<AccountInfo>) => {
        if (data.success && data.email) {
          setAuthenticated(true);
          setAccount({
            email: data.email,
            agentId: data.agentId ?? "",
            name: data.name ?? "",
            quotaTotal: data.quotaTotal ?? 0,
            quotaUsed: data.quotaUsed ?? 0,
            quotaRemaining: data.quotaRemaining ?? 0,
            agents: data.agents ?? [],
          });
        } else {
          clearStoredApiKey();
        }
      })
      .catch(() => clearStoredApiKey())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (apiKey: string, email?: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, email }),
      });
      const data: { success: boolean; error?: string } & Partial<AccountInfo> = await res.json();

      if (data.success && data.email) {
        setStoredApiKey(apiKey);
        setAuthenticated(true);
        setAccount({
          email: data.email,
          agentId: data.agentId ?? "",
          name: data.name ?? "",
          quotaTotal: data.quotaTotal ?? 0,
          quotaUsed: data.quotaUsed ?? 0,
          quotaRemaining: data.quotaRemaining ?? 0,
          agents: data.agents ?? [],
        });
        return { success: true };
      }
      return { success: false, error: data.error || "Login failed" };
    } catch {
      return { success: false, error: "Network error" };
    }
  }, []);

  const logout = useCallback(() => {
    clearStoredApiKey();
    setAuthenticated(false);
    setAccount(null);
    fetch(`${API_BASE}/api/auth/logout`, { method: "POST" }).catch(() => {});
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, account, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
