import React from "react";
import { createRoot } from "react-dom/client";
import "./lib/monaco-setup.js";
import "./styles/theme.css";
import "./styles/scrollbar.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
