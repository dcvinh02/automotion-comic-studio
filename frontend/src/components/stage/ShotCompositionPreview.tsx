import { useI18n } from '@/i18n/useLocaleStore';
import type { ScreenPosition, ShotSize, StoryboardShot } from '@/types/models';

const POS_X: Record<ScreenPosition, number> = {
  far_left: 24,
  left: 52,
  center_left: 84,
  center: 120,
  center_right: 156,
  right: 188,
  far_right: 216,
  offscreen: 252,
};

const SHOT_SIZE_SHORT: Record<ShotSize, string> = {
  extreme_wide: 'EWS',
  wide: 'WS',
  full: 'FS',
  medium_full: 'MFS',
  medium: 'MS',
  medium_close_up: 'MCU',
  close_up: 'CU',
  extreme_close_up: 'ECU',
  over_the_shoulder: 'OTS',
  pov: 'POV',
  insert: 'INS',
};

const CROP_INSET: Record<ShotSize, { x: number; y: number; w: number; h: number }> = {
  extreme_wide: { x: 6, y: 6, w: 228, h: 123 },
  wide: { x: 14, y: 10, w: 212, h: 115 },
  full: { x: 24, y: 14, w: 192, h: 107 },
  medium_full: { x: 34, y: 18, w: 172, h: 99 },
  medium: { x: 46, y: 22, w: 148, h: 90 },
  medium_close_up: { x: 62, y: 24, w: 116, h: 78 },
  close_up: { x: 76, y: 26, w: 88, h: 66 },
  extreme_close_up: { x: 92, y: 34, w: 56, h: 48 },
  over_the_shoulder: { x: 32, y: 18, w: 176, h: 96 },
  pov: { x: 20, y: 14, w: 200, h: 106 },
  insert: { x: 78, y: 32, w: 84, h: 64 },
};

