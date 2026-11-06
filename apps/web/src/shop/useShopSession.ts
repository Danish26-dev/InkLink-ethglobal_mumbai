import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type ShopSessionView } from '../lib/api';

/**
 * The shopkeeper's server-side session. Any 401 (no session, expired or
 * logged out elsewhere) sends the user to /shop/login and back afterwards.
 */
export function useShopSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState<ShopSessionView | null>(null);

  const toLogin = useCallback(
    (expired: boolean) => {
      const next = encodeURIComponent(location.pathname + location.search);
      navigate(`/shop/login?next=${next}${expired ? '&expired=1' : ''}`, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );

  /** Call with any API error: redirects on auth failures, returns true if it did. */
  const handleAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        toLogin(e.code === 'SESSION_EXPIRED');
        return true;
      }
      return false;
    },
    [toLogin],
  );

  useEffect(() => {
    api.shopAuth.me().then(setSession, (e) => handleAuthError(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchShop = async (shopId: string) => setSession(await api.shopAuth.setActiveShop(shopId));

  const logout = async () => {
    try {
      await api.shopAuth.logout();
    } finally {
      navigate('/shop/login', { replace: true });
    }
  };

  return { session, handleAuthError, switchShop, logout };
}
