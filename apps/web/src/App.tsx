import { Navigate, Route, Routes } from 'react-router-dom';
import { ShopList } from './customer/ShopList';
import { PrintSession } from './customer/PrintSession';
import { JobsPage } from './customer/JobsPage';
import { Workspace } from './workspace/Workspace';
import { ShopAgentPage } from './shop/ShopAgentPage';
import { ShopLayout } from './shop/ShopLayout';
import {
  ShopHardwarePage,
  ShopOrdersPage,
  ShopOverviewPage,
  ShopPairingPage,
  ShopPaymentsPage,
  ShopSettingsPage,
} from './shop/ShopPages';
import { DemoPage } from './demo/DemoPage';

/**
 * PWA routes. The landing page owns `/` (separate app); everything here lives
 * under /app, /shop and /demo on the same origin.
 */
export function App() {
  return (
    <Routes>
      {/* Customer (anonymous session; no login, no wallet) */}
      <Route path="/app" element={<ShopList />} />
      {/* The path keeps its name for existing links; the page is a document-first print session. */}
      <Route path="/app/chat/:shopId" element={<PrintSession />} />
      <Route path="/app/jobs" element={<JobsPage />} />
      <Route path="/app/jobs/:jobId/agent" element={<Workspace auth="web" />} />

      {/* Shop dashboard (tokenless on the shop computer; admin token elsewhere) */}
      <Route path="/shop/agent" element={<ShopAgentPage />} />
      <Route path="/shop/agent/:jobId" element={<ShopAgentPage />} />
      <Route path="/shop" element={<ShopLayout />}>
        <Route index element={<ShopOverviewPage />} />
        <Route path="jobs" element={<ShopOrdersPage />} />
        <Route path="hardware" element={<ShopHardwarePage />} />
        <Route path="payments" element={<ShopPaymentsPage />} />
        <Route path="settings" element={<ShopSettingsPage />} />
        <Route path="pairing" element={<ShopPairingPage />} />
      </Route>

      {/* ETHGlobal judge walkthrough */}
      <Route path="/demo" element={<DemoPage />} />

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
