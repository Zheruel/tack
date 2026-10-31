import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./rpc";
import { startSync } from "./store";
import { startAppUpdates } from "./updates";
import { startDesktopSetup } from "./desktop-setup";
import "./styles.css";

startSync();
startDesktopSetup();
connect();
startAppUpdates();
createRoot(document.getElementById("root")!).render(<App />);
