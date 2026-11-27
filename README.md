# custom_excalidraw — self-hosted Excalidraw boards

แอป Excalidraw ที่รันใน Docker แล้ว **เก็บกระดานเป็นไฟล์บนเซิร์ฟเวอร์ของเราเอง** ไม่ใช่ localStorage ของเบราว์เซอร์
เปิดหน้า catalog เพื่อดู/สร้าง/จัดหมวดกระดาน แล้วเข้าแก้ทีละใบผ่าน `/b/<id>` — บันทึกอัตโนมัติทันทีที่มีการแก้ และหลายคนแก้กระดานเดียวกันพร้อมกันได้

```
http://localhost:5001          # catalog + ตัวแก้ไข อยู่ origin เดียวกัน
```

---

## ฟีเจอร์

**กระดานและ catalog**

- กระดาน 1 ใบ = 1 โฟลเดอร์บนดิสก์ (`gallery/scenes/<id>/`) — ไม่มีฐานข้อมูล, ย้ายเครื่อง = คัดลอกโฟลเดอร์
- หน้าแรกเป็น catalog การ์ดกระดาน พร้อมรูปพรีวิว, ช่องค้นหา (ชื่อ/คำอธิบาย/แท็ก) และปุ่ม `+ กระดานใหม่`
- จัดหมวดหมู่กระดานได้ (ชื่อ + สี) — **ใบเดียวอยู่ได้หลายหมวด** และไปปรากฏใต้ทุกหมวด; ติ๊กเปลี่ยนหมวดได้จากเมนูบนการ์ด (ยิง PATCH ครั้งเดียวต่อการเปลี่ยน)
- แต่ละหมวดหุบ/กางได้ จำสถานะไว้ในเบราว์เซอร์; ค้นหาสลับกับ chip หมวดได้ (ผลคือส่วนตัดกัน)
- **สลับมุมมองได้ 3 แบบ** จากปุ่มที่แถวหัวเรื่อง — `การ์ด` (กริดการ์ดแนวตั้ง), `แถว` (แถวเต็มความกว้าง อ่านชื่อ/ขนาดง่าย) และ `bento` (กริดผสม: ใบที่เนื้อหาเยอะ/ผืนใหญ่กว่าได้ช่อง 2×2, ผืนกว้างได้ 2 คอลัมน์, ผืนสูงได้ 2 แถว ใบเล็กได้ 1 ช่อง) — ขนาดช่องคิดจากจำนวน element และสัดส่วนภาพของแต่ละกระดาน (คำนวณตอน build) และจำโหมดที่เลือกไว้ใน `localStorage["boards-view"]` โดยใช้ก่อนเฟรมแรก
- **พับแถบหมวดหมู่** ด้วยปุ่มที่มุมขวาของหัวเรื่อง: พับแล้วเหลือหัวเรื่องแถวเดียว ความสูง 56px (จากเดิมที่บวมได้ทั้งจอเมื่อหมวดเยอะ) จำสถานะใน `localStorage["boards-bar"]`; ถ้ากำลังกรองด้วย chip อยู่จะมีจุดบอกว่าซ่อนฟิลเตอร์ไว้ และกดแล้วกางกลับมาเห็นชิปพร้อมสถานะเดิม
- เปลี่ยนชื่อ/คำอธิบาย/หมวดจากหน้ารวมที่เดียว — คนที่เปิดกระดานอยู่เห็นชื่อใหม่ทันที
- ลบกระดานเป็นแบบ **กดค้าง 1.1 วินาที** ใน dialog ยืนยัน (กันเผลอกด)
- ธีม light/dark ทั้งหน้า catalog และหน้าแก้ไข (จำค่าต่อกระดาน / ต่อเบราว์เซอร์, ไม่กระพริบตอนโหลด)

**หน้าแก้ไข**

