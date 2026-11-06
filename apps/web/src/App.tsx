import { Navigate, Route, Routes } from 'react-router-dom';
import { Portal } from './portal/Portal';
import { ShopList } from './customer/ShopList';
import { PrintSession } from './customer/PrintSession';
import { JobsPage } from './customer/JobsPage';
import { Workspace } from './workspace/Workspace';
import { ShopAgentPage } from './shop/ShopAgentPage';
import { ShopLayout } from './shop/ShopLayout';
import { ShopLogin } from './shop/ShopLogin';
import {
  ShopHardwarePage,
  ShopOrdersPage,
  ShopOverviewPage,
  ShopPairingPage,
  ShopPaymentsPage,
  ShopSettingsPage,
} from './shop/ShopPages';
import { DemoPage } from './demo/DemoPage';
import { JuryLayout } from './jury/JuryLayout';
import { JuryAgent, JuryCustomer, JuryExecution, JuryIntro, JuryPayment, JuryProcessing, JuryResult, JuryShop } from './jury/JuryPages';

/**
 * PWA routes. The landing page owns `/` (separate app); everything here lives
 * under /portal, /app, /shop, /jury and /demo on the same origin.
 */
export function App() {
  return (
    <Routes>
      {/* Entry portal: Customer · Shopkeeper · ETHGlobal Jury */}
      <Route path="/portal" element={<Portal />} />

      {/* Customer (anonymous guest session; identity and payment live in the native app) */}
      <Route path="/app" element={<ShopList />} />
      {/* The path keeps its name for existing links; the page is a document-first print session. */}
      <Route path="/app/chat/:shopId" element={<PrintSession />} />
      <Route path="/app/jobs" element={<JobsPage />} />
      <Route path="/app/jobs/:jobId/agent" element={<Workspace auth="web" />} />

      {/* Shopkeeper (server-side session; backend-enforced shop ownership) */}
      <Route path="/shop/login" element={<ShopLogin />} />
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

      {/* ETHGlobal jury: one isolated demo job across every perspective */}
      <Route path="/jury" element={<JuryLayout />}>
        <Route index element={<JuryIntro />} />
        <Route path="customer" element={<JuryCustomer />} />
        <Route path="processing" element={<JuryProcessing />} />
        <Route path="shop" element={<JuryShop />} />
        <Route path="agent" element={<JuryAgent />} />
        <Route path="payment" element={<JuryPayment />} />
        <Route path="execution" element={<JuryExecution />} />
        <Route path="result" element={<JuryResult />} />
      </Route>

      {/* Previous judge walkthrough now points at the jury experience */}
      <Route path="/demo" element={<DemoPage />} />

      <Route path="*" element={<Navigate to="/portal" replace />} />
    </Routes>
  );
}
