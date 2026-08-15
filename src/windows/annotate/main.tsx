import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { suppressBrowserMenu } from "@/lib/webview";
import { AnnotateApp } from "./AnnotateApp";

suppressBrowserMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AnnotateApp />
  </React.StrictMode>,
);
