import "./polyfills.js"; // MUST be first — sets Buffer global before Solana loads

import React from "react";
import ReactDOM from "react-dom/client";
import Teleporter from "./Teleporter.jsx";

// BUILD MARKER — verify deployed build is current.
console.log("%c[Teleporter] BUILD " + (typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev") + " (X1↔Sol LIVE)", "color:#3fd3e8;font-weight:bold");


ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Teleporter />
  </React.StrictMode>
);
