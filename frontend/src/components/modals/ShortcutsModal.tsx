import { Keyboard, X } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const { locale, t } = useI18n();
  const isVi = locale === 'vi';

  const groups = [
    {
      title: isVi ? 'Dự án & Lịch sử' : 'Project & History',
      items: [
        { keys: 'Cmd / Ctrl + S', desc: isVi ? 'Lưu dự án & tạo bản sao lưu SQLite' : 'Save project & create SQLite backup snapshot' },
        { keys: 'Cmd / Ctrl + Z', desc: isVi ? 'Hoàn tác thao tác gần nhất' : 'Undo last action' },
        { keys: 'Cmd / Ctrl + Shift + Z', desc: isVi ? 'Làm lại thao tác' : 'Redo action' },
      ],
    },
    {
      title: isVi ? 'Phát xem trước & Điều hướng Dòng thời gian' : 'Playback & Timeline Transport',
      items: [
        { keys: 'Space', desc: isVi ? 'Phát / Tạm dừng xem trước kèm SFX' : 'Play / Pause real-time Preview & SFX audio' },
        { keys: 'J / K / L', desc: isVi ? 'Lùi nhanh / Tạm dừng / Phát' : 'Step back / Pause / Play' },
        { keys: '← / →', desc: isVi ? 'Bước ±1 khung hình (giữ Shift = ±10 khung)' : 'Step ±1 frame (Shift = ±10 frames)' },
        { keys: 'Home / End', desc: isVi ? 'Về khung đầu / khung cuối' : 'Jump to first / last frame' },
      ],
    },
    {
      title: isVi ? 'Công cụ Biến đổi & Khung nhìn Sân khấu' : 'Transform Tools & Stage Viewport',
      items: [
        { keys: 'V / W / R / S / P', desc: isVi ? 'Công cụ Chọn / Di chuyển / Xoay / Tỷ lệ / Điểm xoay (Pivot)' : 'Select / Move / Rotate / Scale / Pivot tools' },
        { keys: 'G / \'', desc: isVi ? 'Bật/tắt Lưới bố cục & Khung an toàn' : 'Toggle Composition Grid & Safe-Area Guides' },
        { keys: '0', desc: isVi ? 'Đặt khung nhìn vừa màn hình' : 'Reset Canvas Viewport to Fit' },
        { keys: isVi ? 'Alt + Kéo / Chuột giữa' : 'Alt + Drag / Middle Click', desc: isVi ? 'Dịch chuyển khung nhìn (không đổi vị trí đối tượng)' : 'Pan Canvas Viewport (independent of Scene Camera)' },
      ],
    },
    {
      title: isVi ? 'Bảng điều khiển & Khung hình khóa' : 'Panels & Keyframes',
      items: [
        { keys: '[ / ] / Cmd+\\', desc: isVi ? 'Thu gọn/Mở bảng Trái / Thuộc tính / Dòng thời gian' : 'Collapse/Expand Left / Inspector / Master Timeline' },
        { keys: 'Cmd / Ctrl + C / V', desc: isVi ? 'Sao chép & dán khung hình khóa tại con trỏ' : 'Copy & paste selected keyframe at playhead' },
        { keys: 'Delete / Backspace', desc: isVi ? 'Xóa khung hình khóa hoặc đoạn SFX đang chọn' : 'Delete selected keyframe or SFX clip' },
        { keys: '?', desc: isVi ? 'Mở bảng phím tắt' : 'Toggle Keyboard Shortcuts' },
      ],
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Keyboard size={15} color="var(--accent-text)" />
            {t('modal.shortcutsTitle')}
          </span>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {t('modal.shortcutsNote')}
          </p>
          {groups.map((group) => (
            <div key={group.title} className="inspector-section">
              <div className="inspector-section-title">{group.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {group.items.map((item) => (
                  <div
                    key={item.keys}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)' }}>{item.desc}</span>
                    <kbd className="tag-pill mono" style={{ color: 'var(--accent-text)', fontWeight: 600 }}>
                      {item.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
