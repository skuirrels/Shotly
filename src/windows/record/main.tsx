import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { suppressBrowserMenu } from "@/lib/webview";
import { RecordApp } from "./RecordApp";

suppressBrowserMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RecordApp />
  </React.StrictMode>,
);
