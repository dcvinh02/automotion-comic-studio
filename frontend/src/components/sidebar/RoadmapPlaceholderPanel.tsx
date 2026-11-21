import { Lock } from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export function RoadmapPlaceholderPanel({
  moduleKey,
}: {
  moduleKey: 'script' | 'voice' | 'storyboard';
}) {
  const { locale, t } = useI18n();
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const isVi = locale === 'vi';

  const meta = {
    script: {
      version: isVi ? 'Phiên bản 0.2' : 'Version 0.2',
      title: isVi
        ? 'Module 01 — Phân tích Kịch bản AI'
        : 'Module 01 — Script Intelligence Engine',
      summary: isVi
        ? 'Nhập/biên tập kịch bản, nhận diện nhân vật, tách lời thoại, gắn nhãn cảm xúc/hành động và sinh phân cảnh có cấu trúc qua OpenAI Structured Outputs.'
        : 'Script import/editor, character & dialogue extraction, emotion/action tagging, and structured storyboard generation via OpenAI Structured Outputs.',
      reqs: isVi
        ? [
            'Adapter OpenAI Structured Outputs cấu hình trong backend/providers/',
            'Di trú bảng Script & Dialogue trong SQLite project.db',
            'Luồng người dùng duyệt & chỉnh sửa kết quả AI trước khi đưa lên Timeline',
          ]
        : [
            'OpenAI Structured Outputs provider adapter configured in backend/providers/',
            'Script & Dialogue SQLite tables migrated in project.db',
            'Human-in-the-loop review workflow before timeline generation',
          ],
    },
    voice: {
      version: isVi ? 'Phiên bản 0.2' : 'Version 0.2',
      title: isVi
        ? 'Module 03 — Sản xuất Giọng đọc'
        : 'Module 03 — Voice Production Engine',
      summary: isVi
        ? 'Quản lý hồ sơ giọng đọc nhân vật, tích hợp F5-TTS (cùng Fish Audio / Edge-TTS), sinh âm thanh từng câu thoại và đồng bộ lên làn Voice Track.'
        : 'Character voice profiles, F5-TTS (plus Fish Audio / Edge-TTS) provider adapter, per-line synthesis, loudness normalization, and Voice Track placement.',
      reqs: isVi
        ? [
            'Tích hợp F5-TTS provider adapter & cấu hình mô hình',
            'Lưu cache từng đoạn thoại & đồng bộ master_voice.wav lên Master Timeline',
          ]
        : [
            'F5-TTS provider adapter & model configuration',
            'Audio chunk caching & master_voice.wav synchronization on Master Timeline',
          ],
    },
    storyboard: {
      version: isVi ? 'Phiên bản 0.3' : 'Version 0.3',
      title: isVi
        ? 'Module 05 — Đạo diễn AI & Phân cảnh'
        : 'Module 05 — AI Director & Storyboard Engine',
      summary: isVi
        ? 'Tự động đề xuất bố cục nhân vật, biểu cảm, góc máy Camera, chuyển cảnh và gán Sound Effects phù hợp ngữ cảnh.'
        : 'Automated shot framing, character placement, expression/pose suggestions, camera movement, and Automatic Sound Assignment.',
      reqs: isVi
        ? [
            'Hoàn tất dữ liệu kịch bản & thời gian lời thoại ở Phiên bản 0.2',
            'Chỉ mục tìm kiếm ngữ nghĩa multilingual-e5-small (có xác nhận danh tính người dùng)',
          ]
        : [
            'Completed Version 0.2 Script & Voice timing metadata',
            'multilingual-e5-small semantic asset index (with human identity confirmation)',
          ],
    },
  }[moduleKey];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="inspector-section" style={{ borderStyle: 'dashed' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="tag-pill accent mono">{meta.version}</span>
          <Lock size={13} color="var(--text-muted)" />
        </div>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.title}</div>
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {meta.summary}
        </p>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-title">{t('roadmap.prerequisites')}</div>
        <ul style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--text-secondary)' }}>
          {meta.reqs.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {t('roadmap.integrityNote')}
      </div>

      <button className="btn-primary" onClick={() => switchWorkspace('animation')}>
        {t('roadmap.returnActive')}
      </button>
    </div>
  );
}
