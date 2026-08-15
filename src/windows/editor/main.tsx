import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { EditorApp } from "./EditorApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>,
);
