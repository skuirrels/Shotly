import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { suppressBrowserMenu } from "@/lib/webview";
import { EditorApp } from "./EditorApp";

suppressBrowserMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>,
);
