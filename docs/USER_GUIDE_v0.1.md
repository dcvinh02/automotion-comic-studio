# AutoMotion Comic Studio — Hướng Dẫn Sử Dụng (Version 0.1)

**Version 0.1 (Core Animation Engine)** cung cấp quy trình hoàn chỉnh từ nhập ảnh PNG phân lớp, ghép nhân vật 2D Cutout, dựng cảnh, tạo chuyển động + Camera Zoom/Pan, ghép hiệu ứng âm thanh (SFX) đến xuất video MP4 thực tế.

---

## 1. Khởi Động Ứng Dụng

### Yêu cầu hệ thống
- **macOS** (Apple Silicon / Intel) hoặc **Windows 10/11**
- **Node.js** 20+ và **Python 3.11–3.12** (môi trường ảo tại `backend/.venv`)
- **FFmpeg & FFprobe** đã cài đặt trong `PATH` (macOS: `brew install ffmpeg`; Windows: cài FFmpeg bản release và thêm vào `PATH`)

### Chạy ở chế độ phát triển (Dev)
```bash
cd frontend
npm run dev
```
Electron sẽ tự động khởi chạy máy chủ Python FastAPI trên cổng động `127.0.0.1`, mở cửa sổ Studio chính cùng tiến trình PixiJS WebGL Offscreen Worker ẩn, và tự tắt sạch khi bạn đóng ứng dụng.

### Chạy bản Build hoàn chỉnh
```bash
cd frontend
npm run start
```

---

## 2. Quy Trình Sản Xuất Video Mẫu (Từ PNG → MP4)

1. **Tạo Project mới:**
   - Nhấn nút **Projects** trên thanh Top Toolbar → chuyển sang tab **New Project**.
   - Nhập tên dự án, chọn độ phân giải (`1920×1080` hoặc `1280×720`), FPS (`30 fps`) và thời lượng ban đầu (`30` giây) → nhấn **Create Project**.
2. **Import PNG Assets:**
   - Chọn biểu tượng **PNG Asset Library** ở thanh bên trái → nhấn **Import PNG**.
   - Chọn loại tài nguyên (`Character Part` + vai trò `Body / Head / Eyes / Mouth / Arms`, `Background`, hoặc `Prop`), nhập thư mục/tag và tải nhiều tệp PNG cùng lúc.
   - Với `Background`, nhấn **Set BG** để gán làm hình nền cho cảnh hiện tại.
3. **Ghép Nhân Vật 2D Cutout (Rig Editor):**
   - Chọn tab **Characters & Rigs** → nhập tên nhân vật mới → nhấn **New**.
   - Trong **Character Rig Editor**, gán tệp PNG vào từng slot (`Body`, `Head`, `Eyes`, `Mouth`, thêm tay/chân/tóc nếu cần), chọn **Parent Slot** (ví dụ `Head` trực thuộc `Body`; `Eyes`/`Mouth` trực thuộc `Head`), chỉnh **Anchor Point**, **Offset** và **Z-Index**.
   - Thêm các biến thể **State Variants** cho `Eyes` (`open`, `closed`, `happy`...) và `Mouth` (`closed`, `smile`, `a`, `o`...).
   - Tạo **Expression Presets** (`Neutral`, `Happy`, `Surprised`...) và thử trực tiếp ngay trên khung Preview → nhấn **Save Rig**.
4. **Đưa Nhân Vật Lên Canvas & Tạo Chuyển Động:**
   - Quay lại tab **Stage Preview**. Ở danh sách Characters, nhấn **To Stage** để đặt nhân vật vào cảnh.
   - Kéo trực tiếp nhân vật trên Canvas để đổi vị trí, dùng tay cầm tròn phía trên để xoay, tay cầm vuông góc dưới-phải để phóng to/thu nhỏ.
   - Mở **Right Inspector**: nhấn biểu tượng hình thoi (`◆`) cạnh `Pos X`, `Pos Y`, `Expression`, `Eyes`, `Mouth` để đặt **Keyframe** ở mốc thời gian hiện tại; kéo thanh Playhead trên Timeline sang mốc mới và thay đổi giá trị để tạo chuyển động nội suy.
   - Bật **Auto-Blink**, **Breathing** và chọn trạng thái (`IDLE`, `WALKING`, `RUNNING`, `REACTING`...) trong mục **Animation State & Procedural**.
   - Nhấn nút **Camera** trên thanh Transport để chỉnh & keyframe **Zoom / Pan / Rotation**.
5. **Import & Kéo Thả Sound Effects (SFX):**
   - Mở tab **Sound Effects Library** (hỗ trợ đầy đủ 16 nhóm âm thanh chuẩn).
   - Nhấn **Import**, chọn tệp `WAV / MP3 / FLAC / OGG`, chọn nhóm âm thanh và khai báo **License Source / Verification**.
   - Nhấn nút Play để nghe thử kèm biểu đồ **Waveform**, sau đó **kéo thả trực tiếp** thẻ âm thanh vào làn **SFX Track** trên Master Timeline (hoặc nhấn **+ Timeline**).
   - Chọn clip SFX trên Timeline để kéo di chuyển, kéo cạnh phải để cắt độ dài, và chỉnh **Volume / Speed / Fade In / Fade Out / Stereo Pan / Loop** ở Right Inspector.
6. **Preview & Tự Động Lưu:**
   - Nhấn **Play** (hoặc phím `Space`) để xem trước hoạt hình đồng bộ âm thanh SFX theo thời gian thực.
   - Dự án tự động lưu sau 2 giây ngừng thao tác; nhấn `Cmd/Ctrl + S` để lưu ngay kèm bản sao lưu SQLite trong `backups/` (có thể khôi phục bất kỳ lúc nào tại **Projects → Backups & Restore**).
