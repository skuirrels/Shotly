import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { suppressBrowserMenu } from "@/lib/webview";
import { SnapApp } from "./SnapApp";

suppressBrowserMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SnapApp />
  </React.StrictMode>,
);