- **โลโก้**: ไฟล์ต้นฉบับอยู่ที่ `assets/logo/` (`logo-512`, `logo-180`, `logo-64`, `logo-32` + `source.jpeg`) เป็น PNG พื้นหลังโปร่งใส — ตัดเฉพาะขอบขาวรอบนอกออกด้วยการ flood fill จากขอบภาพ พื้นขาวด้านในกรอบยังทึบตามงานศิลป์; หน้า catalog ใช้ `logo-64` เป็นตราริมชื่อเรื่อง (ไม่มีไทล์พื้นขาวแล้ว มีแค่ `drop-shadow` เบา ๆ) และ `logo-32`/`logo-180` เป็น favicon/apple-touch, หน้า board ใช้ชุดเดียวกันจาก `app/public/`; `gallery/build.mjs` คัดลอกไอคอนเข้า `gallery/site/` ทุกครั้งที่ build และคอนเทนเนอร์ตั้ง `LOGO_DIR=/srv/assets/logo`
- Canvas เต็มหน้าจอ ใช้แถบเครื่องมือวาดของ Excalidraw อันเดียว ไม่มีแถบของแอปทับด้านบน — มีแค่ปุ่ม `←` กลับหน้ารวมที่มุมซ้ายบน
- **เกาะเครื่องมือลอย**: แถบเครื่องมือวาดของ Excalidraw ถูกยกออกมาเป็นแถวลอย `position: fixed` กลางด้านบนของกระดาน **ลากย้ายไม่ได้** (ไม่มี grip, ไม่มีปุ่มย่อ/กาง) — ตำแหน่งมาจากการคำนวณเท่านั้น: กลางช่องว่างที่เหลือระหว่างปุ่มมุมซ้ายกับกลุ่มปุ่มมุมขวา และจัดใหม่เองเมื่อแถวกว้างขึ้นหรือหน้าต่างเปลี่ยนขนาด; ไม่จำตำแหน่งลง `localStorage`
- **เมนู `เครื่องมือเพิ่มเติม` (⋮) ท้ายแถบเครื่องมือวาด**: เก็บของเสริมนอกเหนือจากเครื่องมือวาดไว้ในที่เดียว — `เลเซอร์พอยต์`, `สร้างตาราง`, `แผนที่ย่อ`, `เลือกแบบบ่วง` (แนวเดียวกับ More tools ของ excalidraw.com ที่ซ่อน Frame/Web Embed/Laser ไว้แบบเดียวกัน) แถวเครื่องมือจึงเหลือแค่เครื่องมือวาดจริง ๆ; เปิดด้วยคลิก, ปิดด้วย `Esc` หรือคลิกนอกเมนู, แต่ละแถวมีเครื่องหมายถูกบอกว่าตัวไหนเปิดอยู่
  - ปุ่มมี `aria-haspopup`/`aria-expanded`, เมนูเป็น `role="menu"` แถวละ `menuitemcheckbox` พร้อมเครื่องหมายถูกเมื่อเปิดอยู่, `Esc` หรือคลิกนอกเมนูปิดได้, เมนูจัดตำแหน่งขวาชิดปุ่มและพลิกขึ้นด้านบนถ้าที่ไม่พอ
  - บนมือถือ (≤560px) ปุ่มนี้ซ่อนพร้อมกับปุ่มเสริมอื่น ๆ เพราะแถวใช้ของ Excalidraw เอง