7. **Kiểm Tra Chất Lượng (QC) & Xuất MP4:**
   - Nhấn nút **Export MP4** trên Top Toolbar.
   - Hệ thống tự động chạy **Pre-Flight Quality Control** (kiểm tra thiếu PNG, thiếu file SFX, lỗi Timeline, cảnh báo chồng lấp SFX, kiểm tra FFmpeg).
   - Chọn Preset (`720p Preview` hoặc `1080p Final`), kích thước chunk (`10s/chunk`), và nhấn **Export MP4**.
   - Theo dõi tiến trình theo thời gian thực tại **Job Queue Drawer** (hỗ trợ **Cancel**, **Resume** từ chunk đã hoàn tất nếu gián đoạn, và **Reveal MP4**).

---

## 3. Không Gian Làm Việc (Workspaces) & Phím Tắt Studio

Thanh Top Bar tích hợp **Workspace Switcher** giúp chuyển đổi nhanh bố cục mà **không làm mất dữ liệu dự án**:
- **Animation:** Tập trung Stage Canvas, Nhân vật, Keyframe & Master Timeline.
- **Scene:** Tập trung quản lý cảnh, khung hình Safe-Area Guides và Camera.
- **Audio:** Mở rộng Thư viện 16 nhóm Sound Effects và làn Timeline SFX kèm Waveform.
- **Assets:** Mở rộng lưới trình duyệt PNG và mở **Asset Inspector** bên phải (xem kích thước, SHA-256, gắn tag, xác nhận danh tính).
- **Script (`0.2`):** Hiển thị trạng thái lộ trình Module 01 & 03 (không tạo giao diện giả).

### Điều khiển Canvas, Công cụ Biến đổi & Giao diện Song ngữ (Phase 03)
- **Giao diện Song ngữ Tiếng Việt / English:** Mặc định khởi động bằng **Tiếng Việt**. Chuyển đổi tức thì qua nút **VI / EN** trên Top Bar hoặc trong **Cài đặt → Chung → Ngôn ngữ giao diện** (`Tiếng Việt` / `English`) — không khởi động lại, không mất dự án/lựa chọn, tự ghi nhớ giữa các phiên làm việc và không bao giờ dịch tên dự án/cảnh/nhân vật/tệp của người dùng.
- **Bộ công cụ Biến đổi trên Sân khấu:** Thanh công cụ nổi bên trái Canvas hỗ trợ **Chọn (`V`)**, **Di chuyển (`W`)**, **Xoay (`R`)**, **Tỷ lệ (`S`)**, và **Điểm xoay Pivot (`P`)**; giữ `Shift` để khóa trục / bước góc 15°.
- **Viewport Zoom / Pan độc lập với Scene Camera:** Dùng nút `Zoom -/+`, `Vừa khung (0)`, `Cmd/Ctrl + Cuộn chuột`, hoặc `Alt + Kéo chuột` (chuột giữa) để phóng to/di chuyển khung nhìn mà không làm thay đổi vị trí Camera hay tọa độ đối tượng trong video xuất.
- **Làn thuộc tính mở rộng & Kéo Keyframe trên Timeline:** Bấm mũi tên mở rộng (`›`) cạnh làn Nhân vật, Đối tượng hoặc Camera để xem các làn thuộc tính con (`Vị trí X`, `Vị trí Y`, `Góc xoay`, `Tỷ lệ`, `Độ mờ`, `Bộ phận Rig...`). Kéo ngang hình thoi Keyframe để dời thời gian theo khung hình, nhấn `Cmd/Ctrl + C` / `Cmd/Ctrl + V` để sao chép/dán Keyframe, `Delete/Backspace` để xóa.
- **Chế độ Nội suy & Mẫu chuyển động (Presets):** Hỗ trợ `Giữ nguyên (Hold)`, `Tuyến tính (Linear)`, `Vào chậm (Ease In)`, `Ra chậm (Ease Out)`, `Chậm hai đầu (Ease In Out)`. 9 mẫu chuyển động nhanh (Đứng chờ, Di chuyển 4 hướng, Bước đi, Nảy lên, Phóng to/Thu nhỏ) sinh ra khung khóa thật có thể chỉnh sửa hoàn toàn.
- **Ghép nhân vật Cutout & Điều khiển từng bộ phận:** Hỗ trợ nút **Nhóm các lớp PNG → Nhân vật** ngay tại bảng Cảnh, nút **+ Tay/Chân/Tóc** cùng tâm ngắm **Pivot** trực quan màu hổ phách trong trình Rig Editor, và bộ chọn **Bộ phận điều khiển (Rig)** ngay tại bảng Thuộc tính để đặt khung khóa xoay riêng từng tay/đầu.
- **Grid (`G`) & Safe-Area Guides (`'`):** Bật lưới bố cục 1/3 và khung an toàn 90%/80% ngay trên PixiJS Stage.
- **Numeric Scrubbers:** Kéo ngang trực tiếp lên nhãn `X`, `Y`, `R`, `Z`... ở Right Inspector để tăng giảm mượt (giữ `Shift` để kéo nhanh 5x, `Alt` để tinh chỉnh).
- **Chuột phải (Context Menu):** Hỗ trợ trên Stage và Timeline (Khóa toàn bộ biến đổi, Sao chép/Dán Keyframe, đổi chế độ nội suy, nhân bản/xóa clip SFX).
- **Khóa & Ẩn Track trên Timeline:** Nút ổ khóa (`Lock`) chống kéo nhầm/thả nhầm clip; nút con mắt (`Eye`) ẩn/hiện nhân vật hoặc đối tượng trong Preview.

