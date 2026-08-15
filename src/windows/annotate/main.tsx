import React from "react";
import ReactDOM from "react-dom/client";
import "@/design/theme.css";
import { AnnotateApp } from "./AnnotateApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AnnotateApp />
  </React.StrictMode>,
);