- **Minimap**: ภาพย่อของกระดานทั้งใบ มีกรอบบอกตำแหน่งที่มองอยู่ คลิก/ลากในแผนที่เพื่อเลื่อนจอ (เปิด/ปิดจากเมนู `เครื่องมือเพิ่มเติม`)
- **Lasso**: ลากเส้นรอบสิ่งที่ต้องการเลือก (Excalidraw 0.18 ยังไม่มี lasso ในตัว) — เปิดจากเมนู `เครื่องมือเพิ่มเติม`, `Esc` ยกเลิก
- **แคปซูลสถานะการบันทึก** มุมขวาบน: `กำลังบันทึก…` → `บันทึกแล้ว HH:MM` / `บันทึกไม่สำเร็จ` (กดเพื่อลองใหม่)
- **คนในกระดาน**: avatar stack เกาะอยู่ในแถวเมนูขวาบนของ Excalidraw ข้างปุ่ม `Library`
- **ปากกาเลเซอร์**: เปิดจากเมนู `เครื่องมือเพิ่มเติม` (⋮) แถวแรก — กดค้างแล้วลาก จะเห็นเส้นสีแดงจางหายเหมือน excalidraw.com และคนอื่นในกระดานเห็นเส้นเดียวกัน (สีเดียวกับสีชื่อของคนนั้น) กดปุ่มเดิมซ้ำหรือคีย์ `K` ขณะโฟกัสบนกระดานเพื่อกลับไปโหมดเลือก; หัวลูกศรของคนอื่นยังปิดไว้ เห็นกันแค่เส้นเลเซอร์

**ตัวสร้างตาราง**

- เปิดเมนู `เครื่องมือเพิ่มเติม` (⋮) ท้ายแถวเครื่องมือวาด แล้วเลือก `สร้างตาราง` → กำหนดคอลัมน์/แถว/ความกว้าง-สูงรวม/สีหัวตาราง แล้วแทรกลงกระดาน
- ดับเบิลคลิกในช่องแล้วพิมพ์ได้เลย ข้อความผูกกับช่องนั้นและล้นออกนอกช่องไม่ได้
- คลิกครั้งเดียว = เลือกทั้งตาราง (ทุกช่องเป็น group เดียว) ลากย้าย/คัดลอก/ลบได้ทั้งก้อน
- ขยายทีหลังได้: `+ 1 แถว`, `+ 1 คอลัมน์`, `อัปเดตตารางที่เลือก` (ข้อความในช่องเดิมยังอยู่ เพราะจับคู่ตามตำแหน่ง r/c)
- **โตที่เดิม ไม่ต้องสร้างใหม่**: เอาเมาส์วางบนตาราง จะมีปุ่มลอย 2 ปุ่มติดขอบ — `+ แถว` กลางขอบล่าง (เพิ่มแถวต่อท้าย) และ `+ คอลัมน์` กลางขอบขวา (เพิ่มคอลัมน์ต่อท้าย); กดแล้วตารางเดิมโตขึ้นทันที ไม่มีสำเนา/ปุ่มลูกศรต่อตารางอีก, ปุ่มหายไปเมื่อเมาส์ออกจากตาราง — ของ ER class จะมีแค่ `+ แถว` เพราะคลาสไม่มีแกนคอลัมน์
- ปรับความสูง/กว้างทีละแถว-ทีละคอลัมน์ได้ พร้อมสไลเดอร์ที่เห็นผลบนกระดานทันที (undo ครั้งเดียวต่อการลาก)
- **Grid highlight**: ไฮไลต์แถวและคอลัมน์ของช่องที่คลิกอยู่ตลอดเวลา แม้ซูม/เลื่อนจอ

**หลายคนแก้พร้อมกัน**

- WebSocket **ต่อกระดาน** (`/ws/board/<id>`) — เปิดกระดานเดียวกันสองแท็บ/สองเครื่องก็แก้พร้อมกันได้เลย
- รวมแบบ element ต่อ element (เทียบ `version`/`versionNonce`), merge `files` ก่อน `elements` เพื่อให้รูปที่อีกคนวางขึ้นครบ
- ขณะลาก/พิมพ์ข้อความจะยังไม่รับ scene จากคนอื่นจนกว่าจะปล่อย (กันงานหลุดมือ)
- รีเฟรชแท็บเดิมได้ที่เดิม (sid ใน `sessionStorage`), heartbeat 30 วินาทีตัด socket ที่ตายทิ้ง

---

## เริ่มใช้งาน

```bash
git clone <repo-url> custom_excalidraw
cd custom_excalidraw
docker compose up -d --build     # ครั้งแรก (หรือหลังแก้โค้ด) เท่านั้น
open http://localhost:5001
```