### Phím tắt chính (xem đầy đủ bằng phím `?` trong app)
- `V` / `W` / `R` / `S` / `P`: Công cụ Chọn / Di chuyển / Xoay / Tỷ lệ / Điểm xoay Pivot
- `Space` / `J` / `K` / `L`: Play/Pause & điều hướng NLE
- `←` / `→` (giữ `Shift` ±10 frame): Bước từng khung hình
- `Home` / `End`: Về đầu / cuối Master Timeline
- `G` / `'`: Bật/tắt Grid & Safe-Area Guides
- `0`: Đưa khung nhìn Canvas về Fit
- `[` / `]` / `Cmd/Ctrl + \`: Thu gọn Left Panel / Inspector / Master Timeline
- `Cmd/Ctrl + C` / `Cmd/Ctrl + V` / `Delete`: Sao chép, dán, xóa Keyframe đang chọn
- `Cmd/Ctrl + S`: Lưu dự án và tạo bản Backup SQLite
- `Cmd/Ctrl + Z` / `Cmd/Ctrl + Shift + Z`: Undo / Redo

---

## 4. Trạng Thái Các Phân Hệ Lộ Trình
- **Version 0.1 (Hoạt động đầy đủ):** Project Manager + Backup/Restore, PNG Asset Library, Cutout Character Rig Editor, PixiJS WebGL Stage + Camera + Keyframes + Procedural Animation, Master Timeline, 16-Category Sound Effects Library + Web Audio Preview, Chunked FFmpeg MP4 Export + Pre-Flight QC + Job Queue.
- **Version 0.2 (Đang khóa có chủ đích):** Script Intelligence Engine (OpenAI Structured Outputs) & Voice Production Engine (F5-TTS).
- **Version 0.3–1.0 (Đang khóa có chủ đích):** AI Director, Hybrid Lip-Sync, Ambient/BGM Auto-Ducking, Batch Multi-Episode Production.


## Tính năng mới ở Giai đoạn 04 (Đồng bộ Lớp/Timeline, Inspector Nâng cao, Kịch bản & Giọng đọc)

- **Đồng bộ Lớp ↔ Dòng thời gian & Thứ tự Z-Order:**
  - Nút **+ Lớp trống** (`+ Empty Layer`) tạo lớp mới xuất hiện ngay lập tức ở cả bảng **Các lớp sân khấu** lẫn **Dòng thời gian (Timeline)** dù chưa có khung hình khóa.
  - Kéo thả trực tiếp hàng lớp trong bảng Lớp hoặc đầu làn trong Timeline (hoặc dùng nút **Đưa lên trước nhất / Đưa lên / Đưa xuống / Đưa ra sau cùng**) để thay đổi thứ tự chồng lớp Z-Order trên Canvas mà vẫn giữ nguyên toàn bộ keyframe và hiệu ứng.
  - Ẩn/hiện (Eye), khóa/mở khóa (Lock), đổi tên (double-click hoặc chuột phải) đồng bộ hai chiều giữa bảng Lớp, Inspector, Canvas và Timeline.
- **Bộ điều khiển Inspector chuyên nghiệp:**
  - Ô số (`NumericInput`) không dùng nút tăng/giảm thô mặc định của trình duyệt; hỗ trợ nhập tay chính xác, phím mũi tên `↑/↓` (`Shift` = 10x, `Alt` = 0.1x), kéo ngang trên nhãn để chỉnh mượt, tự từ chối dữ liệu lỗi (`abc`, `NaN`).
  - Thanh trượt kèm ô số cho **Độ mờ (0–100%)**, **Tỷ lệ (Scale)** kèm nút **Khóa tỷ lệ khung hình**, **Góc xoay (Rotation)** liên tục không giới hạn và nút đặt lại nhanh.
- **Trình soạn Kịch bản & Sản xuất Giọng đọc (Không gian `Kịch bản`):**
  - Tạo nhiều cảnh kịch bản, viết **Lời thoại** (liên kết theo ID nhân vật bền vững), **Dẫn chuyện** và **Hành động**, kéo thả sắp xếp thứ tự, đồng bộ cảnh sang Sân khấu.
  - Gán hồ sơ giọng đọc cho từng nhân vật trong bảng **Giọng đọc & Hồ sơ giọng** bên phải (chỉ hiển thị các tham số mà nhà cung cấp thực sự hỗ trợ).
  - Bấm **Tạo giọng đọc** để tổng hợp file WAV thật (qua `Local OS Speech (macOS)` offline, `F5-TTS` khi cấu hình `AMCS_F5_TTS_URL`, hoặc `Mô phỏng kiểm thử` có nhãn cảnh báo rõ ràng), nghe thử ngay với sóng âm thật và bấm **Đưa lên Timeline** để trộn trực tiếp vào bản xuất MP4.


## Cập nhật Giai đoạn 05 — Đợt 1 (Sửa lỗi kéo Keyframe, Chọn nhiều & Thao tác hàng loạt trên Timeline)

- **Kéo Keyframe chuẩn xác (Di chuyển nguyên ID, không trùng lặp):**
  - Trên làn thu gọn, các thuộc tính cùng một khung hình được gom thành **Cụm Keyframe** (kim cương viền kép); kéo cụm này sẽ di chuyển đồng thời tất cả thuộc tính tại khung hình đó mà không để lại dấu mốc ma. Mở rộng làn (`>`) để chỉnh riêng từng thuộc tính (`Vị trí X`, `Vị trí Y`, `Góc xoay`...).
  - Kéo lướt qua keyframe khác không làm mất keyframe trung gian; thả đè lên cùng thuộc tính/khung hình sẽ thay thế nhất quán và báo cho người dùng. Nhấn `Escape` khi đang kéo sẽ hủy gọn không tạo bước Hoàn tác thừa.
- **Chọn nhiều Keyframe & Thao tác hàng loạt:**
  - `Click`: chọn đơn; `Cmd/Ctrl + Click`: bật/tắt thêm bớt; `Shift + Click`: chọn dải liên tiếp; **Kéo vùng chọn (Marquee)** trên vùng trống làn Timeline; `Shift + Kéo` trên thước thời gian để chọn theo khoảng khung hình; `Cmd/Ctrl + A`: chọn tất cả trên làn đang chọn; `Esc`: bỏ chọn.
  - Thanh thao tác nhanh hiện khi có keyframe được chọn: **Đưa về đầu phát**, **Nhân bản (`Cmd/Ctrl+D`)**, **Sao chép/Dán (`Cmd/Ctrl+C`/`V`)**, **Xóa hàng loạt (`Delete`/`Backspace`)**, **Đổi nội suy (Easing)**, **Dịch chuyển bằng `Alt + ←/→`** (`Shift+Alt` = ±10 khung hình). Mọi thao tác nhóm đều Hoàn tác/Làm lại gọn trong **1 bước duy nhất**.


## 10. Trình tạo & Lắp ghép nhân vật 2D (Character Builder — Phase 05 Batch 2)

- **Tạo nhân vật nhanh (Create Character):**
  - Ở thanh bên **Nhân vật & Khung xương 2D**, bấm trực tiếp **Tạo nhân vật** (có thể nhập tên trước hoặc để trống để tự đặt `Character 1`, `Character 2`…) để tạo khung cơ bản và mở ngay **Trình lắp ghép nhân vật (Cutout Rig Editor)**.
- **Nhập nhiều ảnh PNG trong suốt cùng lúc:**
  - Kéo thả nhiều tệp PNG/WebP (ví dụ `body.png`, `head.png`, `left_arm.png`, `right_arm.png`, `right_hand.png`, `left_leg.png`, `right_leg.png`, `hair.png`, `eyes.png`, `mouth.png`…) vào vùng thả tệp hoặc khung vẽ, hoặc bấm **Dùng lại ảnh PNG trong Thư viện**.
  - Hệ thống tự nhận diện vai trò cơ thể theo tên tệp, đặt tâm khớp mặc định (cổ cho Đầu, vai cho Tay, cổ tay cho Bàn tay, hông cho Chân…) và tự nối phân cấp cha–con hợp lý mà không nhân đôi tệp PNG trùng lặp trên đĩa.
- **Lắp ghép & Phân cấp trên khung vẽ tương tác:**
  - Dùng các công cụ **Di chuyển (`V`)**, **Xoay (`R`)**, **Tỷ lệ (`S`)**, **Pivot (`P`)**, bật/tắt **Bắt lưới**, **Căn giữa ngang**, **Đặt lại bộ phận / nhân vật**.
  - Trong **Cây phân cấp nhân vật**, kéo thả một bộ phận lên bộ phận khác để gắn cha–con (tự giữ nguyên vị trí hiển thị và tự chặn vòng lặp cha–con), hoặc dùng **Nhóm / Rã nhóm / Tách khỏi cha**, **Ẩn**, **Khóa**, **Đổi tên** tại chỗ.
  - Khi chọn một bộ phận, bộ phận **Cha** hiện khung và đường nối xương màu xanh ngọc, bộ phận **Con** hiện đường nối màu tím, tâm khớp **Pivot** hiện chữ thập màu cam.
- **Chỉnh tâm khớp xoay (Pivot) & Xem thử chuyển động Rig:**
  - Chọn công cụ **Pivot** để kéo trực tiếp tâm chữ thập màu cam hoặc chọn nhanh các nút mẫu (**Đỉnh / Vai**, **Chính giữa**, **Đáy / Cổ**, **Trái**, **Phải**). Khi bật **Giữ nguyên vị trí ảnh khi dời khớp Pivot**, hình ảnh và các bộ phận con đứng yên hoàn toàn trong lúc tâm xoay dịch chuyển.
  - Thanh **Xem thử chuyển động Rig** cho phép phát thử các chuyển động thật (`Đứng thở`, `Chớp mắt`, `Vẫy tay`, `Quay đầu`, `Đi bộ`, `Chạy`, `Nhún nhảy`). Nếu một hành động chưa đủ bộ phận (ví dụ `Chớp mắt` khi chưa gắn biến thể mắt `closed`), nút sẽ tự giải thích rõ nguyên nhân thay vì giả lập sai.
- **Lưu, Quản lý & Đưa lên sân khấu:**
  - Bấm **Lưu khung Rig** rồi **Đưa vào cảnh** để đặt nhân vật lên Sân khấu và hoạt hình tiếp trên Dòng thời gian. Xóa nhân vật trong Thư viện chỉ xóa bản ghi nhân vật, **luôn giữ nguyên toàn bộ ảnh PNG gốc dùng chung**.


## 11. Thư viện Âm thanh (SFX & BGM) & Xưởng Phụ Đề (Phase 05 Batch 3)

- **Thư viện Âm thanh tách biệt Hiệu ứng (SFX) & Nhạc nền (BGM):**
  - Chuyển nhanh giữa hai mục **Hiệu ứng SFX** (24 danh mục) và **Nhạc nền BGM** (14 danh mục), tìm kiếm, lọc theo danh mục / thẻ `#tag` / Yêu thích, nghe thử **Phát / Tạm dừng / Dừng** không bị chồng âm, đổi tên trực tiếp, thay thế tệp, xóa an toàn và nhập tệp WAV/MP3/FLAC/OGG/M4A/AAC.
  - Tích hợp sẵn **Gói âm thanh khởi đầu CC0-1.0** (24 SFX + 10 vòng nhạc nền BGM gốc do AutoMotion Comic Studio tự tổng hợp) kèm bản kê khai giấy phép có thể xem trực tiếp.
