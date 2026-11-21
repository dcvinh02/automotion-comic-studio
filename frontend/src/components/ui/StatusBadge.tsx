import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

export function StatusBadge({
  tone,
  label,
  title,
}: {
  tone: 'ok' | 'warn' | 'err' | 'neutral';
  label: string;
  title?: string;
}) {
  return (
    <span className={`status-pill ${tone}`} title={title}>
      {tone === 'ok' && <CheckCircle2 size={11} />}
      {tone === 'warn' && <AlertTriangle size={11} />}
      {tone === 'err' && <AlertCircle size={11} />}
      {tone === 'neutral' && <Info size={11} />}
      <span>{label}</span>
    </span>
  );
}
