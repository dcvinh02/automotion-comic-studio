import React, { useEffect, useRef } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useJobStore } from '@/stores/useJobStore';

export function formatTimecode(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const mins = Math.floor(safe / 60000);
  const secs = Math.floor((safe % 60000) / 1000);
  const millis = safe % 1000;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 11 }}>{description}</div>
      {action}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state" style={{ borderStyle: 'solid' }}>
      <Loader2 size={18} className="spin" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="error-banner">
      <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, fontSize: 11 }}>{message}</div>
      {onRetry && (
        <button onClick={onRetry} style={{ padding: '2px 7px', fontSize: 11 }}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function WaveformCanvas({
  peaks,
  height = 24,
  color = '#2dd4bf',
  background = 'transparent',
}: {
  peaks: number[];
  height?: number;
  color?: string;
  background?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (background !== 'transparent') {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }

    const data = peaks.length > 0 ? peaks : [0.05, 0.05];
    const barW = Math.max(1, w / data.length);
    ctx.fillStyle = color;
    const mid = h / 2;
    for (let i = 0; i < data.length; i++) {
      const amp = Math.max(0.06, Math.min(1, data[i]));
      const barH = amp * (h - 2);
      ctx.fillRect(i * barW, mid - barH / 2, Math.max(1, barW - 0.6), barH);
    }
  }, [peaks, height, color, background]);

  return (
    <canvas
      ref={canvasRef}
      width={240}
      height={height}
      style={{ width: '100%', height, display: 'block', borderRadius: 3 }}
    />
  );
}

export function ToastStack() {
  const { t } = useI18n();
  const toasts = useJobStore((s) => s.toasts);
  const dismiss = useJobStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item ${toast.kind}`}>
          <span>{toast.message}</span>
          <button
            className="btn-ghost btn-icon"
            onClick={() => dismiss(toast.id)}
            aria-label={t('common.dismiss')}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