- **Dòng thời gian Âm thanh 4 làn (Voice / SFX / BGM / Ambient):**
  - Kéo thả âm thanh từ Thư viện vào các làn âm thanh hoặc bấm **+ Vào dòng thời gian** để chèn tại vị trí đầu phát.
  - Hỗ trợ **Di chuyển**, **Cắt điểm bắt đầu (cạnh trái)**, **Cắt điểm kết thúc (cạnh phải)**, **Âm lượng**, **Tăng/Giảm dần (Fade In/Out)**, **Lặp (Loop)**, **Tắt tiếng (M)**, **Solo (S)** và tự động hòa trộn qua FFmpeg khi xuất MP4.
- **Xưởng Phụ Đề (Subtitle Studio) & Làn Phụ đề độc lập:**
  - Chuyển sang thẻ **Xưởng phụ đề** để xem trực tiếp phụ đề ngay trên Sân khấu cùng bảng biên tập đầy đủ (`Bắt đầu`, `Kết thúc`, `Độ dài`, `Người nói`, `Kiểu chữ`, `Nội dung nhiều dòng UTF-8 tiếng Việt`).
  - Hỗ trợ **Thêm**, **Sửa**, **Xóa**, **Nhân bản**, **Tách đôi**, **Gộp nhiều đoạn**, kéo dời / kéo giãn hai cạnh ngay trên làn **Subtitles** của Dòng thời gian, **Tạo từ Kịch bản / Giọng đọc** (hiển thị rõ `Khớp giọng đọc` hay `Thời gian ước lượng`), **Nhập & Kiểm tra SRT UTF-8**, **Xuất SRT / ASS**.
  - **5 mẫu kiểu chữ tái sử dụng chỉnh sửa được** (`Classic White`, `Cinematic`, `Bold Comic`, `Minimal`, `High Contrast`) cùng khả năng tạo mẫu mới.
  - Khi bấm **Xuất MP4**, có thể chọn **Ghi cứng vào khung hình (Burn-in)**, **Làn phụ đề mềm MP4 (`mov_text`)**, hoặc **Không gắn**, kèm tùy chọn xuất thêm tệp rời `.srt` chuẩn UTF-8.