export function ShotCompositionPreview({
  shot,
  compact = false,
}: {
  shot: StoryboardShot;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const crop = CROP_INSET[shot.shot_size] ?? CROP_INSET.medium;

  // Honest horizon vertical offset reflecting camera angle intent
  let horizonY = 74;
  if (shot.camera_angle === 'low_angle') horizonY = 98;
  else if (shot.camera_angle === 'worms_eye') horizonY = 112;
  else if (shot.camera_angle === 'high_angle') horizonY = 44;
  else if (shot.camera_angle === 'birds_eye') horizonY = 26;

  const isDutch = shot.camera_angle === 'dutch_angle';
  const moveColor =
    shot.camera_support_status === 'supported'
      ? '#22c55e'
      : shot.camera_support_status === '2d_approximation'
        ? '#f59e0b'
        : '#ef4444';

  const visibleChars = shot.characters.filter((c) => c.visible && c.screen_position !== 'offscreen');
  const offscreenChars = shot.characters.filter((c) => !c.visible || c.screen_position === 'offscreen');

  return (
    <div
      className={`sb-comp-preview ${compact ? 'compact' : ''}`}
      title={t('storyboard.schematicPreviewTip')}
    >
      <svg viewBox="0 0 240 135" className="sb-comp-svg" role="img" aria-label={shot.title}>
        {/* Frame background */}
        <rect x="0" y="0" width="240" height="135" fill="#10131b" />

        {/* Subtle sky/ground gradient band split by angle horizon */}
        <rect x="0" y="0" width="240" height={horizonY} fill="#151b29" />
        <rect x="0" y={horizonY} width="240" height={135 - horizonY} fill="#121620" />
        <line
          x1="0"
          y1={horizonY}
          x2="240"
          y2={horizonY}
          stroke="rgba(148,163,184,0.22)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />

        {/* Rule-of-thirds guides */}
        <line x1="80" y1="0" x2="80" y2="135" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1="160" y1="0" x2="160" y2="135" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1="0" y1="45" x2="240" y2="45" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1="0" y1="90" x2="240" y2="90" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* Shot Framing Crop Box (tilted for Dutch angle) */}
        <g transform={isDutch ? 'rotate(-7 120 67.5)' : undefined}>
          <rect
            x={crop.x}
            y={crop.y}
            width={crop.w}
            height={crop.h}
            rx="3"
            fill="rgba(124,108,246,0.05)"
            stroke="rgba(167,139,250,0.65)"
            strokeWidth="1.2"
            strokeDasharray="4 2"
          />
        </g>

        {/* OTS foreground shoulder silhouette */}
        {(shot.shot_size === 'over_the_shoulder' || shot.camera_angle === 'over_the_shoulder') && (
          <path
            d="M 0 135 Q 24 88 64 110 L 68 135 Z"
            fill="rgba(15,23,42,0.85)"
            stroke="rgba(148,163,184,0.35)"
            strokeWidth="1"
          />
        )}

        {/* Staged Characters */}
        {visibleChars.map((ch) => {
          const cx = POS_X[ch.screen_position] ?? 120;
          const depthScale =
            ch.depth_layer === 'foreground' ? 1.18 : ch.depth_layer === 'background' ? 0.72 : 0.96;
          const baseY =
            ch.depth_layer === 'foreground' ? 108 : ch.depth_layer === 'background' ? 84 : 98;
          const headR = 8 * depthScale;
          const bodyH = 22 * depthScale;
          const ringColor = ch.speaking
            ? '#38bdf8'
            : ch.reacting
              ? '#f59e0b'
              : ch.is_missing_asset
                ? '#94a3b8'
                : '#a78bfa';

          const facingArrow =
            ch.facing_direction === 'left' || ch.facing_direction === 'three_quarter_left'
              ? '←'
              : ch.facing_direction === 'right' || ch.facing_direction === 'three_quarter_right'
                ? '→'
                : ch.facing_direction === 'back'
                  ? '↑'
                  : '•';

          return (
            <g key={ch.staging_id}>
              {/* Torso */}
              <path
                d={`M ${cx - 11 * depthScale} ${baseY} Q ${cx} ${baseY - bodyH} ${cx + 11 * depthScale} ${baseY} Z`}
                fill="rgba(124,108,246,0.22)"
                stroke={ringColor}
                strokeWidth={ch.speaking ? 1.6 : 1.1}
                strokeDasharray={ch.is_missing_asset ? '2 2' : undefined}
              />
              {/* Head */}
              <circle
                cx={cx}
                cy={baseY - bodyH - headR * 0.55}
                r={headR}
                fill="#1e2436"
                stroke={ringColor}
                strokeWidth={ch.speaking ? 1.6 : 1.1}
                strokeDasharray={ch.is_missing_asset ? '2 2' : undefined}
              />
              {/* Facing indicator */}
              <text
                x={cx}
                y={baseY - bodyH - headR * 0.3}
                textAnchor="middle"
                fontSize="8"
                fill="#e2e8f0"
                fontWeight="700"
              >
                {facingArrow}
              </text>
              {/* Name label pill */}
              <rect
                x={cx - 24}
                y={baseY + 3}
                width="48"
                height="12"
                rx="3"
                fill="rgba(15,18,28,0.88)"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="0.7"
              />
              <text
                x={cx}
                y={baseY + 11.5}
                textAnchor="middle"
                fontSize="7.2"
                fill="#e2e8f0"
                fontWeight="600"
              >
                {ch.character_name.slice(0, 9)}
              </text>
            </g>
          );
        })}

        {/* Camera Movement Direction Overlay */}
        {shot.camera_movement !== 'static' && (
          <g stroke={moveColor} fill="none" strokeWidth="1.6" strokeLinecap="round">
            {shot.camera_movement === 'pan_left' && (
              <>
                <line x1="154" y1="22" x2="86" y2="22" />
                <polyline points="94,17 86,22 94,27" />
              </>
            )}
            {(shot.camera_movement === 'pan_right' ||
              shot.camera_movement === 'tracking' ||
              shot.camera_movement === 'camera_follow') && (
              <>
                <line x1="86" y1="22" x2="154" y2="22" />
                <polyline points="146,17 154,22 146,27" />
              </>
            )}
            {shot.camera_movement === 'tilt_up' && (
              <>
                <line x1="220" y1="92" x2="220" y2="42" />
                <polyline points="215,50 220,42 225,50" />
              </>
            )}
            {shot.camera_movement === 'tilt_down' && (
              <>
                <line x1="220" y1="42" x2="220" y2="92" />
                <polyline points="215,84 220,92 225,84" />
              </>
            )}
            {(shot.camera_movement === 'zoom_in' || shot.camera_movement === 'dolly_in') && (
              <>
                <polyline points="28,28 42,40" />
                <polyline points="212,28 198,40" />
                <polyline points="28,108 42,96" />
                <polyline points="212,108 198,96" />
              </>
            )}
            {(shot.camera_movement === 'zoom_out' || shot.camera_movement === 'dolly_out') && (
              <>
                <polyline points="42,40 28,28" />
                <polyline points="198,40 212,28" />
                <polyline points="42,96 28,108" />
                <polyline points="198,96 212,108" />
              </>
            )}
            {shot.camera_movement === 'shake' && (
              <polyline points="95,22 103,17 111,26 119,18 127,25 135,20 143,23" />
            )}
            {shot.camera_movement === 'parallax' && (
              <g strokeDasharray="3 2">
                <line x1="78" y1="18" x2="162" y2="18" />
                <line x1="94" y1="26" x2="146" y2="26" />
              </g>
            )}
          </g>
        )}

        {/* Top-left Shot Size Badge */}
        <rect x="6" y="6" width="32" height="14" rx="3" fill="rgba(124,108,246,0.88)" />
        <text x="22" y="15.5" textAnchor="middle" fontSize="8" fill="#ffffff" fontWeight="700">
          {SHOT_SIZE_SHORT[shot.shot_size] ?? 'MS'}
        </text>

        {/* Top-right Honest 2D Schematic Tag */}
        <rect x="166" y="6" width="68" height="13" rx="3" fill="rgba(15,23,42,0.82)" />
        <text x="200" y="15" textAnchor="middle" fontSize="6.7" fill="#94a3b8" fontWeight="600">
          2D SCHEMATIC
        </text>

        {/* Offscreen indicator if any */}
        {offscreenChars.length > 0 && (
          <>
            <rect x="6" y="116" width="74" height="13" rx="3" fill="rgba(245,158,11,0.2)" />
            <text x="43" y="125" textAnchor="middle" fontSize="6.8" fill="#fbbf24" fontWeight="600">
              OS: {offscreenChars.map((c) => c.character_name.slice(0, 6)).join(', ')}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
