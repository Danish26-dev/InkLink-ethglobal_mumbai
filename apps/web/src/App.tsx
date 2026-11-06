import { Navigate, Route, Routes } from 'react-router-dom';
import { shopToken } from './lib/api';
import { ShopList } from './customer/ShopList';
import { Chat } from './customer/Chat';
import { Workspace } from './workspace/Workspace';
import { ShopLayout } from './shop/ShopLayout';
import { ShopOrdersPage, ShopOverviewPage, ShopPairingPage, ShopPrintersPage, ShopSettingsPage } from './shop/ShopPages';

export function App() {
  return (
    <Routes>
      {/* Customer PWA (anonymous session, no login, no wallet) */}
      <Route path="/" element={<ShopList />} />
      <Route path="/chat/:jobId" element={<Chat />} />
      <Route path="/chat/:jobId/workspace" element={<Workspace auth="web" />} />

      {/* Shop dashboard (shop admin token) */}
      <Route path="/shop/jobs/:jobId/workspace" element={shopToken.get() ? <Workspace auth="shop" /> : <Navigate to="/shop" replace />} />
      <Route path="/shop" element={<ShopLayout />}>
        <Route index element={<ShopOverviewPage />} />
        <Route path="orders" element={<ShopOrdersPage />} />
        <Route path="printers" element={<ShopPrintersPage />} />
        <Route path="settings" element={<ShopSettingsPage />} />
        <Route path="pairing" element={<ShopPairingPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