## 12. Đạo diễn AI — Phân tích kịch bản & Chia cảnh tự động (Phase 06 Batch 1)

- **Cấu hình nhà cung cấp AI (Không mã cứng khóa API):**
  - Mở **Cài đặt → Nhà cung cấp AI & Phân tích kịch bản** để chọn **OpenAI**, **Google Gemini**, hoặc **OpenAI-Compatible / Máy chủ cục bộ (Ollama, LM Studio…)**, nhập mô hình, địa chỉ API, khóa API (hoặc đặt biến môi trường `OPENAI_API_KEY` / `GEMINI_API_KEY`), ngôn ngữ đầu ra phân tích (`Tự động`, `Tiếng Việt`, `English`), thời gian hết giờ, số lần thử lại và cỡ đoạn cho kịch bản dài.
  - Bấm **Kiểm tra kết nối** để xác nhận nhà cung cấp phản hồi JSON có cấu trúc trước khi chạy phân tích.
- **Phân tích kịch bản không ghi đè bản gốc:**
  - Mở không gian **Đạo diễn AI** từ thanh công cụ trên, thanh điều hướng trái hoặc thẻ trung tâm.
  - Chọn nguồn kịch bản (**Tự động**, **Kịch bản thô của dự án**, **Phân cảnh sẵn có**, hoặc **Dán kịch bản tạm**) rồi bấm **Phân tích kịch bản**. Kịch bản dài tự động chia đoạn theo ranh giới đoạn văn, giữ ngữ cảnh cuộn và hợp nhất nhân vật/cảnh xuyên đoạn; người dùng có thể bấm **Hủy phân tích** bất cứ lúc nào.
- **Kiểm duyệt 4 thẻ chuyên biệt:**
  - **Tổng quan & Sản xuất:** Xem tóm tắt, chủ đề, giọng điệu, cấu trúc & nhịp kể chuyện (có ghi rõ mức độ không chắc chắn nếu đoạn trích ngắn), cùng 8 nhóm gợi ý sản xuất Motion Comic (cơ hội thị giác, hành động, cảm xúc, khoảng lặng, bối cảnh, chuyển cảnh, VFX).
  - **Nhân vật & Biệt danh:** Kiểm tra nhân vật trích xuất, cảnh báo **Ngoại hình: Chưa mô tả** (AI không tự bịa), cảnh báo **Biệt danh mơ hồ**, đổi tên / sửa hồ sơ, **Gộp nhân vật trùng**, **Tách biệt danh** thành nhân vật riêng, và **Liên kết Thư viện Nhân vật sẵn có** mà không tạo trùng lặp.
  - **Thoại & Dẫn chuyện:** Xem nguyên văn lời thoại, dẫn chuyện, độc thoại nội tâm, hành động và gợi ý âm thanh theo đúng ngôn ngữ gốc; lọc mục **Chưa rõ người nói** và gán lại người nói trực tiếp.
  - **Duyệt phân cảnh:** Tách bạch rõ 4 lớp (**1. Văn bản kịch bản gốc chỉ đọc**, **2. Dữ kiện trích xuất**, **3. Đề xuất AI chỉnh sửa được**, **4. Bảo vệ chỉnh sửa & Tạo lại cảnh**). Hỗ trợ **Tách cảnh** (không mất chữ), **Gộp nhiều cảnh**, **Đổi thứ tự**, **Xóa**, **Tạo lại riêng một cảnh** (tự động giữ nguyên các trường bạn đã sửa), **Khôi phục bản AI gốc**, và **Chấp nhận / Từ chối** từng cảnh.
- **Áp dụng có chủ đích vào dự án:**
  - Chỉ những phân cảnh đã được bạn đánh dấu **Chấp nhận (Accepted)** mới được đưa vào danh sách phân cảnh kịch bản (và tùy chọn đồng bộ lên Dòng thời gian sân khấu) khi bạn bấm **Áp dụng phân cảnh đã duyệt vào dự án**. Văn bản kịch bản gốc (`raw_source_text`) và các cảnh trước đó của bạn luôn được giữ nguyên vẹn.


## 13. Bảng phân cảnh AI, Kế hoạch Cú máy & Chỉ đạo Camera (Phase 06 Batch 2)

- **Tạo Bảng phân cảnh (Storyboard) từ các cảnh đã duyệt:**
  - Mở không gian **Bảng phân cảnh** từ thanh công cụ trên, thanh điều hướng trái hoặc thẻ trung tâm.
  - Chọn **Tạo Bảng phân cảnh** để AI chuyển từng cảnh đã duyệt thành chuỗi cú máy (Shot) có cấu trúc với cỡ cảnh (11 loại từ Đại cảnh cực rộng đến Đặc tả/Insert), góc máy (8 loại), chuyển động camera (13 loại), thời lượng linh hoạt theo độ dài lời thoại & hành động, và dàn dựng nhân vật bám sát nhân vật sẵn có.
  - Các cảnh chưa thay đổi nội dung sẽ được giữ nguyên (không gọi lại AI thừa) trừ khi bạn yêu cầu tạo lại; nếu gặp lỗi hoặc bấm **Hủy**, các cảnh đã hoàn tất trước đó vẫn được lưu an toàn.
