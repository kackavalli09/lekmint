import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { setAuthTokenGetter } from '@workspace/api-client-react';

interface AuthContextType {
  token: string | null;
  login: (key: string) => void;
  logout: () => void;
  isReady: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem('admin_key');
    if (stored) {
      setToken(stored);
    }
    setAuthTokenGetter(() => sessionStorage.getItem('admin_key'));
    setIsReady(true);
  }, []);

  const login = useCallback((key: string) => {
    sessionStorage.setItem('admin_key', key);
    setToken(key);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem('admin_key');
    setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, login, logout, isReady }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