หลังจากนั้น `docker compose up -d` เปล่า ๆ พอ — **ไม่ต้อง migrate กระดาน ไม่ต้อง generate catalog เอง**
เพราะ entrypoint (`docker/entrypoint.sh`) ทำให้ทุกครั้งที่ container start:

1. ย้ายกระดานรุ่นเก่าที่เป็นไฟล์แบน (`<id>.excalidraw` + `<id>.meta.json` + `.history/<id>/`) เข้าโฟลเดอร์ `<id>/`
   (รันซ้ำได้ ไม่ทำซ้ำ; ข้ามด้วย `SKIP_MIGRATE=1`)
2. เขียน `gallery/site/index.html` + `manifest.json` จากข้อมูลจริง — เปิด `/` ได้เสมอแม้ยังไม่มีกระดานสักใบ (ข้ามด้วย `SKIP_GALLERY=1`)

ระหว่างใช้งาน ทุกครั้งที่ **สร้าง / บันทึก / เปลี่ยนชื่อ / ลบ** กระดาน เซิร์ฟเวอร์จะสั่งสร้าง catalog ใหม่ให้เองใน ~1.2 วินาที

เหลือรันบนโฮสต์อย่างเดียว: **render รูปพรีวิว** (ในคอนเทนเนอร์ไม่มี Chrome/CLI ของ excalidraw)
คอนเทนเนอร์เขียน `index.html` ใหม่ทุกครั้งที่บันทึก แต่ไม่แตะ PNG — ถ้าไม่มีอะไร render ให้ ภาพตัวอย่างจะค้างที่ครั้งสุดท้ายที่ build

เปิด watcher ไว้ตอนทำงาน (แนะนำ — เปิดครั้งเดียวแล้วปล่อยไว้):

```bash
node scripts/watch-previews.mjs     # render ครั้งแรก แล้วคอย render ใหม่เมื่อกระดานถูกบันทึก
```

มันเฝ้า `gallery/scenes/` ปล่อยให้การบันทึกนิ่ง ~2 วินาที แล้วรัน `gallery/build.mjs` ซึ่ง render เฉพาะใบที่ยังไม่มีภาพ
หรือภาพเก่ากว่า scene — `meta.json`, `history/` และ `.groups.json` ไม่ทำให้ render ซ้ำ; หยุดด้วย Ctrl-C
(มี `--once` สำหรับ render รอบเดียวแล้วจบ, `--no-initial` สำหรับเฝ้าอย่างเดียว)

ติดตั้งให้เริ่มเองตอน login (macOS/launchd — ติดตั้งครั้งเดียว หลังจากนั้นไม่ต้องเปิด terminal):

```bash
node scripts/install-watch-previews.mjs              # ติดตั้ง + เริ่มทันที
node scripts/install-watch-previews.mjs --uninstall   # ถอนออก
```

label `com.aixt.excalidraw.previews`, log ที่ `.cache/preview-watcher.log`

ถ้าไม่อยากเปิด process ค้างไว้ เรียกเองเป็นครั้งคราวก็ได้:

```bash
node gallery/build.mjs        # PNG พรีวิวของกระดานที่ยังไม่มี/เก่า; ใบที่ไม่มีพรีวิวขึ้นช่อง “ยังไม่มีภาพตัวอย่าง”
```

หยุด / ดูสถานะ:

```bash
docker compose stop
docker compose logs -f
docker compose ps
```

> โฟลเดอร์ข้อมูลถูก mount ด้วย user ของคุณ (`DOCKER_UID`/`DOCKER_GID`, ค่าเริ่มต้น `501:20` ของ macOS)
> ถ้าเครื่องอื่นใช้ uid/gid ต่าง ให้ `export DOCKER_UID=$(id -u) DOCKER_GID=$(id -g)` ก่อน `docker compose up`

---

## รันระหว่างพัฒนา

```bash
cd app
npm install --include=dev
npm run dev      # vite :5173 proxy /api และ /scenes -> :5002
npm run build    # -> app/dist (คัดลอกฟอนต์ Excalidraw มาด้วย)
node server.mjs  # เสิร์ฟ dist แบบ production ที่ :5002
```

