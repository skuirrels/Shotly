import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { suppressBrowserMenu } from "@/lib/webview";
import { ShelfApp } from "./ShelfApp";

suppressBrowserMenu();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShelfApp />
  </React.StrictMode>,
);
