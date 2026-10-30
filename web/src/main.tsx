import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./rpc";
import { startSync } from "./store";
import { startAppUpdates } from "./updates";
import "./styles.css";

startSync();
connect();
startAppUpdates();
createRoot(document.getElementById("root")!).render(<App />);
