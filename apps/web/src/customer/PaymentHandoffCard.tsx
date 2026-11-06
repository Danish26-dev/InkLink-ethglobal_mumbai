import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ExternalLink, Smartphone } from 'lucide-react';
import type { PaymentHandoff } from '@inklink/shared-schemas';

/**
 * Hands payment over to the native Inklink app. The browser never takes
 * payment: the app holds the device key, the spending authorization and the
 * Hedera x402 flow. The token is single-use, short-lived and carries no amount.
 */
export function PaymentHandoffCard({ handoff }: { handoff: PaymentHandoff }) {
  const [qr, setQr] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() => secondsLeft(handoff.expiresAt));

  useEffect(() => {
    QRCode.toDataURL(handoff.qrText, { margin: 1, width: 220, color: { dark: '#111111', light: '#FFFFFF' } }).then(setQr, () => setQr(null));
  }, [handoff.qrText]);

  useEffect(() => {
    const t = setInterval(() => setRemaining(secondsLeft(handoff.expiresAt)), 1000);
    return () => clearInterval(t);
  }, [handoff.expiresAt]);

  const expired = remaining <= 0;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        <p className="font-medium">Continue in the Inklink app</p>
      </div>
      <p className="mt-1 text-sm text-graphite">
        Open the app on this phone, or scan the code with the app on another phone. Payment is authorized there.
      </p>
      {expired ? (
        <p className="mt-3 text-sm text-signal">This payment link expired. Approve the quote again to get a new one.</p>
      ) : (
        <>
          <a href={handoff.deepLink} className="btn-primary mt-3 w-full">
            Open Inklink app <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
          {qr && <img src={qr} alt="Payment handoff code for the Inklink app" className="mx-auto mt-4 h-[180px] w-[180px] rounded-md border border-light-grey" />}
          <p className="mt-2 text-center font-mono text-[11px] text-graphite">
            Single use · expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
          </p>
        </>
      )}
    </div>
  );
}

function secondsLeft(iso: string) {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}
