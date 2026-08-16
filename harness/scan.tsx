import { createRoot } from "react-dom/client";
import "./harness.css";
import { ScanResult } from "@/windows/editor/ScanResult";

/** Which payloads get a one-click Open, and which are copy-only. */
const scan = {
  codes: [
    { payload: "https://example.com/safe", symbology: "QR" },
    { payload: "http://example.com/plain", symbology: "QR" },
    { payload: "javascript:alert(1)", symbology: "QR" },
    { payload: "file:///etc/passwd", symbology: "QR" },
    { payload: "WIFI:S=Home;T=WPA;P=hunter2;;", symbology: "QR" },
    { payload: "SHOTLY-12345", symbology: "Code128" },
  ],
  lines: [
    { text: "A confident line", confidence: 0.99 },
    { text: "A doubtful one", confidence: 0.2 },
  ],
};

createRoot(document.getElementById("root")!).render(
  <ScanResult scan={scan} onCopy={() => {}} onClose={() => {}} />,
);