---

## โครงสร้าง

```
app/                    # ตัวแอป (React + @excalidraw/excalidraw 0.18.1)
  src/App.jsx           # โหลด/บันทึกกระดาน, websocket ต่อกระดาน, เกาะเครื่องมือ, avatar
  src/TableBuilder.jsx  # แผงขวาของตัวสร้างตาราง
  src/ToolMenu.jsx      # เมนู "เครื่องมือเพิ่มเติม" ท้ายแถบเครื่องมือวาด
  src/table.js          # generate ตาราง -> elements (rect/line/text)
  src/GridOverlay.jsx   # ไฮไลต์แถว/คอลัมน์ของช่องที่เลือก
  src/Minimap.jsx       # แผนที่ย่อของกระดาน
  src/tools/LassoTool.jsx
  server.mjs            # node:http API + WebSocket ต่อกระดาน + static (dependency เดียว: ws)
  Dockerfile            # multi-stage: vite build -> node:24-slim (build context = repo root)
gallery/
  scenes/               # ← กระดานทั้งหมด (<id>/scene.excalidraw) ไดเรกทอรีเดียวกับที่ API อ่าน/เขียน
    .groups.json        # หมวดหมู่กระดาน (ชื่อ+สี) ไฟล์เดียว — ไม่ถูกนับเป็นกระดาน
  build.mjs             # สแกน scenes/<id>/ -> พรีวิว PNG + catalog (index.html)
  site/                 # ผลลัพธ์ของ build.mjs (ไม่ commit)
docker/entrypoint.sh    # ตอน start: migrate กระดานรุ่นแบน + เขียน catalog
docker-compose.yml
scripts/                # CLI สร้างตาราง, migrate, watch-previews (render พรีวิวอัตโนมัติ), และชุดเทสต์
```

---

## ที่เก็บข้อมูล

กระดาน 1 ใบ = **โฟลเดอร์ 1 โฟลเดอร์** ใต้ `gallery/scenes/` — ชื่อโฟลเดอร์คือ id สาธารณะที่ API และ URL ใช้:

```
gallery/scenes/<id>/
  scene.excalidraw               ← ไฟล์ที่ editor อ่าน/เขียน (JSON มาตรฐานของ Excalidraw)
  meta.json                      ← ชื่อ/คำอธิบาย/หมวด (ไม่มีก็ได้)
  history/<เวลา ISO>.excalidraw  ← สำเนาก่อนถูกเขียนทับ
```

- ทุกครั้งที่บันทึก เซิร์ฟเวอร์ copy ไฟล์เดิมไป `history/` แล้วเขียนไฟล์ใหม่แบบ atomic (`.tmp-…` แล้ว rename)
- เก็บ snapshot **100 ชุดล่าสุดต่อกระดาน** (`HISTORY_KEEP`) เกินแล้วลบเก่าสุดก่อน
- หมวดหมู่เก็บรวมที่ `gallery/scenes/.groups.json` ไฟล์เดียว (ขึ้นต้นด้วยจุด จึงไม่ถูกนับเป็นกระดาน)
- ไฟล์ดิบของทุกกระดานอยู่ที่ `/scenes/<id>.excalidraw` — ดาวน์โหลดจากการ์ดในหน้ารวมได้
- สำรอง: `cp -a gallery/scenes ~/backups/scenes-$(date +%F)` ได้ทั้ง scene, meta และ history
- กู้ snapshot: `cp gallery/scenes/<id>/history/<ไฟล์>.excalidraw gallery/scenes/<id>/scene.excalidraw`
  (snapshot ถูกเก็บ**ก่อน**เขียนทับ จึงเป็นเนื้อหาของเซฟครั้งก่อนหน้า; ถ้าแอปเปิดอยู่ให้หยุดแก้ก่อนวางไฟล์)