- **Đánh giá trung thực khả năng Camera 2D & Sơ đồ bố cục 2D (`2D SCHEMATIC`):**
  - Mỗi thẻ cú máy hiển thị **Sơ đồ bố cục 2D trực tiếp** (cắt khung cỡ cảnh, đường chân trời theo góc máy, mũi tên chuyển động camera, vị trí & hướng nhìn nhân vật — được gắn nhãn rõ là sơ đồ 2D, không giả mạo ảnh AI).
  - Mỗi chuyển động camera được gắn nhãn rõ khả năng thực thi trên máy quay 2D thật: **Chạy thật trên 2D** (`Static`, `Pan`, `Tilt`, `Zoom`), **Mô phỏng 2D** (`Dolly`, `Tracking`, `Follow`, `Shake`), hoặc **Chỉ gợi ý lập kế hoạch** (`Parallax`).
- **Biên tập cú máy, Khóa bảo vệ & Chiến lược tạo lại:**
  - Hỗ trợ **Thêm**, **Nhân bản**, **Đổi thứ tự**, **Xóa**, **Khóa cú máy (Lock)**, sửa tiêu đề, mục đích, thời lượng, cỡ cảnh, góc máy, chuyển động, lý do đạo diễn và **Dàn dựng nhân vật** (liên kết trực tiếp Thư viện Nhân vật hoặc cảnh báo **Thiếu tài nguyên Rig**).
  - **Tạo lại cú máy đang chọn** tự động giữ nguyên các trường bạn đã chỉnh sửa (và chặn ghi đè cú máy đang khóa); **Tạo lại (Giữ mục khóa)** giữ nguyên toàn bộ cú máy đã khóa trong cảnh; **Thay toàn bộ cảnh** luôn yêu cầu xác nhận rõ ràng trước khi ghi đè.
- **Phân tích tính liên tục (Continuity) & Đồng bộ thời lượng cảnh:**
  - Bấm **Kiểm tra liên tục** để rà soát tức thì các lỗi nhảy vị trí trái/phải vô lý, lật hướng nhìn 180°, nhân vật đã rời cảnh nhưng vẫn xuất hiện, mất nhân vật giữa đoạn đối thoại, lời thoại chưa dàn dựng người nói, hoặc thiếu tài nguyên Rig nhân vật. Người dùng có thể bấm nhảy tới cú máy lỗi, đánh dấu đã xem hoặc bỏ qua mà hệ thống không bao giờ tự ý sửa kịch bản.
  - Bấm **Đồng bộ thời lượng Cảnh sân khấu theo cú máy** ở bảng trái để khớp thời lượng Cảnh trên Dòng thời gian với tổng thời lượng các cú máy.


## 14. Trình lập Kế hoạch Sản xuất AI & Tích hợp Dòng thời gian An toàn (Phase 06 Batch 3)

- **Chuỗi sản xuất Đạo diễn AI liền mạch (5 bước điều hướng tự do):**
  - Mở không gian **Kế hoạch SX (Production)** từ thanh công cụ trên, thanh điều hướng trái hoặc thẻ trung tâm.
  - Thanh bước phía trên (`1. Kịch bản → 2. Phân tích AI → 3. Storyboard → 4. Kế hoạch SX → 5. Sân khấu & Timeline`) cho phép quay lại bất kỳ bước trước nào để chỉnh sửa mà không mất dữ liệu.
- **Tạo Kế hoạch Sản xuất khả thi & Đối khớp tài nguyên trung thực:**
  - Bấm **Tạo kế hoạch SX** để chuyển các cú máy Storyboard thành kế hoạch sản xuất chi tiết từng cú máy: dàn dựng nhân vật, bối cảnh & đạo cụ, hoạt ảnh 15 nhóm, máy quay 2D, hiệu ứng SFX/nhạc nền BGM, giọng đọc & phụ đề.
  - Mọi liên kết nhân vật, ảnh PNG và tệp âm thanh đều đối khớp **100% với bản ghi thật trong Thư viện** (không bao giờ bịa ID giả, không tự chèn nhạc nền chưa xác minh bản quyền).
  - Các hành động chưa được bộ máy 2D hỗ trợ tự động (như `attack`, `fall`, `custom`, thiếu biến thể mắt `eyes:closed` cho `blink`, hay camera `parallax`) đều được gắn nhãn trung thực kèm lý do và phương án keyframe thủ công.
- **Kiểm tra độ sẵn sàng trực tiếp & Xử lý phụ thuộc ngay tại chỗ:**
  - Mỗi cú máy hiển thị trạng thái sẵn sàng thật (`Sẵn sàng`, `Thiếu nhân vật`, `Thiếu Rig`, `Thiếu tài nguyên`, `Cần chỉnh hoạt ảnh`, `Cần chỉnh máy quay`, `Thiếu âm thanh`, `Cần kiểm duyệt`, `Chưa hỗ trợ`) và danh sách chi tiết các phụ thuộc còn thiếu.
  - Người dùng có thể gán trực tiếp Nhân vật Rig, ảnh Bối cảnh/Đạo cụ, đổi nhóm Hoạt ảnh, đổi chuyển động Máy quay 2D, hoặc chọn Âm thanh đã xác minh bản quyền ngay trong bảng chi tiết — độ sẵn sàng cập nhật tức thì (hoặc bấm **Kiểm tra sẵn sàng (Trực tiếp)** mà không cần gọi lại AI).
  - Hỗ trợ **Khóa cú máy (Lock)**, **Duyệt / Từ chối** từng cú máy / cả cảnh / toàn bộ, và **Tạo lại kế hoạch cú máy** có bảo vệ các trường người dùng đã chỉnh sửa.
