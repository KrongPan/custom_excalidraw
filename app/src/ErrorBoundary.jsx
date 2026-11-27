import { Component } from "react";

/* A throw inside the editor would unmount the whole tree and leave a blank
   page: keep the catalogue reachable and let the scene file be saved first. */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[editor]", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const id = this.props.boardId ? encodeURIComponent(this.props.boardId) : "";
    return (
      <div className="fatal" role="alert">
        <h1>เปิดกระดานนี้ไม่ได้</h1>
        <p>ตัวแก้ไขหยุดทำงานกะทันหัน ลองโหลดหน้านี้ใหม่ หรือดาวน์โหลดไฟล์กระดานไว้ก่อน</p>
        <div className="fatal-actions">
          <a className="btn" href="/">
            ← กลับไปแกลเลอรี
          </a>
          {id ? (
            <a className="btn" href={`/scenes/${id}.excalidraw`} download>
              ดาวน์โหลดไฟล์กระดาน
            </a>
          ) : null}
        </div>
      </div>
    );
  }
}