- **undo ในตัว Excalidraw ไม่ใช่ history ที่เก็บถาวร** — undo stack อยู่ในหน่วยความจำแท็บนั้น สิ่งที่คงอยู่คือ snapshot ข้างต้น

`id` ต้องตรง `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/`; static ป้องกัน traversal ด้วยการเช็ก path ให้อยู่ใน root และ `/scenes/…` เสิร์ฟเฉพาะ id ที่ผ่าน regex (ยิง `history/` ผ่าน HTTP ไม่ได้)

---

## API

| method | path | หมายเหตุ |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/boards` | `{boards:[{id,title,subtitle,groupId,groupIds,bytes,updated,elements}]}` (`groupIds` = หมวดทั้งหมดของกระดาน) |
| POST | `/api/boards` | สร้างใหม่ body `{"name":"..."}` คืน `{id, scene}` |
| GET | `/api/boards/:id` | scene เต็ม |
| PUT | `/api/boards/:id` | เขียนทับ (validate `type === "excalidraw"`, `elements` เป็น array) |
| GET | `/api/boards/:id/history` | `{id, keep, history:[{name,bytes,savedAt}]}` ใหม่สุดก่อน |
| GET | `/api/boards/:id/meta` | `{id,title,subtitle,tags,groupId,groupIds}` — `title` ว่างแปลว่าใช้ `id`, `groupIds` เป็น array เสมอ (`[]` = ไม่มีหมวด) |
| PATCH | `/api/boards/:id/meta` | เปลี่ยนชื่อ/หมวด — `{"title":"..."}`, `{"groupIds":["grp_a","grp_b"]}` (แทนทั้งลิสต์, `[]` = ล้าง, id ไม่มีจริง 404, เกิน 20 ตัว 400) หรือแบบเดิม `{"groupId":"grp_…"}` (แทนลิสต์ด้วยตัวเดียว, `""`/`null` = ล้าง) |
| DELETE | `/api/boards/:id` | ลบทั้งโฟลเดอร์ + แจ้ง socket (`{type:"deleted"}`) |
| GET | `/api/groups` | `{groups:[{id,name,color,createdAt,updatedAt,count}]}` — `count` = จำนวนกระดานที่ *รวม* หมวดนี้ (กระดานอยู่หลายหมวดนับในทุกหมวด) |
| POST | `/api/groups` | สร้างหมวด `{"name":"...","color":"..."}` (ไม่ใส่สี = `violet`); ชื่อซ้ำ 409 |
| PATCH | `/api/groups/:id` | เปลี่ยนชื่อ/สี |
| DELETE | `/api/groups/:id` | ลบหมวด — ถอดเฉพาะ id นั้นออกจากทุกกระดาน หมวดอื่นของกระดานยังอยู่; คืน `{deleted, moved}` |

WebSocket: `/ws/board/<id>?name=<ชื่อผู้ใช้>&sid=<รหัสแท็บ>`

---

## Environment

| var | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | `5002` | พอร์ตในคอนเทนเนอร์ (compose แมปออกเป็น 5001) |
| `DATA_DIR` | `/data` | โฟลเดอร์กระดาน (mount จาก `gallery/scenes`) |
| `GALLERY_DIR` | `/gallery` | catalog ที่ generate แล้ว (mount จาก `gallery/site`) |
| `APP_DIR` | `/srv/dist` | ไฟล์ SPA ที่ build แล้ว |
| `HISTORY_KEEP` | `100` | จำนวน snapshot ต่อกระดาน (`0` = ไม่เก็บ) |
| `MAX_BODY` | `32MB` | เพดาน payload ตอน PUT และข้อความ WebSocket |
| `HEARTBEAT_MS` | `30000` | ช่วง ping ตรวจ socket ที่ตายแล้ว |
| `GALLERY_BUILD` | `/srv/tools/build.mjs` | สคริปต์ที่เซิร์ฟเวอร์เรียกหลังกระดานเปลี่ยน (`--no-render`); ไม่ตั้ง = ไม่ refresh เอง |
| `SKIP_MIGRATE` | `0` | `1` = ไม่ migrate กระดานรุ่นแบนตอน start |
| `SKIP_GALLERY` | `0` | `1` = ไม่เขียน catalog ตอน start (เช่น mount `/gallery` แบบอ่านอย่างเดียว) |

---

## เทสต์

ทุกตัวสตาร์ทเซิร์ฟเวอร์ชั่วคราวใน temp เอง ไม่แตะ `gallery/scenes` ของจริง:

```bash
node scripts/test-board-storage.mjs    # โฟลเดอร์ต่อกระดาน, history, meta, DELETE
node scripts/test-board-meta.mjs       # เปลี่ยนชื่อ/คำอธิบาย + broadcast
node scripts/test-board-presence.mjs   # presence, sid ซ้ำ, heartbeat, relay เฟรม pointer/เลเซอร์
node scripts/test-preview-watcher.mjs  # พรีวิว render ครั้งแรก, แก้ scene แล้ว render ใหม่, stamp ตาม scene
node scripts/test-grid-resize.mjs      # ตาราง: ย่อ/ขยายแถวและคอลัมน์
node scripts/soak-table.mjs --seed 1   # property test ของตาราง (สุ่มแก้แล้วตรวจ invariant ทุกก้าว)
```

`soak-table.mjs` เปิดกระดานใน headless Chrome แล้วสลับแก้จำนวนแถว/คอลัมน์, ความกว้างรวม, สี, หัวตาราง,
พิมพ์ข้อความ, ย้ายตาราง, undo/redo, reload ตาม seed และตรวจว่ารูปทรงยังถูกทุกก้าว (ช่องต่อกันพอดี,
พิกัด r/c ตรงกับ meta, ข้อความยังอยู่ในช่องตัวเอง, ไม่มีช่องซ้ำ, undo คืนรูปเดิมได้)

```bash
node scripts/soak-table.mjs --seed 1 --ops 30      # ค่าเริ่มต้น
node scripts/soak-table.mjs --seeds 1..8 --ops 40 --json
node scripts/soak-table.mjs --probe               # พิมพ์รูปทรงทุกก้าว
```

ถ้าแก้ UI ให้รัน e2e เพิ่ม (ต้องมีเซิร์ฟเวอร์ที่เสิร์ฟ build ล่าสุด + headless Chrome):

```bash
node scripts/e2e-ui.mjs http://127.0.0.1:5001   # หน้า board: เครื่องมือวาด, ตาราง, ER
node scripts/e2e-catalog.mjs                     # หน้า catalog: 3 โหมดแสดงผล + แถบหมวดหมู่พับได้
```

`e2e-catalog.mjs` ตั้งโลกของตัวเองทั้งหมด (DATA_DIR/GALLERY_DIR ชั่วคราว + fixture 8 กระดาน 3 หมวดหมู่
+ เซิร์ฟเวอร์พอร์ตสุ่ม) จึงไม่ต้องมีเซิร์ฟเวอร์รันอยู่ก่อน และไม่แตะข้อมูลจริง

---

## Deploy / rollback

production คือคอนเทนเนอร์ชุดเดียวจาก `docker-compose.yml` — ข้อมูลจริงไม่ได้อยู่ในคอนเทนเนอร์ แต่อยู่บนโฮสต์ที่ `gallery/scenes/`
ดังนั้น build ใหม่ / ลบ container / `docker compose down` **ไม่ทำให้กระดานหาย**

```bash
git status --short && git log --oneline -3       # ต้องสะอาด
node scripts/test-board-storage.mjs               # + เทสต์อื่นตามหัวข้อก่อนหน้า
docker compose up -d --build
docker compose ps                                 # ต้องได้ Up (healthy)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5001/api/boards    # 200
```

ระหว่าง `up -d --build` มี downtime ~1–2 วินาที แท็บที่เปิดอยู่จะหลุด websocket แล้วต่อกลับเอง (ไฟล์ไม่หาย)

ย้อนกลับ: image ใช้ tag เดียว `excalidraw-boards:latest` จึงย้อนด้วยโค้ด

```bash
git checkout <commit-ที่รู้ว่าดี>     # หรือ git revert
docker compose up -d --build
```

ข้อมูลไม่ต้องย้อนตาม เว้นแต่เปลี่ยนโครงสร้างโฟลเดอร์ — เก็บสำเนา `gallery/scenes/` ไว้ก่อนก็พอ

---

## ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / ทางแก้ |
|---|---|
| `bind: address already in use` ตอนใช้พอร์ต 5000 | macOS AirPlay Receiver จอง 5000 — ใช้ 5001 ตามค่าเริ่มต้น หรือปิด AirPlay Receiver |
| `docker build` ฟ้อง `failed to update builder last activity time` | buildx เขียน `~/.docker` ไม่ได้ (สภาพ sandbox) → `DOCKER_BUILDKIT=0 docker compose up -d --build` |
| `COPY docker/entrypoint.sh: not found` | build context ต้องเป็น root ของ repo — ใช้ `docker compose build` หรือ `docker build -f app/Dockerfile .` |
| เปิด `/` แล้ว 404 / การ์ดไม่อัปเดต | ดู log ตอน start ว่ามี `catalogue build failed` ไหม และ `gallery/site` ต้องเขียนได้ (ไม่ใช่ `:ro`) |
| คอนเทนเนอร์ restart วน `EACCES /srv/server.mjs` | ไฟล์ถูก COPY มาด้วยโหมด `600` → Dockerfile มี `chmod -R a+rX /srv` แล้ว; ถ้าแก้เองให้ `chmod 644 app/server.mjs` |
| เปิดกระดานแล้วว่าง | id ใน URL ไม่ตรงชื่อโฟลเดอร์ — ดูรายการจริงที่ `curl /api/boards` |
| แก้ในเบราว์เซอร์แล้วหาย | ดูแคปซูลสถานะมุมขวาว่าแดงไหม แล้ว `ls -lt gallery/scenes/*/scene.excalidraw`; ถ้าไฟล์ไม่ถูกเขียนดู `docker compose logs` |
| สองแท็บไม่เห็นของกัน | ต้องเป็นกระดาน id เดียวกัน และ avatar stack ต้องมี 2 คน — ถ้าไม่ขึ้นแปลว่า websocket ต่อไม่ติด (proxy ที่ปิด upgrade) |

---

## ข้อจำกัด

- ไม่มีระบบสิทธิ์/login — ใครเข้าถึงพอร์ตได้ก็แก้ได้ ควรวางไว้หลัง LAN, VPN หรือ reverse proxy ที่มี auth
- ไม่มี remote cursor เป็นหัวลูกศรตามคนอื่น (ตั้งใจปิดด้วย `renderCursor: false`) — เห็นกันเฉพาะเส้นเลเซอร์; เฟรม `{type:"pointer"}` ส่งเฉพาะตอนใช้ปากกาเลเซอร์ (จำกัด ~30 เฟรม/วินาที) ไม่ได้ส่งตลอดเวลา
- ถ้าสองคนแก้ **element เดียวกัน** พร้อมกัน ตัวที่มาหลังสุดชนะ
- ลบกระดานที่ยังมีคนเปิดอยู่: หน้าของเขาจะกดบันทึกแล้วได้ 404 (`บันทึกไม่สำเร็จ`) และไม่สร้างกระดานกลับมา — สร้างกระดานใหม่ได้จาก `+ กระดานใหม่` เท่านั้น
- ลิงก์แชร์แบบ Excalidraw+ (`#json=<id>,<key>`) ใช้ไม่ได้ — ลิงก์ของเราคือ `/b/<id>`
- บนมือถือซ่อนปุ่มเมนู `เครื่องมือเพิ่มเติม` ทั้งปุ่ม (แถวเครื่องมือมีที่จำกัด) — ใช้เครื่องมือวาดของ Excalidraw ตามปกติ