- **Xem trước trước khi áp dụng, Phát hiện xung đột & Thực thi không trùng lặp lên Timeline:**
  - Bấm **Xem trước & Áp dụng Timeline** để mở hộp thoại xem trước chi tiết: phạm vi (`Cú máy đang chọn`, `Cảnh hiện tại`, `Tất cả đã duyệt`), mốc thời gian từng cú máy, số mục bỏ qua do chưa hỗ trợ, và **Cảnh báo xung đột** nếu trùng với keyframe/clip/âm thanh/phụ đề người dùng đã tạo trước đó.
  - Luôn chọn được chiến lược chèn an toàn: **Chỉ cập nhật mục thuộc Kế hoạch SX**, **Bỏ qua các cú máy bị xung đột**, hoặc **Nối tiếp sau cuối Timeline hiện tại**. Dữ liệu Timeline do người dùng tự tạo **không bao giờ bị ghi đè âm thầm**, và việc áp dụng lại cùng kế hoạch nhiều lần **không bao giờ sinh trùng lặp** nhờ cơ chế sở hữu `timeline_refs`, kèm Hoàn tác (`Cmd/Ctrl+Z`) trọn vẹn trong 1 bước.


## 15. Bộ máy Thực thi Cảnh & Tự động Lắp ráp Sân khấu (Phase 07 Batch 1)

- **Xem trước Thực thi Cảnh & Sửa nhanh tài nguyên thiếu trước khi lắp ráp:**
  - Từ không gian **Kế hoạch SX (Production)**, bấm **Lắp ráp Cảnh (Thực thi Kế hoạch)** (hoặc **Lắp ráp Cảnh** / **Lắp ráp Cú máy**) để mở hộp thoại **Xem trước Thực thi Cảnh — Tự động Lắp ráp Sân khấu**.
  - Hệ thống xác thực toàn bộ nhân vật (ID & bộ phận Rig thật), ảnh nền/đạo cụ (ID & tệp thật trên ổ đĩa), máy quay 2D và hoạt ảnh trước khi tạo đối tượng.
  - Hộp thoại hiển thị rõ tọa độ dàn dựng `(x, y)` đã tự động chống chồng lấn giữa nhiều nhân vật, **Thứ tự lớp (Trước → Sau)**, số đối tượng người dùng sẽ được giữ nguyên, và các **ô Sửa nhanh (chọn trực tiếp từ Thư viện thật)** ngay trên từng mục thiếu tài nguyên để khắc phục tức thì.
- **Tự động lắp ráp Sân khấu thực, Cô lập trạng thái từng Cú máy & Không sinh trùng lặp:**
  - Bấm **Áp dụng tất cả hợp lệ** hoặc **Áp dụng mục chọn** để tự động lắp ráp đối tượng thật (`Nhân vật Rig`, `Ảnh nền`, `Môi trường`, `Đạo cụ`, `Tiền cảnh`) lên Sân khấu PixiJS WebGL cùng keyframe Camera 2D trên Dòng thời gian.
  - **Thanh chuyển Cú máy (Shot Switcher)** ngay phía trên Sân khấu, danh sách **Cú máy đã lắp ráp** ở bảng Cảnh bên trái, và các **phân đoạn ranh giới Cú máy** trên làn `Scene / Background` của Timeline cho phép nhảy tức thì giữa các cú máy: mỗi cú máy hiển thị đúng bối cảnh, khung hình camera, vị trí/hướng nhìn nhân vật và đạo cụ riêng mà **không rò rỉ sang cú máy khác**, đồng thời luôn giữ nguyên các đối tượng do người dùng tự đặt.
  - Chọn bất kỳ cú máy nào để mở **Thuộc tính — Cú máy (Shot)** ở bảng bên phải (chỉnh tiêu đề, thời lượng, ảnh nền riêng, khung hình camera, kiểm tra nhân vật/đạo cụ và ghi chú dàn dựng). Mọi thao tác đều hỗ trợ Hoàn tác (`Cmd/Ctrl+Z`), Làm lại và chạy lại thực thi an toàn (**Cập nhật cú máy đã có** / **Tái dùng** / **Bỏ qua**) mà không bao giờ tạo đối tượng trùng lặp.


## 16. Thực thi Hoạt ảnh AI, Thư viện Chuyển động & Camera 2D Đồng bộ (Phase 07 Batch 2)

- **Kiểm tra Khả năng Rig & Thư viện Chuyển động (Motion Library):**
  - Mở thẻ **Hoạt ảnh (Animation)** ở thanh điều hướng trái (hoặc bảng **Thuộc tính nhân vật**) để xem danh sách khả năng thật của Rig nhân vật đang chọn (`full_cutout` / `upper_body` / `simple_cutout`, gồm xoay đầu, tay, chân, chớp mắt, mở miệng...).
  - **Thư viện Chuyển động** cung cấp sẵn 11 mẫu cốt lõi (`Idle Breathing`, `Walk Cycle`, `Run Sprint`, `Eye Blink`, `Arm Wave`, `Head Turn / Look`, `Talk / Dialogue Flaps`, `Jump Arc`, `Fall / Drop`, `Startle / Reaction Beat`, `2D Facing Turn`) và hỗ trợ **Lưu mẫu mới**, **Đổi tên**, **Nhân bản**, **Xóa mẫu tùy chỉnh**. Mỗi mẫu đều hiển thị độ tương thích thật (`Hỗ trợ đầy đủ` / `Một phần` / `Chưa hỗ trợ`) và không bao giờ tự áp mẫu không tương thích lên Rig thiếu bộ phận.
