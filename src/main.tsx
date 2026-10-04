import { renderMobileClientApp } from "@takosjp/mobile-kit/solid";
import { createYurumeetMobileApp } from "./mobile-app.tsx";
import { createProductNativeBridge } from "./native.ts";
import "./styles.css";

renderMobileClientApp(createYurumeetMobileApp(createProductNativeBridge));
