import { createRoot } from "react-dom/client";
import { App } from "./App";
import { connect } from "./rpc";
import { startSync } from "./store";
import "./styles.css";

startSync();
connect();
createRoot(document.getElementById("root")!).render(<App />);
