import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import { clearToken, getToken, setIsAdmin, setToken } from "./api";

type AuthContextValue = {
  token: string | null;
  login: (jwt: string, isAdmin?: boolean) => void;
  logout: () => void;
  connectOpen: boolean;
  setConnectOpen: (open: boolean) => void;
};

const AuthContext = createContext<AuthContextValue>({
  token: null,
  login: () => {},
  logout: () => {},
  connectOpen: false,
  setConnectOpen: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState(() => getToken());
  const [connectOpen, setConnectOpen] = useState(false);

  const login = useCallback((jwt: string, isAdmin = false) => {
    setToken(jwt);
    setIsAdmin(isAdmin);
    setTokenState(jwt);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, login, logout, connectOpen, setConnectOpen }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
