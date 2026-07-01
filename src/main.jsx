import "./polyfills.js"; // MUST be first — sets Buffer global before Solana loads

import React from "react";
import ReactDOM from "react-dom/client";
import Teleporter from "./Teleporter.jsx";

// BUILD MARKER — verify deployed build is current.
console.log("%c[Teleporter] BUILD mainnet-reverse-20260630o (X1→Sol burn LIVE)", "color:#3fd3e8;font-weight:bold");


ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Teleporter />
  </React.StrictMode>
);
