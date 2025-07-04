import React, { 
    createContext, 
    useState, 
    useCallback, 
    useMemo, 
    useContext, 
    PropsWithChildren 
} from 'react';
import { 
    BrowserRouter, 
    Routes, 
    Route, 
    Navigate, 
    useLocation, 
    Outlet,
    Location
} from 'react-router-dom';


// --- Type Definitions for context ---
type Dictionary = Record<string, string>;
interface I18nState {
    locale: string;
    t: (key: string) => string;
    setLocale: (locale: string) => void;
}

/* -------------------------------------------------------------------------- */
/* i18n                                                                       */
/* -------------------------------------------------------------------------- */
const I18nContext = createContext<I18nState | undefined>(undefined);

const defaultDictionaries: Record<string, Dictionary> = {
  en: { welcome: 'Welcome', logout: 'Logout' },
  es: { welcome: 'Bienvenido', logout: 'Cerrar sesi?n' },
};
const I18nProvider = ({ children }: PropsWithChildren) => {
  const [locale, setLocale] = useState<string>('en');
  const t = useCallback(
    (key: string) => defaultDictionaries[locale]?.[key] ?? key,
    [locale]
  );
  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
export const useI18n = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
};

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */
type AuthState = {
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

const AuthProvider = ({ children }: PropsWithChildren) => {
  const [isAuthenticated, setAuthenticated] = useState<boolean>(false);
  const login = useCallback(() => setAuthenticated(true), []);
  const logout = useCallback(() => setAuthenticated(false), []);
  const value = useMemo(
    () => ({ isAuthenticated, login, logout }),
    [isAuthenticated, login, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */
const Layout = () => {
  const { t } = useI18n();
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <div className="app-layout">
      <header className="app-header">{t('welcome')}</header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */
const Dashboard = () => {
  return <div>Dashboard Content</div>;
};

const Login = () => {
  const { login } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname || '/';
  return (
    <button
      onClick={() => {
        login();
        window.location.href = from;
      }}
    >
      Log In
    </button>
  );
};

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */
const App = () => {
  return (
    <I18nProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
            </Route>
            <Route path="/login" element={<Login />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  );
};

export default App;