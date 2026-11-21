import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, closeLiveConnection, setUnauthorizedHandler, syncClock } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = signed out

  useEffect(() => {
    api.me().then((r) => { syncClock(r.serverTime); setUser(r.user); }).catch(() => setUser(null));
    setUnauthorizedHandler(() => { closeLiveConnection(); setUser(null); });
  }, []);

  const login = useCallback(async (email, password) => {
    const { user: u } = await api.login({ email, password });
    closeLiveConnection(); // reconnect SSE with the new cookie
    setUser(u);
    return u;
  }, []);

  const register = useCallback(async (body) => {
    const { user: u } = await api.register(body);
    closeLiveConnection();
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    closeLiveConnection();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, register, logout }), [user, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** Gate for signed-in pages; optionally restricted to one role. */
export function RequireAuth({ role, children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}