- **Xem trước Chuyển động trực tiếp trên Sân khấu thật (Không làm hỏng Keyframe):**
  - Điều chỉnh các tham số (`Thời lượng`, `Tốc độ`, `Cường độ`, `Quãng đường`, `Hướng`, `Nội suy`, `Tư thế đầu/cuối`, `Lặp lại`, `Đồng bộ Camera bám nhân vật`) hoặc chuyển sang chế độ **Camera 2D** (`static`, `pan`, `tilt`, `zoom`, `dolly`, `shake`, `tracking`, `camera_follow` — từ chối trung thực `parallax` thay vì thay thế ngầm).
  - Bấm **Xem trước (Preview)** để chạy thử chuyển động trực tiếp trên nhân vật Rig thật ngay trên Sân khấu PixiJS (hỗ trợ **Phát/Tạm dừng/Dừng/Đặt lại/Hủy**) mà **không ghi keyframe vĩnh viễn** cho tới khi bạn bấm **Áp dụng lên Timeline** (hỗ trợ đầy đủ Hoàn tác `Cmd/Ctrl+Z`).
- **Thực thi Hoạt ảnh & Camera AI từ Kế hoạch Sản xuất:**
  - Bấm **Thực thi Hoạt ảnh & Camera AI** từ bảng **Hoạt ảnh**, bảng **Kế hoạch SX**, hoặc **Thuộc tính Cú máy** để xem trước số keyframe thật sẽ tạo, đồng bộ **Camera bám theo nhân vật** theo đúng thời lượng cú máy, và danh sách trung thực các mục chưa hỗ trợ (`attack`, `custom`, `parallax`).
  - Mọi keyframe tạo ra đều là keyframe thật có thể chỉnh sửa trên Timeline, được cô lập chặt chẽ theo từng cú máy (không rò rỉ sang cú máy tiếp theo), bảo vệ các hoạt ảnh người dùng đã chỉnh sửa và cho phép **Tạo lại (Regenerate)** từng hoạt ảnh riêng lẻ.

## 17. Xuất Video, Hàng đợi Render & Lịch sử Xuất (Phase 08 Batch 3)

- **Mở hộp thoại Xuất video** (nút **Xuất video** trên thanh công cụ hoặc **Xuất mới** trong thẻ Hàng đợi Render):
  - **Phạm vi:** Toàn bộ dự án, Cảnh hiện tại, Các cảnh đã chọn, Cú máy hiện tại, Các cú máy đã chọn, hoặc Khoảng thời gian. Các cảnh/cú máy luôn được xuất theo đúng thứ tự trên Timeline.
  - **Video:** độ phân giải (Theo dự án, HD, Full HD, QHD, 4K, Dọc HD, Dọc Full HD, Tùy chỉnh), FPS (24/25/30/50/60 hoặc tùy chỉnh — FPS thay đổi số khung hình render thật), định dạng (MP4, MOV, WebM — chỉ hiện định dạng mà bản FFmpeg trên máy hỗ trợ), codec (H.264, H.265/HEVC, VP9, ProRes), chất lượng (Nháp / Tiêu chuẩn / Cao / Tối đa — mỗi mức dùng thiết lập mã hóa khác nhau thật sự) và **thiết lập nâng cao** (CRF, bitrate, preset, profile, pixel format, keyframe).
  - Khi tỉ lệ khung xuất khác sân khấu (ví dụ xuất dọc từ dự án ngang), chọn **Vừa khung** (viền đen), **Lấp đầy** (cắt) hoặc **Kéo giãn**.
  - **Âm thanh:** trộn toàn bộ giọng nói, thoại, SFX, nhạc nền, âm thanh môi trường theo đúng thời điểm trên Timeline; tùy chọn **chuẩn hóa độ lớn (LUFS)** chỉ áp dụng cho bản xuất, không sửa tệp gốc.
  - **Phụ đề:** Ghi cứng vào hình, Phụ đề rời (MP4/MOV), và/hoặc tệp `.srt` UTF-8 đi kèm (thời gian được tính lại theo phạm vi xuất).
  - **Đầu ra:** thư mục, tên tệp (giữ nguyên tiếng Việt có dấu và khoảng trắng) và cách xử lý khi trùng tên (**Giữ cả hai** — mặc định, **Dừng và báo lỗi**, hoặc **Thay thế sau khi xuất thành công**). Ứng dụng không bao giờ ghi đè âm thầm.
  - Mục **Kiểm tra** cho biết trước đường dẫn tệp cuối cùng, số khung hình, thời lượng, bộ mã hóa và mọi lỗi/cảnh báo. Chọn **Render ngay** hoặc **Thêm vào hàng đợi**.
- **Hàng đợi Render:** các tác vụ chạy lần lượt từng cái một. Có thể **Tạm dừng / Tiếp tục** (giữ các đoạn đã render xong), **Hủy**, **Bỏ qua**, **Thử lại**, **Đổi thứ tự** và **Xóa** tác vụ đang chờ. Tiến độ hiển thị số khung đã render thật; thời gian còn lại chỉ hiện khi đã đủ dữ liệu đo.
- **Xác minh tệp xuất:** sau khi mã hóa, tệp được kiểm tra bằng FFprobe (codec, độ phân giải, FPS, số khung hình chính xác, thời lượng, luồng âm thanh/phụ đề) và giải mã toàn bộ. Tệp lỗi không bao giờ được đánh dấu Hoàn tất và không bao giờ xuất hiện tại đường dẫn cuối.
- **Khôi phục:** nếu ứng dụng bị đóng khi đang render, lần mở sau tác vụ được đánh dấu **Bị gián đoạn** (không tự chạy lại); bấm **Thử lại** để tiếp tục từ đoạn cuối đã hoàn thành.
- **Lịch sử Xuất:** Xem thử video ngay trong ứng dụng, Mở tệp, Mở thư mục, Sao chép đường dẫn, Xuất lại, xem Nhật ký. **Xóa mục** chỉ xóa khỏi danh sách — không bao giờ xóa video đã xuất.
- **FFmpeg:** vào **Cài đặt → FFmpeg / Môi trường media** để dò tìm, xem phiên bản, khai báo đường dẫn FFmpeg/FFprobe và **Kiểm tra bộ mã hóa**. Ứng dụng không tự tải FFmpeg.
